// Find-in-PDF for the preview pane's viewer.
//
// PDFs render in Chromium's own viewer, which the app embeds and cannot
// reach into: there is no find bar in the desktop build, and the fragment
// the viewer does honour (`#page=`) only moves it — it will not highlight a
// word. So the search happens out here, against the text PDFium reads out of
// the file, and the answer is PAGES: "your term is on 12, 41 and 44", each
// with the line it sits in. That is the useful answer anyway — a page number
// is something you can act on in a 600-page drawing set.
//
// Extraction is the expensive half (a 300-page document is roughly half a
// second), so a document's pages are cached by path + mtime + size and the
// cache is bounded both ways: too many documents, or too much text, and the
// oldest goes. A file that changes on disk misses the cache and is read
// again, which is exactly right for an entry someone just re-uploaded.

import { readFile, stat } from 'node:fs/promises';

import { pdfium } from '../lib/pdfium.js';

/** Cached documents, and the total text held across them. */
const MAX_DOCS = 4;
const MAX_CACHED_CHARS = 16_000_000;

/** Hits returned for one search; beyond this the term is too common to list. */
const MAX_MATCHES = 300;

/** Characters of context either side of a match. */
const CONTEXT = 48;

/** Least-recently-used first. */
const cache = new Map();
/** Extractions in flight, so two searches of one file read it once. */
const pending = new Map();

/** Whitespace-collapsed text: PDF text arrives full of line breaks, and a
 *  phrase that wrapped across a line is still the phrase that was typed. */
function flatten(text) {
  return String(text ?? '')
    // Stray C0 bytes come out of some PDFs and would travel to a snippet.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cachedChars() {
  let total = 0;
  for (const entry of cache.values()) total += entry.chars;
  return total;
}

function remember(key, pages) {
  const chars = pages.reduce((n, page) => n + page.length, 0);
  cache.set(key, { pages, chars });
  while (cache.size > MAX_DOCS || (cache.size > 1 && cachedChars() > MAX_CACHED_CHARS)) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** Every page's text, in page order, whitespace collapsed. */
async function extract(file) {
  const library = await pdfium();
  const document = await library.loadDocument(await readFile(file));
  try {
    const pages = [];
    for (const page of document.pages()) pages.push(flatten(page.getText()));
    return pages;
  } finally {
    document.destroy();
  }
}

/**
 * The pages of `file`, from cache when the file on disk is the one that was
 * read. Concurrent callers share one extraction.
 */
async function pagesOf(file) {
  const info = await stat(file);
  const key = `${file}|${info.mtimeMs}|${info.size}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency — a Map keeps insertion order, so re-inserting moves it.
    cache.delete(key);
    cache.set(key, hit);
    return hit.pages;
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const work = extract(file)
    .then((pages) => {
      remember(key, pages);
      return pages;
    })
    .finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

/** One match, split so the caller can highlight the term without re-finding
 *  it: the text before it on the line, the text as it appears, the text after. */
function snippet(text, at, length) {
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(text.length, at + length + CONTEXT);
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, at),
    match: text.slice(at, at + length),
    after: text.slice(at + length, to) + (to < text.length ? '…' : ''),
  };
}

/** Whether the document carries any text at all. A scanned drawing set is
 *  images of paper: nothing to search, which is a different answer from
 *  "your term is not in here" and worth saying out loud. */
function hasText(pages) {
  return pages.some((page) => page.length > 0);
}

/**
 * Every occurrence of `query` in the PDF at `file`, in page order.
 *
 * Returns `{ pages, hasText, matches, total, truncated }` — `pages` is the
 * document's page count (so the viewer knows what it is looking at even for
 * a query with no hits), `matches` carries a page number and a snippet each.
 */
async function searchPdf(file, query) {
  const needle = flatten(query).toLowerCase();
  const pages = await pagesOf(file);
  const text = hasText(pages);
  if (!needle) {
    return { pages: pages.length, hasText: text, matches: [], total: 0, truncated: false };
  }

  const matches = [];
  let total = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const text = pages[index];
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      total += 1;
      // Counting continues past the cap so the UI can say how many there are.
      if (matches.length < MAX_MATCHES) {
        matches.push({ page: index + 1, ...snippet(text, at, needle.length) });
      }
    }
  }
  return {
    pages: pages.length,
    hasText: text,
    matches,
    total,
    truncated: total > matches.length,
  };
}

/** Read a PDF's text without searching it — the viewer warms this when its
 *  find bar opens, so the first keystroke does not wait on extraction. */
async function warmPdf(file) {
  const pages = await pagesOf(file);
  return { pages: pages.length, hasText: hasText(pages), matches: [], total: 0, truncated: false };
}

export { searchPdf, warmPdf };
