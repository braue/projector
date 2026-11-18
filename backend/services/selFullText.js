// Full-text search across the SEL PDF library.
//
// Reads an FTS5 index built by tools/build-sel-index.mjs — one row per page of
// every PDF — 124,202 pages of it for the current library. The app only ever
// READS this file: building needs poppler's pdftotext, which is not something
// a general user will have, so the index is built once by whoever curates the
// library and ships inside the installer's resources/ directory. No index
// simply means this feature is off; everything else works.
//
// Page granularity is what makes the results usable. "The SEL-411L manual
// mentions this" is nearly worthless against a 1,698-page document; "page 412"
// is an answer.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
/** One document type on its own has the whole list to itself. */
const SCOPED_LIMIT = 60;
/**
 * A page whose document's title holds every query word. An application
 * guide's title names its topic; a manual's or data sheet's names a product,
 * which says less about any one page inside it.
 */
const TITLE_BOOST = { 'Application Guides': 1.8 };
const PRODUCT_TITLE_BOOST = 1.3;
const titleBoost = (folder) => TITLE_BOOST[folder] ?? PRODUCT_TITLE_BOOST;

/**
 * The query's words, lowercased and split the way page text is split for
 * proximity: "SEL-751A" is the two tokens "sel" and "751a", which must then
 * sit side by side.
 */
function queryTokens(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
}

