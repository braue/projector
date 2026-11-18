import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { SelFullText, nameRank, nameWords, proximityBoost, toMatchQuery } from '../services/selFullText.js';

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

// --- one document type at a time ---------------------------------------------

test('folder scope searches one document type and lists the types', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'selft-'));
  try {
    const file = path.join(dir, 'idx.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE docs (path TEXT PRIMARY KEY, name TEXT, folder TEXT,
                         size INTEGER, mtime INTEGER, pages INTEGER, indexed_at TEXT);
      CREATE VIRTUAL TABLE pages USING fts5(body, path UNINDEXED, page UNINDEXED);
    `);
    for (const [folder, name] of [['Manuals', 'm.pdf'], ['Guides', 'g.pdf'], ['Guides X', 'x.pdf']]) {
      db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?)')
        .run(`${folder}/${name}`, name, folder, 1, 1, 1, 'now');
      db.prepare('INSERT INTO pages (body, path, page) VALUES (?,?,?)')
        .run('reclosing sequence', `${folder}/${name}`, 1);
    }
    db.close();

    const ft = new SelFullText();
    ft.open(file);
    assert.deepEqual(ft.status().folders.map((f) => f.folder), ['Guides', 'Guides X', 'Manuals']);
    assert.equal(ft.search('reclosing').groups.length, 3);
    // "Guides" must not also catch "Guides X/".
    const scoped = ft.search('reclosing', { folder: 'Guides' });
    assert.deepEqual(scoped.groups.map((g) => g.folder), ['Guides']);
    assert.equal(scoped.groups[0].hits.length, 1);
    ft.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- manuals by file name ----------------------------------------------------

test('name rank: exact model, then variants, then longer models, then anywhere', () => {
  const w = nameWords('SEL-351');
  assert.deepEqual(w, ['351']);
  assert.equal(nameRank('351_IM_2020.pdf', w), 0);
  assert.equal(nameRank('351R-4_IM_2020.pdf', w), 1);
  assert.equal(nameRank('351-5-6-7_IM_2020.pdf', w), 1);
  assert.equal(nameRank('3510_IM_2020.pdf', w), 2);
  assert.equal(nameRank('2351_IM_2020.pdf', w), 3);
  assert.equal(nameRank('751_IM_2020.pdf', w), null);
  assert.equal(nameRank('451_UG_2019.pdf', nameWords('451 ug')), 0);
  assert.equal(nameRank('451_RM_2019.pdf', nameWords('451 ug')), null);
});

test('instruction manuals search by file name, not page text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'selft-'));
  try {
    const file = path.join(dir, 'idx.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE docs (path TEXT PRIMARY KEY, name TEXT, folder TEXT,
                         size INTEGER, mtime INTEGER, pages INTEGER, indexed_at TEXT);
      CREATE VIRTUAL TABLE pages USING fts5(body, path UNINDEXED, page UNINDEXED);
    `);
    for (const name of ['3530_IM.pdf', '3530-4_IM.pdf', '751_IM.pdf']) {
      const p = `Instruction Manuals/${name}`;
      db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?)').run(p, name, 'Instruction Manuals', 1, 1, 9, 'now');
      // Every manual mentions 3530 in its text; only the names should count.
      db.prepare('INSERT INTO pages (body, path, page) VALUES (?,?,?)').run('connect to the SEL-3530 RTAC', p, 1);
    }
    db.close();

    const ft = new SelFullText();
    ft.open(file);
    assert.equal(ft.status().folders[0].byName, true);
    const r = ft.search('3530', { folder: 'Instruction Manuals' });
    assert.equal(r.byName, true);
    assert.deepEqual(r.groups[0].hits.map((h) => h.name), ['3530_IM.pdf', '3530-4_IM.pdf']);
    assert.equal(r.groups[0].hits[0].page, null);
    assert.equal(r.groups[0].hits[0].pages, 9);
    // The All scope still searches the text.
    assert.equal(ft.search('3530').groups[0].hits.length, 3);
    ft.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- titles and page quality -------------------------------------------------

