// The project's full-text index: every readable format found by content,
// each hit located; OCR fills in images and scans; the on-disk cache
// survives a restart; views and inner files resolve through containers.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { shutdownOcr } from '../lib/extract/ocr.js';
import { formatNumber } from '../lib/extract/office.js';
import { innerParts, resolveInner, viewModel } from '../lib/extract/views.js';
import { ContentIndex } from '../services/contentIndex.js';
import { asUpload, makeBundle } from './helpers/bundle.js';
import {
  makeDocx, makeEml, makePdf, makePptx, makeScannedPdf, makeTextPng, makeXlsx, zip,
} from './helpers/makeDocs.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function settle(index) {
  for (let i = 0; i < 400; i += 1) {
    const { reading, ocr } = index.status();
    if (!reading && !ocr) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('index never settled');
}

async function withProject(entries, run) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-index-'));
  const { files, artifacts } = await makeBundle(tmp);
  const open = () => new ContentIndex({
    files,
    kindOf: (name, isDirectory) => artifacts.kindOf(name, isDirectory),
    cacheDir: path.join(tmp, 'text-index'),
  });
  try {
    await files.upload('', entries.map(([name, bytes]) => asUpload(name, bytes)), 'initial');
    const index = open();
    await index.start();
    await settle(index);
    await run({ index, files, tmp, open });
    index.close();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

after(shutdownOcr);

const where = (result, file) => result.results.find((r) => r.path === file)?.hits.map((h) => h.where) ?? null;

test('content index: every readable format is found by its text, and says where', async () => {
  await withProject([
    ['notes.txt', 'first line\nBreaker 52A trips on R3777'],
    ['points.csv', 'tag,desc\nR3777,recloser'],
    ['config.json', '{"device":"R3777"}'],
    ['spec.docx', makeDocx(['Intro', 'Recloser R3777 control'], { header: 'SEL Engineering' })],
    ['points.xlsx', makeXlsx({ Points: [['Tag', 'Value'], ['R3777 BKR', { v: 0.25, fmt: '0%' }]] })],
    ['deck.pptx', makePptx([{ title: 'Kickoff', bullets: ['nothing'] }, { title: 'Scope', bullets: ['R3777 scope'] }])],
    ['manual.pdf', await makePdf([['cover'], ['R3777 on page two']])],
    ['mail.eml', makeEml({
      subject: 'FAT', from: 'a@example.com', to: 'b@example.com', body: 'see attached',
      attachments: [{ name: 'report.pdf', type: 'application/pdf', bytes: await makePdf([['R3777 in the report']]) }],
    })],
    ['bundle.zip', zip({ 'inner/readme.txt': 'R3777 zipped', 'inner/sheet.xlsx': makeXlsx({ S: [['R3777 nested']] }) })],
    ['ignored.bin', 'R3777 in a format nobody reads'],
  ], async ({ index }) => {
    const result = await index.search('r3777');
    assert.deepEqual(where(result, 'notes.txt'), ['line 2']);
    assert.deepEqual(where(result, 'points.csv'), ['line 2']);
    assert.deepEqual(where(result, 'config.json'), ['line 1']);
    assert.deepEqual(where(result, 'spec.docx'), ['']);
    assert.deepEqual(where(result, 'points.xlsx'), ['Points · row 2']);
    assert.deepEqual(where(result, 'deck.pptx'), ['slide 2']);
    assert.deepEqual(where(result, 'manual.pdf'), ['p. 2']);
    assert.deepEqual(where(result, 'mail.eml'), ['report.pdf › p. 1']);
    assert.ok(where(result, 'bundle.zip').includes('inner/readme.txt · line 1'));
    assert.ok(where(result, 'bundle.zip').includes('inner/sheet.xlsx › S · row 1'));
    assert.equal(where(result, 'ignored.bin'), null);

    // Snippets split for highlighting, the match as the file wrote it.
    const hit = result.results.find((r) => r.path === 'notes.txt').hits[0];
    assert.deepEqual([hit.before, hit.match, hit.after], ['Breaker 52A trips on ', 'R3777', '']);

    // Cells read as Excel shows them; headers and footers are searched too.
    assert.deepEqual(where(await index.search('25%'), 'points.xlsx'), ['Points · row 2']);
    assert.deepEqual(where(await index.search('sel engineering'), 'spec.docx'), ['header']);
  });
});

test('content index: OCR reads images and scanned PDFs', async () => {
  await withProject([
    ['shot.png', await makeTextPng('Substation Gulfport')],
    ['scan.pdf', await makeScannedPdf('Feeder Evergreen')],
  ], async ({ index }) => {
    assert.deepEqual(where(await index.search('gulfport'), 'shot.png'), ['line 1']);
    assert.deepEqual(where(await index.search('evergreen'), 'scan.pdf'), ['p. 1']);
    const parts = await index.partsOf('scan.pdf');
    assert.equal(parts.ocr, 'done');
  });
});

test('content index: an Outlook message is read with its attachments and the message inside it', async () => {
  await withProject([
    ['outer.msg', await readFile(path.join(FIXTURES, 'mail', 'outer-mail.msg'))],
  ], async ({ index }) => {
    const hits = where(await index.search('inner'), 'outer.msg');
    assert.ok(hits.includes('Inner mail.msg › header · line 1'));
    assert.ok(hits.some((w) => w.startsWith('Inner mail.msg › INNER 1.pdf › p. 1')));
    assert.ok(where(await index.search('outer 2'), 'outer.msg').includes('OUTER 2.pdf › p. 1'));
  });
});

test('content index: changes are followed, and the cache survives a restart', async () => {
  await withProject([['a.txt', 'alpha']], async ({ index, files, open }) => {
    assert.ok(where(await index.search('alpha'), 'a.txt'));
    await files.upload('', [asUpload('b.txt', 'bravo')], 'second');
    await files.removeEntries(['a.txt']);
    index.schedule();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await settle(index);
    assert.equal(where(await index.search('alpha'), 'a.txt'), null);
    assert.deepEqual(where(await index.search('bravo'), 'b.txt'), ['line 1']);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // manifest save
    index.close();

    const again = open();
    await again.start();
    assert.equal(again.status().reading, 0, 'nothing to re-read after a restart');
    assert.deepEqual(where(await again.search('bravo'), 'b.txt'), ['line 1']);
    again.close();
  });
});

test('views: workbooks, decks, mail and archives — and files inside containers', async () => {
  const book = await viewModel('p.xlsx', makeXlsx({
    Data: [['Name', 'When', 'Amps'], ['R1', { v: 46336, fmt: 'm/d/yyyy' }, { v: 1234.5, fmt: '#,##0.00 "A"' }]],
  }));
  assert.equal(book.format, 'sheet');
  assert.deepEqual(book.sheets[0].rows[1].cells.map((c) => c.v), ['R1', '11/10/2026', '1,234.50 A']);

  const deck = await viewModel('d.pptx', makePptx([{ title: 'T', bullets: ['b1'], notes: 'n1' }]));
  assert.deepEqual([deck.slides[0].title, deck.slides[0].paragraphs[0].text, deck.slides[0].notes], ['T', 'b1', 'n1']);

  const csv = await viewModel('x.csv', Buffer.from('a;b\n"x;1";"say ""hi"""\n'));
  assert.deepEqual(csv.sheets[0].rows[1].cells.map((c) => c.v), ['x;1', 'say "hi"']);

  const archive = zip({ 'docs/m.eml': makeEml({ subject: 'S', from: 'a@x', to: 'b@x', body: 'body', attachments: [{ name: 'n.txt', type: 'text/plain', bytes: Buffer.from('deep') }] }) });
  const listing = await viewModel('a.zip', archive);
  assert.deepEqual(listing.entries.map((e) => e.name), ['docs/m.eml']);
  const mail = await viewModel('a.zip', archive, ['docs/m.eml']);
  assert.equal(mail.subject, 'S');
  assert.deepEqual(mail.attachments.map((a) => a.name), ['n.txt']);
  const deep = await resolveInner('a.zip', archive, ['docs/m.eml', 0]);
  assert.equal(Buffer.from(deep.bytes).toString(), 'deep');
  assert.deepEqual(deep.labels, ['docs/m.eml', 'n.txt']);
  assert.deepEqual(
    innerParts([{ where: 'docs/m.eml › n.txt › line 1', text: 'deep' }, { where: 'other', text: 'x' }], deep.labels),
    [{ where: 'line 1', text: 'deep' }],
  );
});

test('number formats: the common Excel codes', () => {
  assert.equal(formatNumber(0.125, '0.0%'), '12.5%');
  assert.equal(formatNumber(-1500, '#,##0;(#,##0)'), '(1,500)');
  assert.equal(formatNumber(1 / 3, 'General'), '0.3333333333');
  assert.equal(formatNumber(45000.5, 'yyyy-mm-dd hh:mm'), '2023-03-15 12:00');
  assert.equal(formatNumber(13.8, '0.0 "kV"'), '13.8 kV');
});

test('view of a corrupt workbook throws, and the index records it once', async () => {
  await withProject([['bad.xlsx', Buffer.from('not a zip')]], async ({ index }) => {
    const parts = await index.partsOf('bad.xlsx');
    assert.ok(parts.error);
    assert.equal(index.status().reading, 0);
  });
  await assert.rejects(viewModel('bad.xlsx', Buffer.from('nope')));
});
