import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// --- opening the index --------------------------------------------------------
//
// There is exactly one index: the file the installer put in resources/, or the
// repo-root copy when running from source. open() takes that path; a missing
// or broken file turns the feature off and nothing else.

test('opens the shipped index', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-sel-'));
  try {
    const shipped = path.join(tmp, 'sel_fulltext.sqlite');
    writeIndex(shipped, 'shipped with the app');

    const full = new SelFullText();
    full.open(shipped);
    assert.equal(full.status().file, shipped);
    assert.equal(full.status().available, true);
    full.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a missing index leaves the feature off rather than erroring', () => {
  const full = new SelFullText();
  full.open(path.join(os.tmpdir(), 'no-such-dir', 'sel_fulltext.sqlite'));
  assert.equal(full.status().available, false);
  assert.equal(full.status().error, null);
  assert.deepEqual(full.search('anything'), { available: false, groups: [] });
});

// --- resolving a model's instruction manual -----------------------------------
//
// manualFor reads the document list, not the page text: a manual mentions
// every model it interoperates with, but its filename names exactly one.
// Matching is whole-token, so near-miss models (751 vs 751A) never claim each
// other's manuals, and only instruction-manual folders are considered.

function writeManualsIndex(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE docs (path TEXT PRIMARY KEY, name TEXT, folder TEXT,
                       size INTEGER, mtime INTEGER, pages INTEGER, indexed_at TEXT);
    CREATE VIRTUAL TABLE pages USING fts5(body, path UNINDEXED, page UNINDEXED);
  `);
  const insert = db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?)');
  const doc = (name, folder, mtime) =>
    insert.run(`${folder}/${name}`, name, folder, 1, mtime, 900, 'now');
  doc('SEL-751A Instruction Manual 20200101.pdf', 'Instruction Manuals', 100);
  doc('SEL-751A Instruction Manual 20240101.pdf', 'Instruction Manuals', 200);
  doc('SEL-751 Instruction Manual.pdf', 'Instruction Manuals', 300);
  doc('SEL-751A Data Sheet.pdf', 'Data Sheets', 400);
  db.close();
}

test('manualFor: whole-token model match, newest edition, manuals only', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-sel-'));
  try {
    const file = path.join(tmp, 'sel_fulltext.sqlite');
    writeManualsIndex(file);
    const full = new SelFullText();
    full.open(file);

    // Newest edition wins; the data sheet never competes despite its name.
    assert.equal(
      full.manualFor('SEL-751A')?.name,
      'SEL-751A Instruction Manual 20240101.pdf',
    );
    // The SEL- prefix is the caller's spelling, not part of the match.
    assert.equal(full.manualFor('751A')?.name, 'SEL-751A Instruction Manual 20240101.pdf');
    // 751 is not a token inside 751A, in either direction.
    assert.equal(full.manualFor('SEL-751')?.name, 'SEL-751 Instruction Manual.pdf');
    assert.equal(full.manualFor('SEL-411L'), null);
    assert.equal(full.manualFor(''), null);
    full.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('manualFor without an index is null, not an error', () => {
  assert.equal(new SelFullText().manualFor('SEL-751A'), null);
});

test('a broken index reports its error and leaves the feature off', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-sel-'));
  try {
    const broken = path.join(tmp, 'sel_fulltext.sqlite');
    await writeFile(broken, 'this is not an SQLite database');

    const full = new SelFullText();
    full.open(broken);
    assert.equal(full.status().available, false);
    assert.notEqual(full.status().error, null);
    assert.deepEqual(full.search('anything'), { available: false, groups: [] });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
