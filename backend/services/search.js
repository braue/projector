// Free-text search over the WHOLE project — "where does this string appear,
// in what object, in which source". Sweeps every source at once (each RTAC
// export, every uploaded RDB/SCD/SW profile) via the same per-type adapters
// compare uses (entries carry the full inspect item).
//
// Matching is case-insensitive substring, over everything an engineer can
// see in Inspect: the object's name, settings keys and values, point rows,
// page tables, and logic source (with line numbers).

import { httpError } from '../lib/http.js';

// Payload guards — a short string can match tens of thousands of points.
const MAX_MATCHES_PER_ITEM = 50;
const MAX_ITEMS = 200;
const MAX_TEXT = 220;

function clip(value) {
  const text = String(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function matchItem(item, needle, out) {
  const hit = (value) => String(value ?? '').toLowerCase().includes(needle);

  if (hit(item.name)) out.push({ where: 'name', location: 'object name', text: clip(item.name) });

  for (const [key, value] of Object.entries(item.settings ?? {})) {
    if (hit(key) || hit(value)) {
      out.push({ where: 'setting', location: key, text: clip(`${key} = ${value}`) });
    }
  }

  for (const point of item.points ?? []) {
    for (const [column, value] of Object.entries(point.raw ?? {})) {
      if (hit(value) || hit(column)) {
        const rowName = point.tagName ? ` · ${point.tagName}` : '';
        out.push({
          where: 'point',
          location: `${point.page}${rowName} · ${column}`,
          text: clip(value),
        });
      }
    }
  }

  for (const page of item.pages ?? []) {
    page.rows.forEach((row, index) => {
      for (const [column, value] of Object.entries(row)) {
        if (hit(value)) {
          out.push({
            where: 'page',
            location: `${page.name} · row ${index + 1} · ${column}`,
            text: clip(value),
          });
        }
      }
    });
  }

  for (const part of ['interface', 'implementation']) {
    const source = item.code?.[part];
    if (!source) continue;
    source.split('\n').forEach((line, index) => {
      if (hit(line)) {
        out.push({ where: 'logic', location: `${part} · line ${index + 1}`, text: clip(line.trim()) });
      }
    });
  }

  return out;
}

class SearchService {
  // adapters: type -> async (ref) => { label, entries: [{ path, name, item }] }
  // sources:  async () => [{ type, ref }] — every searchable source in the
  //           project right now, supplied by the bundle.
  constructor({ adapters, sources }) {
    this.adapters = adapters;
    this.sources = sources;
  }

  async search(query) {
    const q = String(query ?? '').trim();
    if (!q) throw httpError(400, 'a search string is required');
    const needle = q.toLowerCase();

    const sources = [];
    let totalMatches = 0;
    let carried = 0;
    let truncated = false;

    for (const source of await this.sources()) {
      const adapter = this.adapters[source.type];
      if (!adapter) continue;
      // A source that fails to load (mid-export, vanished) skips rather than
      // failing the whole sweep.
      let loaded;
      try {
        loaded = await adapter(source.ref);
      } catch {
        continue;
      }

      const results = [];
      for (const entry of loaded.entries) {
        const matches = matchItem(entry.item, needle, []);
        if (!matches.length) continue;
        totalMatches += matches.length;
        if (carried >= MAX_ITEMS) {
          truncated = true;
          continue; // keep counting matches, stop carrying detail
        }
        carried += 1;
        results.push({
          path: entry.path,
          name: entry.name,
          kindLabel: entry.item.kindLabel,
          category: entry.item.category,
          protocol: entry.item.protocol ?? null,
          matches: matches.slice(0, MAX_MATCHES_PER_ITEM),
          truncated: matches.length > MAX_MATCHES_PER_ITEM,
        });
      }
      if (results.length) {
        sources.push({ type: source.type, ref: source.ref, label: loaded.label, results });
      }
    }

    return { query: q, sources, totalMatches, truncated };
  }
}

export { SearchService };
