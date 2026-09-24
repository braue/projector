// Find-in-PDF: the page-level search behind the viewer's find bar. The
// fixtures are PDFs written here with pdf-lib, so the text that comes back
// out of PDFium is text this test put in.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PDFDocument, StandardFonts } from 'pdf-lib';

import { searchPdf, warmPdf } from '../services/pdfText.js';

/** A PDF whose page N carries `lines[N - 1]`, one drawn line per entry. */
async function writePdf(file, pages) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = document.addPage([612, 792]);
    lines.forEach((line, index) => {
      page.drawText(line, { x: 50, y: 720 - index * 18, size: 11, font });
    });
  }
  await writeFile(file, await document.save());
}

async function withPdf(pages, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projector-pdftext-'));
  const file = path.join(dir, 'manual.pdf');
  try {
    await writePdf(file, pages);
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('pdf search: finds every occurrence and names its page', async () => {
  await withPdf(
    [
      ['Overcurrent element 51P pickup', 'and nothing else here'],
      ['Nothing of interest on this page'],
      ['51P again, and 51P once more'],
    ],
    async (file) => {
      const result = await searchPdf(file, '51P');
      assert.equal(result.pages, 3);
      assert.equal(result.total, 3);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.matches.map((hit) => hit.page), [1, 3, 3]);
      // The snippet is split so the caller highlights without re-finding,
      // and carries the term as the document wrote it, not as it was typed.
      assert.equal(result.matches[0].match, '51P');
      assert.match(result.matches[0].before, /Overcurrent element $/);
      assert.match(result.matches[0].after, /^ pickup/);
    },
  );
});

test('pdf search: case-insensitive, and a phrase that wrapped still matches', async () => {
  await withPdf(
    [['The RECLOSE interval is', 'the setting in question']],
    async (file) => {
      assert.equal((await searchPdf(file, 'reclose')).total, 1);
      // "interval is / the setting" is two drawn lines in the file; a reader
      // typing the phrase means the words, not the line break.
      const phrase = await searchPdf(file, 'interval is the setting');
      assert.equal(phrase.total, 1);
      assert.equal(phrase.matches[0].page, 1);
    },
  );
});

test('pdf search: a term that is not there reports the page count anyway', async () => {
  await withPdf([['only this'], ['and this']], async (file) => {
    const result = await searchPdf(file, 'absent');
    assert.equal(result.pages, 2);
    assert.equal(result.total, 0);
    assert.deepEqual(result.matches, []);
  });
});

test('pdf search: an empty query reads the document without searching it', async () => {
  await withPdf([['a'], ['b'], ['c']], async (file) => {
    const warm = await warmPdf(file);
    assert.equal(warm.pages, 3);
    assert.equal(warm.hasText, true);
    const result = await searchPdf(file, '   ');
    assert.equal(result.total, 0);
    assert.equal(result.pages, 3);
  });
});

test('pdf search: a document with no text layer says so', async () => {
  // Pages with nothing drawn on them stand in for a scanned drawing set:
  // "nothing to search" is a different answer from "no match".
  await withPdf([[], []], async (file) => {
    const result = await searchPdf(file, 'anything');
    assert.equal(result.hasText, false);
    assert.equal(result.pages, 2);
    assert.equal(result.total, 0);
  });
});

test('pdf search: a rewritten file is read again, not served from cache', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projector-pdftext-'));
  const file = path.join(dir, 'manual.pdf');
  try {
    await writePdf(file, [['before the change']]);
    assert.equal((await searchPdf(file, 'before')).total, 1);
    // A new version arriving under the same name is the everyday case here.
    await writePdf(file, [['after the change, twice: after']]);
    assert.equal((await searchPdf(file, 'before')).total, 0);
    assert.equal((await searchPdf(file, 'after')).total, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
