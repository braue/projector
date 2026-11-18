// Build the full-text index for the SEL PDF library.
//
//   node tools/build-sel-index.mjs [--library C:/SEL] [--out <file>] [--jobs N]
//
// Extracts every PDF to text with poppler's pdftotext, one row per page, into
// an SQLite FTS5 database that the app opens read-only. Page granularity is
// the point: "which manual mentions this" is much less useful than "page 412
// of the SEL-411L manual", and it keeps each indexed row small enough for a
// meaningful snippet.
//
// The index is built ONCE, by whoever curates the library, at the repo root —
// where electron-builder's extraResources picks it up — so it ships inside the
// installer and no user ever needs poppler installed. Re-run after adding
// PDFs; unchanged files are skipped, so a top-up costs only the new ones.
//
// Every run ends by deriving each document's title and each page's prose
// score from the indexed text (backend/lib/selDerive.js). That needs neither
// the PDFs nor poppler, so `--derive` alone refreshes them on an existing
// index after the derivation rules change.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_SEL_ROOT, INDEX_FILENAME } from '../backend/lib/selPaths.js';
// The same strip the reader applies, so an index and the snippets drawn from
// it can never disagree about what a page says.
import { clean } from '../backend/services/selFullText.js';
import { docTitle, proseScore } from '../backend/lib/selDerive.js';

const run = promisify(execFile);

const RENAMED_COPY = /_RENAMED_\d+_\d+_\d+/i;
/** pdftotext separates pages with a form feed; that is our page boundary. */
const PAGE_BREAK = '\f';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** The repo root, where the index lands so extraResources can package it. */
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const LIBRARY = path.resolve(arg('library', process.env.SEL_LIBRARY ?? DEFAULT_SEL_ROOT));
const OUT = path.resolve(arg('out', path.join(ROOT, INDEX_FILENAME)));
const JOBS = Number(arg('jobs', Math.max(2, availableParallelism() - 2)));
const LIMIT = Number(arg('limit', 0)); // 0 = everything; for smoke tests
const DERIVE_ONLY = process.argv.includes('--derive');