function pageTokens(body) {
  return String(body ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * How tightly the query's words sit together on a page. bm25 scores each
 * word on its own, so a feature matrix with "switch" in one row, "fault" in
 * another and "onto" in a footnote ranks with the page that explains
 * switch-onto-fault. The phrase itself, in order, counts most; the words
 * within a few of each other count some. Words are prefixes, as in the
 * search itself.
 */
function proximityBoost(words, body) {
  if (words.length < 2) return 1;
  const tokens = pageTokens(body);
  const positions = words.map(() => []);
  for (let i = 0; i < tokens.length; i++) {
    for (let w = 0; w < words.length; w++) if (tokens[i].startsWith(words[w])) positions[w].push(i);
  }
  if (positions.some((p) => p.length === 0)) return 1;
  // The phrase: word w at i + w for every w.
  const later = positions.slice(1).map((p) => new Set(p));
  if (positions[0].some((i) => later.every((set, w) => set.has(i + w + 1)))) return 1.8;
  // The narrowest span holding every word, by walking all lists in order.
  const at = positions.map(() => 0);
  let best = Infinity;
  for (;;) {
    let lo = 0;
    let hi = 0;
    for (let w = 1; w < words.length; w++) {
      if (positions[w][at[w]] < positions[lo][at[lo]]) lo = w;
      if (positions[w][at[w]] > positions[hi][at[hi]]) hi = w;
    }
    best = Math.min(best, positions[hi][at[hi]] - positions[lo][at[lo]] + 1);
    if (++at[lo] >= positions[lo].length) break;
  }
  if (best <= words.length + 3) return 1.4;
  if (best <= words.length * 3 + 8) return 1.15;
  return 1;
}

/** Every query word starts some word of the title. */
function titleMatches(title, words) {
  if (!title || !words.length) return false;
  const tokens = pageTokens(title);
  return words.every((w) => tokens.some((t) => t.startsWith(w)));
}

/**
 * Types searched by file name instead of text. A model number appears in the
 * text of hundreds of manuals, so "3530" should find the 3530 manual and
 * nothing else.
 */
const NAME_FOLDERS = new Set(['Instruction Manuals']);

/**
 * How well a file name answers the query, lower is better, null for no match.
 * Every word must appear in the name. The model is the part before the first
 * underscore ("3530-4" in 3530-4_IM_20241217.pdf): an exact model beats a
 * variant of it (3530-4, 351R), then a longer model number, then the word
 * anywhere in the name.
 */
function nameRank(name, words) {
  const lower = name.toLowerCase();
  if (!words.every((w) => lower.includes(w))) return null;
  const model = lower.split('_')[0];
  const first = words[0];
  if (model === first) return 0;
  // "351" → 351R and 351-5 are variants; "35" → 3530 is a different model.
  if (model.startsWith(first)) return /\d/.test(model[first.length]) ? 2 : 1;
  return 3;
}

/** The query as lowercase name words, without a leading "SEL-". */
function nameWords(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\bsel-?(?=\w)/g, '')
    .split(/[\s_]+/)
    .filter(Boolean);
}

class SelFullText {
  #db = null;
  #file = null;
  #docs = 0;
  #pages = 0;
  #folders = [];
  /** path → { title, intro, folder, pages }, for indexes built with titles. */
  #docMeta = new Map();
  #prose = null;
  #error = null;

  /**
   * Open the index at `file` if it exists. There is exactly one place it
   * lives — resources/ in the packaged app, the repo root when running from
   * source — so this takes a path, not a search. Safe to call repeatedly.
   */
  open(file) {
    this.close();
    this.#error = null;
    if (!file || !existsSync(file)) return;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const counts = db.prepare('SELECT COUNT(*) n, SUM(pages) p FROM docs').get();
      this.#db = db;
      this.#file = file;
      this.#docs = counts?.n ?? 0;
      this.#pages = counts?.p ?? 0;
      this.#folders = db
        .prepare('SELECT folder, COUNT(*) documents, SUM(pages) pages FROM docs GROUP BY folder ORDER BY folder')
        .all()
        .map((r) => ({
          folder: r.folder,
          documents: Number(r.documents),
          pages: Number(r.pages),
          byName: NAME_FOLDERS.has(r.folder),
        }));
      // Titles and page scores arrived after the first shipped index; an
      // index without them still searches, ranked on its words alone.
      const cols = new Set(db.prepare('PRAGMA table_info(docs)').all().map((c) => c.name));
      const withTitles = cols.has('title') && cols.has('intro');
      for (const r of db.prepare(`SELECT path, folder, pages${withTitles ? ', title, intro' : ''} FROM docs`).all()) {
        this.#docMeta.set(r.path, {
          folder: r.folder,
          pages: Number(r.pages),
          title: r.title ?? null,
          intro: r.intro ?? '',
        });
      }
      const hasProse = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'page_meta'").get();
      this.#prose = hasProse ? db.prepare('SELECT prose FROM page_meta WHERE path = ? AND page = ?') : null;
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
    this.#folders = [];
    this.#docMeta = new Map();
    this.#prose = null;
  }

  status() {
    return {
      available: Boolean(this.#db),
      file: this.#file,
      documents: this.#docs,
      pages: this.#pages,
      // The document types, for searching one at a time.
      folders: this.#folders,
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
   * `folder` narrows the search to one document type. The grouping problem
   * above is then moot, so that type gets SCOPED_LIMIT hits instead of
   * PER_GROUP.
   *
   * @param {string} query
   * @param {{ folder?: string | null }} [options]
   */
  search(query, { folder = null } = {}) {
    if (!this.#db) return { available: false, groups: [] };
    if (NAME_FOLDERS.has(folder)) return this.#searchNames(query, folder);
    const match = toMatchQuery(query);
    if (!match) return { available: true, groups: [] };

    const scoped = typeof folder === 'string' && folder !== '';
    let rows;
    try {
      rows = this.#db
        .prepare(
          `SELECT p.path AS path, p.page AS page, p.body AS body,
                  snippet(pages, 0, '', '', '…', 18) AS snippet,
                  bm25(pages) AS rank
             FROM pages p
            WHERE pages MATCH ?
              ${scoped ? 'AND substr(p.path, 1, length(?) + 1) = ? || \'/\'' : ''}
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, ...(scoped ? [folder, folder] : []), CANDIDATE_PAGES);
    } catch (err) {
      return { available: true, groups: [], error: err?.message ?? String(err) };
    }

    // bm25 picks the candidates; the order among them is bm25 (negated, so
    // higher is better) scaled by three things it cannot see: whether the
    // page explains or merely lists, whether the words sit together, and
    // whether the document is ABOUT this, going by its title.
    const words = queryTokens(query);
    const scored = rows.map((row) => {
      const page = Number(row.page);
      const meta = this.#docMeta.get(row.path);
      const prose = this.#prose?.get(row.path, page)?.prose;
      const quality = prose === undefined ? 1 : 0.35 + 0.65 * Number(prose);
      const title = titleMatches(meta?.title, words) ? titleBoost(meta.folder) : 1;
      return {
        path: row.path,
        page,
        snippet: clean(row.snippet),
        score: -row.rank * quality * proximityBoost(words, row.body) * title,
      };
    });

    // A document whose title answers the query is worth showing even when
    // none of its pages made the candidate cut — the manuals' sheer page
    // count crowds a short guide out of the top of a bm25 list. It comes in
    // at its cover, scored as a strong page of a matching title would be.
    const seen = new Set(scored.map((h) => h.path));
    const strong = scored.length ? Math.max(...scored.map((h) => h.score)) * 0.6 : 1;
    for (const [docPath, meta] of this.#docMeta) {
      if (seen.has(docPath) || !titleMatches(meta.title, words)) continue;
      if (scoped && meta.folder !== folder) continue;
      scored.push({ path: docPath, page: 1, snippet: clean(meta.intro), score: strong * titleBoost(meta.folder) });
    }
    scored.sort((x, y) => y.score - x.score);

    const perDoc = new Map();
    const byFolder = new Map();
    for (const row of scored) {
      const seen = perDoc.get(row.path) ?? 0;
      if (seen >= DOC_LIMIT) continue;
      perDoc.set(row.path, seen + 1);
      const folder = row.path.split('/').slice(0, -1).join('/');
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      const bucket = byFolder.get(folder);
      if (bucket.length >= (scoped ? SCOPED_LIMIT : PER_GROUP)) continue;
      bucket.push({
        path: row.path,
        name: path.basename(row.path),
        title: this.#docMeta.get(row.path)?.title ?? null,
        folder,
        page: row.page,
        snippet: row.snippet,
        rank: -row.score,
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

  /** Documents of one type whose file name matches, best first. */
  #searchNames(query, folder) {
    const words = nameWords(query);
    if (!words.length) return { available: true, byName: true, groups: [] };
    const hits = this.#db
      .prepare('SELECT path, name, pages FROM docs WHERE folder = ?')
      .all(folder)
      .map((row) => {
        // The name decides; a title holding every word ("rtac") is a weaker
        // match below every name match.
        const title = this.#docMeta.get(row.path)?.title;
        const byTitle = title && words.every((w) => title.toLowerCase().includes(w)) ? 4 : null;
        return { row, rank: nameRank(row.name, words) ?? byTitle };
      })
      .filter((h) => h.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name, undefined, { numeric: true }))
      .slice(0, SCOPED_LIMIT)
      .map(({ row, rank }) => ({
        path: row.path,
        name: row.name,
        title: this.#docMeta.get(row.path)?.title ?? null,
        folder,
        page: null,
        pages: Number(row.pages),
        snippet: '',
        rank,
      }));
    return { available: true, byName: true, groups: hits.length ? [{ folder, label: folder, hits }] : [] };
  }
}

export { SelFullText, clean, nameRank, nameWords, proximityBoost, toMatchQuery };
