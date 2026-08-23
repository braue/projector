// Full-text search across the SEL PDF library.
//
// Reads an FTS5 index built by tools/build-sel-index.mjs — one row per page of
// every PDF — 124,202 pages of it for the current library. The app only ever READS this file: building
// needs poppler's pdftotext, which is not something a general user will have,
// so the index is built once by whoever curates the library and travels beside
// the PDFs. No index simply means this feature is off; everything else works.
//
// Page granularity is what makes the results usable. "The SEL-411L manual
// mentions this" is nearly worthless against a 1,698-page document; "page 412"
// is an answer.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { INDEX_FILENAME } from '../lib/selPaths.js';

/** Where the index lives, in order of preference. */
function candidates(libraryRoot, dataDir) {
  return [
    process.env.SEL_FULLTEXT,
    path.join(libraryRoot, INDEX_FILENAME),
    dataDir ? path.join(dataDir, INDEX_FILENAME) : null,
  ].filter(Boolean);
}

/**
 * FTS5's query language is a syntax, and users type prose. A stray quote or a
 * bare `AND` throws rather than returning nothing, so build the query rather
 * than passing it through: each word becomes a prefix term, all required, and
 * anything the tokenizer would choke on is dropped. Double-quoted runs survive
 * as phrases because that is a thing people reasonably expect to work.
 */
function toMatchQuery(raw) {
  const phrases = [];
  const rest = String(raw ?? '').replace(/"([^"]+)"/g, (_, inner) => {
    const cleaned = inner.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
    if (cleaned) phrases.push(`"${cleaned}"`);
    return ' ';
  });
  const words = rest
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    // A trailing * makes "reclos" find "reclosing" — closer to what people mean
    // than the exact-token match FTS5 does by default.
    .map((w) => `"${w}"*`);
  const terms = [...phrases, ...words];
  return terms.length ? terms.join(' AND ') : null;
}

/**
 * Stray C0 control bytes come out of some PDFs and travel all the way to the
 * snippet. Strip on read as well as on index, so an index built before this
 * was noticed still renders cleanly.
 */
function clean(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How many top-ranked pages to consider before grouping. Deep enough that the
 * short document types still have candidates left after the manuals have taken
 * the top of the list.
 */
const CANDIDATE_PAGES = 600;
/** Pages from any one document, and hits shown per document type. */
const DOC_LIMIT = 3;
const PER_GROUP = 8;

class SelFullText {
  #db = null;
  #file = null;
  #docs = 0;
  #pages = 0;
  #error = null;

  /** Open the index if one exists. Safe to call repeatedly. */
  open({ libraryRoot, dataDir }) {
    this.close();
    this.#error = null;
    const found = candidates(libraryRoot, dataDir).find((p) => existsSync(p));
    if (!found) return;
    try {
      const db = new DatabaseSync(found, { readOnly: true });
      const counts = db.prepare('SELECT COUNT(*) n, SUM(pages) p FROM docs').get();
      this.#db = db;
      this.#file = found;
      this.#docs = counts?.n ?? 0;
      this.#pages = counts?.p ?? 0;
    } catch (err) {
      // A truncated or half-written index should disable the feature, not take
      // the server down with it.
      this.#error = err?.message ?? String(err);
      this.#db = null;
    }
  }

  close() {
    try {
      this.#db?.close();
    } catch {
      /* already gone */
    }
    this.#db = null;
    this.#file = null;
    this.#docs = 0;
    this.#pages = 0;
  }

  status() {
    return {
      available: Boolean(this.#db),
      file: this.#file,
      documents: this.#docs,
      pages: this.#pages,
      sizeMb: this.#file && existsSync(this.#file)
        ? Math.round(statSync(this.#file).size / 1048576)
        : null,
      error: this.#error,
    };
  }

  /**
   * Page hits, grouped by document type.
   *
   * Grouping is not decoration. Instruction manuals are 91% of the indexed
   * pages (112,878 of 124,202) while being only 22% of the documents, so a
   * flat bm25 list is almost entirely manual — "reclosing" returned 28 manual
   * pages out of 30, and the application guide that actually explains
   * reclosing never appeared. Every type that matched now gets its own
   * section, so the library is represented rather than just its longest
   * documents.
   *
   * DOC_LIMIT caps pages from any ONE document, so a 1,698-page manual that
   * says "differential" on every other page cannot fill its own section.
   *
   * @param {string} query
   */
  search(query) {
    if (!this.#db) return { available: false, groups: [] };
    const match = toMatchQuery(query);
    if (!match) return { available: true, groups: [] };

    let rows;
    try {
      rows = this.#db
        .prepare(
          `SELECT p.path AS path, p.page AS page,
                  snippet(pages, 0, '', '', '…', 18) AS snippet,
                  bm25(pages) AS rank
             FROM pages p
            WHERE pages MATCH ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, CANDIDATE_PAGES);
    } catch (err) {
      return { available: true, groups: [], error: err?.message ?? String(err) };
    }

    const perDoc = new Map();
    const byFolder = new Map();
    for (const row of rows) {
      const seen = perDoc.get(row.path) ?? 0;
      if (seen >= DOC_LIMIT) continue;
      perDoc.set(row.path, seen + 1);
      const folder = row.path.split('/').slice(0, -1).join('/');
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      const bucket = byFolder.get(folder);
      if (bucket.length >= PER_GROUP) continue;
      bucket.push({
        path: row.path,
        name: path.basename(row.path),
        folder,
        page: Number(row.page),
        snippet: clean(row.snippet),
        rank: row.rank,
      });
    }

    // Whichever type matched best leads — for "ordering" that is Ordering
    // Information, for a setting name it is the manuals. Adapts per query
    // rather than pinning one type to the top forever.
    const groups = [...byFolder.entries()]
      .map(([folder, hits]) => ({ folder, label: folder || 'Other', hits }))
      .sort((a, b) => a.hits[0].rank - b.hits[0].rank);

    return { available: true, groups };
  }
}

export { SelFullText, clean, toMatchQuery };