/** poppler is not on PATH by default on Windows; find the winget install. */
function findPdfToText() {
  if (process.env.PDFTOTEXT) return process.env.PDFTOTEXT;
  const packages = path.join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft',
    'WinGet',
    'Packages',
  );
  const stack = existsSync(packages) ? [packages] : [];
  let depth = 0;
  while (stack.length && depth < 4000) {
    depth++;
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === 'pdftotext.exe') return full;
    }
  }
  return 'pdftotext'; // assume PATH; the first call will say otherwise
}

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase().endsWith('.pdf') && !RENAMED_COPY.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function openDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path   TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      folder TEXT NOT NULL,
      size   INTEGER NOT NULL,
      mtime  INTEGER NOT NULL,
      pages  INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    );
    -- One row per page. 'path' and 'page' are UNINDEXED: they are payload for
    -- the result list, not things anyone searches for.
    CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
      body,
      path UNINDEXED,
      page UNINDEXED,
      tokenize = "unicode61 remove_diacritics 2"
    );
    -- 0 (table, list, settings dump) to 1 (running prose), per page.
    CREATE TABLE IF NOT EXISTS page_meta (
      path  TEXT NOT NULL,
      page  INTEGER NOT NULL,
      prose REAL NOT NULL,
      PRIMARY KEY (path, page)
    ) WITHOUT ROWID;
  `);
  // Added after the first shipped index; older files gain them in place.
  const cols = new Set(db.prepare('PRAGMA table_info(docs)').all().map((c) => c.name));
  if (!cols.has('title')) db.exec('ALTER TABLE docs ADD COLUMN title TEXT');
  if (!cols.has('intro')) db.exec('ALTER TABLE docs ADD COLUMN intro TEXT');
  return db;
}

async function extract(pdftotext, pdf) {
  // -q: no warnings on the malformed PDFs the library inevitably contains.
  // No -layout: column reconstruction is slower and only helps human reading.
  // '-' is the output file: straight to stdout, so nothing touches the disk.
  const { stdout } = await run(pdftotext, ['-q', '-enc', 'UTF-8', pdf, '-'], {
    maxBuffer: 512 * 1024 * 1024, // the longest manual is ~1,700 pages of text
    timeout: 5 * 60 * 1000,
    windowsHide: true,
  });
  return stdout;
}

/**
 * Titles and prose scores for the whole index, in one pass over its stored
 * text. A full pass rather than only the re-indexed documents: page rows are
 * not indexed by path, so finding one document's pages is itself a full scan.
 */
function derive(db) {
  const started = Date.now();
  const folders = new Map(db.prepare('SELECT path, folder FROM docs').all().map((r) => [r.path, r.folder]));
  const first = new Map();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM page_meta');
    const insertMeta = db.prepare('INSERT OR REPLACE INTO page_meta (path, page, prose) VALUES (?,?,?)');
    for (const row of db.prepare('SELECT c0 AS body, c1 AS path, c2 AS page FROM pages_content').iterate()) {
      const page = Number(row.page);
      insertMeta.run(row.path, page, proseScore(row.body));
      const seen = first.get(row.path);
      if (!seen || page < seen.page) first.set(row.path, { page, body: row.body });
    }
    const setTitle = db.prepare('UPDATE docs SET title = ?, intro = ? WHERE path = ?');
    let titled = 0;
    for (const [docPath, folder] of folders) {
      const body = first.get(docPath)?.body ?? '';
      const title = docTitle(folder, body);
      if (title) titled++;
      // The cover's opening after the title, for a document found by its
      // title alone — the result already shows the title.
      const at = title ? body.indexOf(title.replace(/…$/, '')) : -1;
      const intro = at === -1 ? body.slice(0, 240) : `…${body.slice(at + title.length, at + title.length + 240).trim()}`;
      setTitle.run(title, intro, docPath);
    }
    db.exec('COMMIT');
    console.log(`derived  ${titled}/${folders.size} titles, ${first.size} documents' page scores ` +
      `in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

async function main() {
  if (DERIVE_ONLY) {
    if (!existsSync(OUT)) {
      console.error(`No index at ${OUT}`);
      process.exit(1);
    }
    const db = openDb(OUT);
    derive(db);
    summarise(db);
    finalise(db);
    return;
  }
  if (!existsSync(LIBRARY)) {
    console.error(`No library at ${LIBRARY}`);
    process.exit(1);
  }
  const pdftotext = findPdfToText();
  console.log(`library   ${LIBRARY}`);
  console.log(`index     ${OUT}`);
  console.log(`pdftotext ${pdftotext}`);
  console.log(`jobs      ${JOBS}`);

  const db = openDb(OUT);
  const known = new Map(
    db.prepare('SELECT path, size, mtime FROM docs').all().map((r) => [r.path, r]),
  );

  let files = walk(LIBRARY).sort();
  if (LIMIT) files = files.slice(0, LIMIT);

  const todo = [];
  for (const full of files) {
    const rel = path.relative(LIBRARY, full).split(path.sep).join('/');
    const info = statSync(full);
    const prior = known.get(rel);
    // Unchanged since last run: leave it alone. Makes a top-up cheap.
    if (prior && prior.size === info.size && prior.mtime === Math.floor(info.mtimeMs)) continue;
    todo.push({ full, rel, size: info.size, mtime: Math.floor(info.mtimeMs) });
  }

  console.log(`${files.length} PDFs, ${todo.length} to (re)index\n`);
  if (todo.length === 0) {
    derive(db);
    summarise(db);
    finalise(db);
    return;
  }

  const insertDoc = db.prepare(
    'INSERT OR REPLACE INTO docs (path, name, folder, size, mtime, pages, indexed_at) VALUES (?,?,?,?,?,?,?)',
  );
  const deletePages = db.prepare('DELETE FROM pages WHERE path = ?');
  const insertPage = db.prepare('INSERT INTO pages (body, path, page) VALUES (?,?,?)');

  const started = Date.now();
  let done = 0;
  let pagesTotal = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < todo.length) {
      const job = todo[cursor++];
      let text;
      try {
        text = await extract(pdftotext, job.full);
      } catch (err) {
        failed++;
        console.log(`  ! ${job.rel}: ${String(err.message ?? err).split('\n')[0]}`);
        continue;
      }
      const pages = text.split(PAGE_BREAK);
      db.exec('BEGIN');
      try {
        deletePages.run(job.rel);
        let kept = 0;
        for (let i = 0; i < pages.length; i++) {
          // Some PDFs extract with stray C0 control bytes (odd encodings,
          // ligature tables). They are invisible, they survive JSON, and they
          // show up as garbage in snippets — drop them at the source.
          const body = clean(pages[i]);
          if (body.length < 12) continue; // blank or near-blank page
          insertPage.run(body, job.rel, i + 1);
          kept++;
        }
        insertDoc.run(
          job.rel,
          path.basename(job.rel),
          job.rel.split('/').slice(0, -1).join('/'),
          job.size,
          job.mtime,
          kept,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
        pagesTotal += kept;
      } catch (err) {
        db.exec('ROLLBACK');
        failed++;
        console.log(`  ! ${job.rel}: ${err.message}`);
      }
      done++;
      if (done % 25 === 0 || done === todo.length) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = done / elapsed;
        const left = (todo.length - done) / rate;
        process.stdout.write(
          `\r  ${done}/${todo.length} docs  ${pagesTotal} pages  ` +
            `${rate.toFixed(1)}/s  ~${Math.round(left)}s left    `,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: JOBS }, worker));
  process.stdout.write('\n\n');

  console.log('optimising…');
  db.exec("INSERT INTO pages(pages) VALUES('optimize')");
  derive(db);
  summarise(db, failed, (Date.now() - started) / 1000);
  finalise(db);
}

/**
 * Leave the file self-contained before closing. The build runs in WAL mode for
 * speed, but the shipped copy is opened read-only from a directory the app may
 * not be able to write to, where a WAL-stamped header is fatal — and a WAL
 * left behind means the single file electron-builder copies is missing the
 * most recent pages. Switching to DELETE mode does both: it checkpoints and
 * removes the -wal, and it fails while another connection holds the database,
 * so a build that could not produce a complete single file says so instead of
 * shipping a stale one.
 */
function finalise(db) {
  let mode;
  try {
    mode = db.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode;
  } finally {
    db.close();
  }
  if (String(mode).toLowerCase() !== 'delete') {
    console.error(
      `Could not leave ${OUT} self-contained (journal_mode is '${mode}', wanted 'delete').\n` +
        'Something else has the index open — close Projector and re-run.',
    );
    process.exit(1);
  }
}

function summarise(db, failed = 0, seconds = null) {
  const docs = db.prepare('SELECT COUNT(*) n, SUM(pages) p FROM docs').get();
  const size = existsSync(OUT) ? statSync(OUT).size : 0;
  console.log(`\nindexed ${docs.n} documents, ${docs.p ?? 0} pages`);
  console.log(`index    ${(size / 1024 / 1024).toFixed(0)} MB at ${OUT}`);
  if (failed) console.log(`failed   ${failed}`);
  if (seconds !== null) console.log(`took     ${Math.round(seconds)}s`);
}

await main();
