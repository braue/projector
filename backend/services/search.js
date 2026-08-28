// Free-text search within ONE settings source — "where does this string
// appear in this export/profile, and in what object". Runs over the same
// per-type adapter compare uses (entries carry the full inspect item).
//
// Matching is case-insensitive substring, over everything an engineer can
// see in Inspect: the object's name, settings keys and values, point rows,
// page tables, and logic source (with line numbers).

import { httpError } from '../lib/http.js';
import { itemSummary, rowText } from '../lib/inspect.js';

// Payload guards — a short string can match tens of thousands of points.
// MAX_TEXT is generous on purpose: a whole page row (Tag Processor rows run
// several hundred characters) must arrive COMPLETE, since the result pane is
// where the reader reads it. Only pathological values (a CDATA blob in one
// cell) clip, and those stay reachable by opening the hit in Browse.
const MAX_MATCHES_PER_ITEM = 50;
const MAX_ITEMS = 200;
const MAX_TEXT = 1200;

// Clip long values so the payload stays bounded — windowed around the first
// hit when a head clip would cut it off (the frontend re-finds the needle to
// highlight it, so the match must survive clipping).
function clip(value, needle) {
  const text = String(value);
  if (text.length <= MAX_TEXT) return text;
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1 || at + needle.length <= MAX_TEXT) return `${text.slice(0, MAX_TEXT)}…`;
  const start = Math.min(at - Math.floor(MAX_TEXT / 2), text.length - MAX_TEXT);
  const end = start + MAX_TEXT;
  return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// Scan one item. Counts every match but materializes detail (object + clip)
// only up to `limit` — callers past the item cap pass 0 and just count.
function matchItem(item, needle, limit) {
  const matches = [];
  let total = 0;
  const found = (where, location, text) => {
    total += 1;
    if (matches.length < limit) matches.push({ where, location, text: clip(text, needle) });
  };
  const hit = (value) => String(value ?? '').toLowerCase().includes(needle);

  if (hit(item.name)) found('name', 'object name', item.name);

  for (const [key, value] of Object.entries(item.settings ?? {})) {
    if (hit(key) || hit(value)) found('setting', key, `${key} = ${value}`);
  }

  for (const point of item.points ?? []) {
    for (const [column, value] of Object.entries(point.raw ?? {})) {
      if (hit(value) || hit(column)) {
        const rowName = point.tagName ? ` · ${point.tagName}` : '';
        found('point', `${point.page}${rowName} · ${column}`, value);
      }
    }
  }

  // One hit per matching page ROW, carrying the whole row — a Tag Processor
  // row referenced as "row N · column" alone is unreadable.
  for (const page of item.pages ?? []) {
    page.rows.forEach((row, index) => {
      if (!Object.values(row).some(hit)) return;
      found('page', `${page.name} · row ${index + 1}`, rowText(row));
    });
  }

  for (const part of ['interface', 'implementation']) {
    const source = item.code?.[part];
    if (!source) continue;
    source.split('\n').forEach((line, index) => {
      if (hit(line)) found('logic', `${part} · line ${index + 1}`, line.trim());
    });
  }

  return { matches, total };
}

class SearchService {
  // adapters: type -> async (ref) => { label, entries: [{ path, name, item }] }
  constructor({ adapters }) {
    this.adapters = adapters;
  }

  // `caps` shrink the payload for callers that fan out — the everywhere
  // search runs this over every source of every project and needs a taste of
  // each, not the full 200-object listing the single-source pane shows.
  async search({ type, ref }, query, caps = {}) {
    const { maxItems = MAX_ITEMS, maxMatchesPerItem = MAX_MATCHES_PER_ITEM } = caps;
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
      const budget = results.length < maxItems ? maxMatchesPerItem : 0;
      const { matches, total } = matchItem(entry.item, needle, budget);
      if (!total) continue;
      totalMatches += total;
      if (!budget) {
        truncated = true; // keep counting matches, stop carrying detail
        continue;
      }
      results.push({
        path: entry.path,
        name: entry.name,
        ...itemSummary(entry.item),
        matches,
        truncated: total > matches.length,
      });
    }

    return { query: q, label, results, totalMatches, truncated };
  }
}

export { SearchService };
