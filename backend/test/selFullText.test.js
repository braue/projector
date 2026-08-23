import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SelFullText, toMatchQuery } from '../services/selFullText.js';

/** The smallest thing SelFullText will open: one doc, one indexed page. */
function writeIndex(file, body) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE docs (path TEXT PRIMARY KEY, name TEXT, folder TEXT,
                       size INTEGER, mtime INTEGER, pages INTEGER, indexed_at TEXT);
    CREATE VIRTUAL TABLE pages USING fts5(body, path UNINDEXED, page UNINDEXED);
  `);
  db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?)')
    .run('Manuals/x.pdf', 'x.pdf', 'Manuals', 1, 1, 1, 'now');
  db.prepare('INSERT INTO pages (body, path, page) VALUES (?,?,?)')
    .run(body, 'Manuals/x.pdf', 1);
  db.close();
}

// Users type prose into a box that speaks FTS5's query syntax. Everything here
// is a shape that used to throw, or that people reasonably expect to work.
test('builds a prefix AND query from ordinary words', () => {
  assert.equal(toMatchQuery('arc flash'), '"arc"* AND "flash"*');
});

test('keeps double-quoted runs as phrases', () => {
  assert.equal(toMatchQuery('"trip coil" monitor'), '"trip coil" AND "monitor"*');
});

test('drops punctuation FTS5 would choke on rather than erroring', () => {
  assert.equal(toMatchQuery('reclose (87L)'), '"reclose"* AND "87L"*');
  assert.equal(toMatchQuery('what? *'), '"what"*');
});

test('bare boolean words are treated as terms, not operators', () => {
  // "a AND OR b" is a syntax error in FTS5; here it is just words.
  assert.equal(toMatchQuery('OR'), '"OR"*');
});

test('keeps model numbers and dotted versions intact', () => {
  assert.equal(toMatchQuery('SEL-751A'), '"SEL-751A"*');
  assert.equal(toMatchQuery('R118-V0'), '"R118-V0"*');
});

test('single characters and empty input yield no query', () => {
  assert.equal(toMatchQuery('a'), null);
  assert.equal(toMatchQuery('   '), null);
  assert.equal(toMatchQuery(''), null);
  assert.equal(toMatchQuery(null), null);
});

// --- where the index is found -----------------------------------------------
//
// The installer ships an index beside the app so a fresh machine works out of
// the box. That copy is the floor, never an override: an index sitting beside
// the library was built from that library and may be newer.

test('an index beside the library wins over the one shipped with the app', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-sel-'));
  try {
    const library = path.join(tmp, 'library');
    await mkdir(library, { recursive: true });
    const beside = path.join(library, 'sel_fulltext.sqlite');
    const bundled = path.join(tmp, 'bundled.sqlite');
    writeIndex(beside, 'beside the library');
    writeIndex(bundled, 'shipped with the app');

    const full = new SelFullText();
    full.open({ libraryRoot: library, dataDir: null, bundled });
    assert.equal(full.status().file, beside);
    full.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the shipped index is used when nothing else is there', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-sel-'));
  try {
    const bundled = path.join(tmp, 'bundled.sqlite');
    writeIndex(bundled, 'shipped with the app');

    const full = new SelFullText();
    full.open({ libraryRoot: path.join(tmp, 'nothing-here'), dataDir: null, bundled });
    assert.equal(full.status().file, bundled);
    assert.equal(full.status().available, true);
    full.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('no index anywhere leaves the feature off rather than erroring', () => {
  const full = new SelFullText();
  full.open({ libraryRoot: path.join(os.tmpdir(), 'no-such-library'), dataDir: null, bundled: null });
  assert.equal(full.status().available, false);
  assert.equal(full.status().error, null);
  assert.deepEqual(full.search('anything'), { available: false, groups: [] });
});
