// The content index's two lanes under the awkward timings: OCR that fails,
// a file opened before the index reaches it, a file deleted mid-read, a
// start that fails once, and the caches that keep re-reads cheap. OCR is
// stubbed: these are about the bookkeeping, not Tesseract.

import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extract } from '../lib/extract/index.js';
import { ContentIndex } from '../services/contentIndex.js';
import { asUpload, makeBundle } from './helpers/bundle.js';
import { makePdf, makeTextPng } from './helpers/makeDocs.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(index) {
  for (let i = 0; i < 400; i += 1) {
    const { reading, ocr } = index.status();
    if (!reading && !ocr) return;
    await sleep(25);
  }
  throw new Error('index never settled');
}

/** Real text layers; OCR as `ocr(name)` says (text, or throws). */
function stubbed({ ocr = () => 'scanned words', textDelay = 0 } = {}) {
  const calls = { text: 0, ocr: 0 };
  const extractor = async (name, bytes, options) => {
    if (!options.ocr) {
      calls.text += 1;
      if (textDelay) await sleep(textDelay);
      return extract(name, bytes, options);
    }
    calls.ocr += 1;
    const layer = await extract(name, bytes, { ...options, ocr: false });
    return { ...layer, parts: [...layer.parts, { where: 'ocr', text: ocr(name), unit: 'line' }], wantsOcr: false };
  };
  return { extractor, calls };
}

async function project(entries) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-lanes-'));
  const { files, artifacts } = await makeBundle(tmp);
  if (entries.length) await files.upload('', entries.map(([name, bytes]) => asUpload(name, bytes)), 'initial');
  const open = (options = {}) => new ContentIndex({
    files,
    kindOf: (name, isDirectory) => artifacts.kindOf(name, isDirectory),
    cacheDir: path.join(tmp, 'text-index'),
    ...options,
  });
  return { tmp, files, open, done: () => rm(tmp, { recursive: true, force: true }) };
}

const paths = (result) => result.results.map((r) => r.path);

test('lanes: a failed OCR pass keeps the text layer, and the next session tries again', async () => {
  const p = await project([['set.pdf', await makePdf([['Recloser R3777 settings'], []])]]);
  try {
    const failing = stubbed({ ocr: () => { throw Object.assign(new Error('no worker'), { ocrFailure: true }); } });
    const index = p.open({ extractor: failing.extractor });
    await index.start();
    await settle(index);
    assert.equal(failing.calls.ocr, 1);
    assert.deepEqual(paths(await index.search('r3777')), ['set.pdf']);
    const parts = await index.partsOf('set.pdf');
    assert.equal(parts.ocr, 'done', 'no endless "reading scanned pages"');
    assert.match(parts.parts.map((x) => x.text).join(' '), /R3777/);
    index.close();

    const working = stubbed();
    const again = p.open({ extractor: working.extractor });
    await again.start();
    await settle(again);
    assert.equal(working.calls.ocr, 1, 'the failure was not saved as done');
    assert.deepEqual(paths(await again.search('scanned words')), ['set.pdf']);
    again.close();
  } finally {
    await p.done();
  }
});

test('lanes: a file opened before the index reaches it still gets its OCR text', async () => {
  const p = await project([['scan.png', await makeTextPng('x')]]);
  try {
    const { extractor } = stubbed({ textDelay: 150 });
    const index = p.open({ extractor });
    const started = index.start();
    // Opened while its text layer is still being read.
    const early = await index.partsOf('scan.png');
    assert.equal(early.ocr, 'pending');
    await started;
    await settle(index);
    assert.equal((await index.partsOf('scan.png')).ocr, 'done');
    assert.deepEqual(paths(await index.search('scanned words')), ['scan.png']);
    assert.equal(index.status().ocr, 0);
    index.close();
  } finally {
    await p.done();
  }
});

test('lanes: a file deleted while it is read does not come back', async () => {
  const p = await project([['gone.txt', 'phantom words']]);
  try {
    const { extractor } = stubbed({ textDelay: 700 });
    const index = p.open({ extractor });
    await index.start();
    await p.files.removeEntry('gone.txt');
    index.schedule(); // the watcher's cue; settles at 400 ms, before the read ends
    await sleep(800);
    await settle(index);
    assert.deepEqual(paths(await index.search('phantom')), []);
    index.close();
  } finally {
    await p.done();
  }
});

test('lanes: a start that fails once is tried again', async () => {
  const p = await project([['a.txt', 'alpha words']]);
  try {
    let failures = 1;
    const files = new Proxy(p.files, {
      get(target, name) {
        if (name === 'tree' && failures > 0) {
          return async () => {
            failures -= 1;
            throw new Error('disk hiccup');
          };
        }
        const value = target[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const index = p.open({ files });
    await assert.rejects(index.search('alpha'), /disk hiccup/);
    await index.start();
    await settle(index);
    assert.deepEqual(paths(await index.search('alpha')), ['a.txt']);
    index.close();
  } finally {
    await p.done();
  }
});

test('lanes: reopening a file is a stat, not a read; a changed file is read again', async () => {
  const p = await project([['big.txt', 'first words']]);
  try {
    const index = p.open();
    await index.start();
    await settle(index);
    const absolute = await p.files.rawPath('big.txt');
    assert.match((await index.partsOf('big.txt')).parts[0].text, /first/);
    await chmod(absolute, 0o000); // unreadable: a second read would throw
    try {
      assert.match((await index.partsOf('big.txt')).parts[0].text, /first/);
    } finally {
      await chmod(absolute, 0o644);
    }
    await sleep(10);
    await writeFile(absolute, 'second words, longer');
    assert.match((await index.partsOf('big.txt')).parts[0].text, /second/);
    index.close();
  } finally {
    await p.done();
  }
});

test('lanes: an archived version keeps its OCR text across sessions while it exists', async () => {
  const p = await project([['scan.png', await makeTextPng('one')]]);
  try {
    await p.files.upload('', [asUpload('scan.png', await makeTextPng('two'))], 'second');
    const [live] = await p.files.tree();
    const archived = live.versions[0].path;
    const first = stubbed();
    const index = p.open({ extractor: first.extractor });
    await index.start();
    await settle(index);
    await index.partsOf(archived);
    await settle(index);
    assert.equal((await index.partsOf(archived)).ocr, 'done');
    await sleep(1100); // the archive list is saved
    index.close();

    const second = stubbed();
    const again = p.open({ extractor: second.extractor });
    await again.start();
    await settle(again);
    await sleep(100); // the quiet scan's sweep
    assert.equal((await again.partsOf(archived)).ocr, 'done');
    assert.equal(second.calls.ocr, 0, 'not read by OCR again');
    again.close();

    // Once the version is gone, so is its text.
    await p.files.removeEntry('scan.png');
    const third = p.open();
    await third.start();
    await settle(third);
    await sleep(1100); // the sweep, then the archive list's save
    const blobs = (await readdir(path.join(p.tmp, 'text-index'))).filter((n) => /^[0-9a-f]{40}\.json$/.test(n));
    assert.deepEqual(blobs, []);
    assert.deepEqual(JSON.parse(await readFile(path.join(p.tmp, 'text-index', 'archived.json'), 'utf8').catch(() => '{}')), {});
    third.close();
  } finally {
    await p.done();
  }
});