test('titles come from each document type’s cover', async () => {
  const { docTitle } = await import('../lib/selDerive.js');
  assert.equal(
    docTitle('Application Guides', 'Application Guide Volume III AG2019-07 Single-Phase Select for Manually Tripping and Closing the SEL-651R David Bisel, Tom Nichols, and Brad Heilman INTRODUCTION The SEL-651R'),
    'Single-Phase Select for Manually Tripping and Closing the SEL-651R',
  );
  // No heading: the authors run into the first sentence.
  assert.equal(
    docTitle('Application Guides', 'Application Guide Volume II AG2002-14 SEL-421 Relay Fast Messages Darold Woodward The SEL-421 Relay uses'),
    'SEL-421 Relay Fast Messages',
  );
  // Title words that look like a name are not mistaken for the authors.
  assert.equal(
    docTitle('Application Guides', 'Application Guide Volume VII AG2014-42 Using SSH to Collect Relay Event Reports With ACSELERATOR TEAM® Jeffrey P. Reilly INTRODUCTION A widespread'),
    'Using SSH to Collect Relay Event Reports With ACSELERATOR TEAM',
  );
  assert.equal(
    docTitle('Instruction Manuals', 'Instruction Manual SEL-451-6 Relay SEL-451-6 Protection, Automation, and Bay Control System Instruction Manual 20260217 *PM451-06-NB*'),
    'SEL-451-6 Protection, Automation, and Bay Control System',
  );
  assert.equal(
    docTitle('Data Sheets', 'SEL-2725 Unmanaged Ethernet Switch Major Features and Benefits The SEL-2725'),
    'SEL-2725 Unmanaged Ethernet Switch',
  );
  assert.equal(docTitle('Instruction Manuals', 'SEL-2215 Sing le-Po le Trip Re I ay Instruction Manual'), null);
  assert.equal(docTitle('Ordering Information', 'Copyright © SEL 2019-2023 All rights reserved.'), null);
});

test('prose scores explanations above tables and settings dumps', async () => {
  const { proseScore } = await import('../lib/selDerive.js');
  const prose = 'Switch onto fault logic is used in protective relays to trip the breaker when the line is energized into a fault. The relay enables the logic for a short time after the breaker closes, and it trips without waiting for the normal time delay. '.repeat(2);
  const table = 'Out-of-Step Block • • • • Load Encroachment • • • • Switch-Onto-Fault • • • • 79RIS 79SEQ 79CLS 51P1 51G1 SV42 MV15 0.00 1 2 3 4 5 6 7 8 9 10 11 12 13';
  assert.ok(proseScore(prose) > 0.8);
  assert.ok(proseScore(table) < 0.2);
});

test('proximity favours the phrase, then the words close together', () => {
  assert.equal(proximityBoost(['switch', 'onto', 'fault'], 'use switch onto fault logic'), 1.8);
  assert.equal(proximityBoost(['switch', 'fault'], 'the switch closes into a fault'), 1.4);
  assert.equal(proximityBoost(['switch', 'fault'], `switch ${'x '.repeat(40)} fault`), 1);
  assert.equal(proximityBoost(['fault'], 'fault'), 1);
});

test('ranking: titles, prose and proximity reorder bm25, and old indexes still work', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'selft-'));
  try {
    const file = path.join(dir, 'idx.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE docs (path TEXT PRIMARY KEY, name TEXT, folder TEXT, size INTEGER, mtime INTEGER,
                         pages INTEGER, indexed_at TEXT, title TEXT, intro TEXT);
      CREATE VIRTUAL TABLE pages USING fts5(body, path UNINDEXED, page UNINDEXED);
      CREATE TABLE page_meta (path TEXT, page INTEGER, prose REAL, PRIMARY KEY (path, page)) WITHOUT ROWID;
    `);
    const doc = (p, title, intro = '') =>
      db.prepare('INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?)').run(p, path.basename(p), p.split('/')[0], 1, 1, 1, 'now', title, intro);
    const page = (p, n, body, prose) => {
      db.prepare('INSERT INTO pages (body, path, page) VALUES (?,?,?)').run(body, p, n);
      db.prepare('INSERT INTO page_meta VALUES (?,?,?)').run(p, n, prose);
    };
    doc('G/table.pdf', 'Feature Matrix');
    page('G/table.pdf', 1, 'switch • fault • onto • switch • fault', 0);
    doc('G/explain.pdf', 'Line Protection');
    page('G/explain.pdf', 1, 'The relay uses switch onto fault logic when the breaker closes into a long line with many words around it so bm25 prefers the short page', 1);
    // Mentions nothing in its text, found by its title alone.
    doc('G/about.pdf', 'Applying Switch Onto Fault Logic', 'Application Guide cover');
    page('G/about.pdf', 1, 'unrelated words only', 1);
    db.close();

    const ft = new SelFullText();
    ft.open(file);
    const hits = ft.search('switch onto fault', { folder: 'G' }).groups[0].hits;
    assert.deepEqual(hits.map((h) => h.path), ['G/explain.pdf', 'G/about.pdf', 'G/table.pdf']);
    assert.equal(hits[0].title, 'Line Protection');
    assert.equal(hits[1].snippet, 'Application Guide cover');
    ft.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
