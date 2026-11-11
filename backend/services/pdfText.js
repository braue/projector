// Find-in-PDF for the preview pane's viewer.
//
// PDFs render in Chromium's own viewer, which the app embeds and cannot
// reach into: there is no find bar in the desktop build, and the fragment
// the viewer does honour (`#page=`) only moves it — it will not highlight a
// word. So the search happens out here, against the document's text, and
// the answer is PAGES: "your term is on 12, 41 and 44", each with the line
// it sits in. That is the useful answer anyway — a page number is something
// you can act on in a 600-page drawing set.
//
// The pages come from the project's content index (services/contentIndex.js),
// which reads them once, caches them on disk, and fills scanned pages in by
// OCR — so find works on a scanned drawing set too, once it has been read.

import { readFile } from 'node:fs/promises';

import { pdfPages } from '../lib/extract/pdf.js';
import { flatten } from '../lib/extract/text.js';

/** Hits returned for one search; beyond this the term is too common to list. */
const MAX_MATCHES = 300;

/** Characters of context either side of a match. */
const CONTEXT = 48;

/** One match, split so the caller can highlight the term without re-finding
 *  it: the text before it on the line, the text as it appears, the text after. */
function snippet(text, at, length, context = CONTEXT) {
  const from = Math.max(0, at - context);
  const to = Math.min(text.length, at + length + context);
  return {
    before: (from > 0 ? '…' : '') + text.slice(from, at),
    match: text.slice(at, at + length),
    after: text.slice(at + length, to) + (to < text.length ? '…' : ''),
  };
}

/**
 * Every occurrence of `query` in `pages` (each page's whitespace-collapsed
 * text, in order).
 *
 * Returns `{ pages, hasText, matches, total, truncated }` — `pages` is the
 * document's page count (so the viewer knows what it is looking at even for
 * a query with no hits), `matches` carries a page number and a snippet each.
 * A document with no text at all (a scan not yet read) says so in `hasText`:
 * "nothing to search" is a different answer from "not in here".
 */
function searchPages(pages, query) {
  const needle = flatten(query).toLowerCase();
  const hasText = pages.some((page) => page.length > 0);
  const matches = [];
  let total = 0;
  if (needle) {
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
  }
  return { pages: pages.length, hasText, matches, total, truncated: total > matches.length };
}

/** A PDF file's text layer searched directly, with no index or OCR. */
async function searchPdf(file, query) {
  const { pages } = await pdfPages(await readFile(file));
  return searchPages(pages, query);
}

export { searchPages, searchPdf, snippet };
