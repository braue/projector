// Where the SEL library and its full-text index live.
//
// One home for both, because the index is written by tools/build-sel-index.mjs
// and read by services/selFullText.js: if those two disagree the tool writes an
// index the app never finds, and a missing index is silent by design — nothing
// would tell you.

/** The library folder, unless SEL_LIBRARY says otherwise. */
const DEFAULT_SEL_ROOT = 'C:/SEL';

/** The index file, looked for beside the library and in the data directory. */
const INDEX_FILENAME = 'sel_fulltext.sqlite';

export { DEFAULT_SEL_ROOT, INDEX_FILENAME };
