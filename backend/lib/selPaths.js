// Where the SEL library and its full-text index live.
//
// One home for both names, because the index is written by
// tools/build-sel-index.mjs at the repo root, packaged into resources/ by
// electron-builder, and read by services/selFullText.js: if any of those
// disagree the tool writes an index the app never finds, and a missing index
// is silent by design — nothing would tell you.

/** The PDF library folder, unless SEL_LIBRARY says otherwise. */
const DEFAULT_SEL_ROOT = 'C:/SEL';

/** The index file — at the repo root when built, in resources/ when shipped. */
const INDEX_FILENAME = 'sel_fulltext.sqlite';

export { DEFAULT_SEL_ROOT, INDEX_FILENAME };
