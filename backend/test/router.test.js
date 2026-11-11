// The node:http layer the routes run on: matching, mounts, bodies, errors,
// file responses, static serving and multipart uploads.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { httpError } from '../lib/http.js';
import { Router, createServer, serveStatic, uploads } from '../lib/router.js';

async function serve(app, options) {
  const server = createServer(app, options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('router: params through mounts, query, JSON bodies, errors and 404s', async () => {
  const child = Router();
  child.get('/:id/runs/:run', (req, res) => res.json({ params: req.params, query: req.query }));
  child.post('/', (req, res) => res.status(201).json({ body: req.body }));
  child.get('/boom', () => {
    throw httpError(409, 'taken');
  });
  child.get('/crash', async () => {
    throw new Error('plain');
  });
  const app = Router();
  app.use('/api/things/:scope', child);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'no such endpoint' }));
  const { base, close } = await serve(app);
  try {
    let res = await fetch(`${base}/api/things/a%20b/x/runs/7?q=1&q=2&z=`);
    assert.deepEqual(await res.json(), { params: { scope: 'a b', id: 'x', run: '7' }, query: { q: ['1', '2'], z: '' } });

    res = await fetch(`${base}/api/things/s/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: [1] }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { body: { a: [1] } });

    res = await fetch(`${base}/api/things/s`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/things/s/boom`);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'taken' });

    res = await fetch(`${base}/api/things/s/crash`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'plain' });

    res = await fetch(`${base}/api/nowhere`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'no such endpoint' });

    res = await fetch(`${base}/elsewhere`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('router: sendFile ranges, download names, static files and the index fallback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projector-router-'));
  try {
    await writeFile(path.join(dir, 'index.html'), '<p>app</p>');
    await writeFile(path.join(dir, 'doc.pdf'), '0123456789');
    await writeFile(path.join(os.tmpdir(), 'projector-router-outside.txt'), 'secret');
    const app = Router();
    app.get('/api/raw', async (req, res) => res.sendFile(path.join(dir, String(req.query.name))));
    app.get('/api/dl', async (_req, res) => res.download(path.join(dir, 'doc.pdf'), 'Ünïcode "x".pdf'));
    const fallback = async (req, res) => {
      if (!(await serveStatic(dir, req, res))) await res.sendFile(path.join(dir, 'index.html'));
    };
    const { base, close } = await serve(app, { fallback });
    try {
      let res = await fetch(`${base}/api/raw?name=doc.pdf`, { headers: { Range: 'bytes=2-4' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.equal(res.headers.get('content-range'), 'bytes 2-4/10');
      assert.equal(await res.text(), '234');

      res = await fetch(`${base}/api/raw?name=missing.pdf`);
      assert.equal(res.status, 404);

      res = await fetch(`${base}/api/dl`);
      assert.match(res.headers.get('content-disposition'), /^attachment; filename="_n_code _x_.pdf"; filename\*=UTF-8''%C3%9Cn%C3%AFcode%20%22x%22.pdf$/);
      assert.equal(await res.text(), '0123456789');

      res = await fetch(`${base}/doc.pdf`);
      assert.equal(await res.text(), '0123456789');
      res = await fetch(`${base}/`);
      assert.equal(await res.text(), '<p>app</p>');
      res = await fetch(`${base}/deep/link`);
      assert.equal(await res.text(), '<p>app</p>');

      // fetch() normalizes "..", so send the raw path.
      const raw = await new Promise((resolve, reject) => {
        request(`${base}/%2e%2e/projector-router-outside.txt`, (r) => {
          let text = '';
          r.on('data', (d) => { text += d; }).on('end', () => resolve(text));
        }).on('error', reject).end();
      });
      assert.equal(raw, '<p>app</p>');
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(path.join(os.tmpdir(), 'projector-router-outside.txt'), { force: true });
  }
});

test('router: multipart uploads to memory and disk, with fields and limits', async () => {
  const app = Router();
  const memory = uploads({ maxFileSize: 1024 * 1024, maxFiles: 2 });
  const disk = uploads({ disk: true, maxFileSize: 1024 * 1024, maxFiles: 3 });
  app.post('/one', memory.single('file'), (req, res) => {
    res.json({ name: req.file?.originalname, text: req.file?.buffer.toString(), body: req.body });
  });
  app.post('/pair', memory.fields(['workbook', 'report']), (req, res) => {
    res.json(Object.fromEntries(Object.entries(req.files).map(([k, [f]]) => [k, f.buffer.toString()])));
  });
  let tempPaths = [];
  app.post('/many', disk.array('files'), async (req, res) => {
    tempPaths = req.files.map((f) => f.path);
    res.json({
      files: await Promise.all(req.files.map(async (f) => [f.originalname, f.size, (await readFile(f.path)).toString()])),
      body: req.body,
    });
  });
  const { base, close } = await serve(app);
  try {
    // A body large enough to arrive in several chunks, with CRLFs and
    // boundary-like text inside it.
    const big = `${'line\r\n--not-the-boundary\r\n'.repeat(20000)}end`;
    let form = new FormData();
    form.append('note', 'héllo');
    form.append('file', new Blob([big]), 'Résumé.txt');
    let res = await fetch(`${base}/one`, { method: 'POST', body: form });
    let json = await res.json();
    assert.equal(json.name, 'Résumé.txt');
    assert.equal(json.text, big);
    assert.deepEqual(json.body, { note: 'héllo' });

    form = new FormData();
    form.append('report', new Blob(['R']), 'r.html');
    form.append('workbook', new Blob(['W']), 'w.xlsx');
    res = await fetch(`${base}/pair`, { method: 'POST', body: form });
    assert.deepEqual(await res.json(), { workbook: 'W', report: 'R' });

    form = new FormData();
    form.append('dir', 'a/b');
    form.append('files', new Blob(['']), 'empty.txt');
    form.append('files', new Blob(['x'.repeat(5000)]), 'x.bin');
    res = await fetch(`${base}/many`, { method: 'POST', body: form });
    json = await res.json();
    assert.deepEqual(json.files, [['empty.txt', 0, ''], ['x.bin', 5000, 'x'.repeat(5000)]]);
    assert.deepEqual(json.body, { dir: 'a/b' });
    assert.equal(tempPaths.length, 2);

    // Over the size limit: refused, and nothing left behind.
    form = new FormData();
    form.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024)]), 'huge.bin');
    res = await fetch(`${base}/one`, { method: 'POST', body: form });
    assert.equal(res.status, 413);

    form = new FormData();
    for (let i = 0; i < 4; i += 1) form.append('files', new Blob(['a']), `${i}.txt`);
    res = await fetch(`${base}/many`, { method: 'POST', body: form });
    assert.equal(res.status, 413);

    form = new FormData();
    form.append('other', new Blob(['a']), 'a.txt');
    res = await fetch(`${base}/one`, { method: 'POST', body: form });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
