// Free-text search within ONE settings source — "where does this string
// appear in this export/profile, and in what object". Runs over the same
// per-type adapter compare uses (entries carry the full inspect item).
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
  constructor({ adapters }) {
    this.adapters = adapters;
  }

  async search({ type, ref }, query) {
    const q = String(query ?? '').trim();
    if (!q) throw httpError(400, 'a search string is required');
    const adapter = this.adapters[type];
    if (!adapter) throw httpError(400, `unknown source type: ${type}`);
    const needle = q.toLowerCase();

    const { label, entries } = await adapter(ref);

    const results = [];
    let totalMatches = 0;
    let truncated = false;
    for (const entry of entries) {
      const matches = matchItem(entry.item, needle, []);
      if (!matches.length) continue;
      totalMatches += matches.length;
      if (results.length >= MAX_ITEMS) {
        truncated = true;
        continue; // keep counting matches, stop carrying detail
      }
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

    return { query: q, label, results, totalMatches, truncated };
  }
}

export { SearchService };
