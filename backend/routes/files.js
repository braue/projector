// Project-files surface: the folder tree (with artifact kinds annotated),
// versioned uploads, folder/rename/move/delete operations, plain-text
// read/save for the built-in notes editor, and OS-default-app open. Entry
// paths contain slashes, so they travel as ?path= / body fields, never as
// route params. `resolve(req)` supplies the project's { files, artifacts }.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { formatOf, mimeOf } from '../lib/extract/index.js';
import { innerParts, resolveInner, viewModel } from '../lib/extract/views.js';
import { httpError, requireQuery } from '../lib/http.js';
import { openWithOs } from '../lib/openWithOs.js';
import { Router, uploads } from '../lib/router.js';
import { searchPages } from '../services/pdfText.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** View models kept, newest last: switching between two open workbooks
 *  should not re-read either. */
const MAX_CACHED_VIEWS = 6;
const views = new Map();

/** `?inner=` — the JSON chain of steps into a container (zip entry names,
 *  mail attachment indexes); absent = the tree entry itself. */
function innerChain(req) {
  const raw = req.query.inner;
  if (raw === undefined || raw === '') return [];
  try {
    const chain = JSON.parse(String(raw));
    if (Array.isArray(chain) && chain.every((step) => typeof step === 'string' || Number.isInteger(step))) return chain;
  } catch {
    // fall through
  }
  throw httpError(400, 'inner must be a JSON array of steps');
}

/** The view model for a path + chain, cached by the file's stat identity. */
async function cachedView(absolute, name, chain) {
  const info = await stat(absolute);
  const key = `${absolute}|${info.mtimeMs}|${info.size}|${JSON.stringify(chain)}`;
  const hit = views.get(key);
  if (hit) {
    views.delete(key);
    views.set(key, hit);
    return hit;
  }
  const work = readFile(absolute).then((bytes) => viewModel(name, bytes, chain));
  views.set(key, work);
  work.catch(() => views.delete(key));
  while (views.size > MAX_CACHED_VIEWS) views.delete(views.keys().next().value);
  return work;
}

/** Text parts of an entry, or of an inner file within it. */
async function partsFor(index, files, entryPath, chain) {
  const read = await index.partsOf(entryPath);
  if (!chain.length) return read;
  const absolute = await files.rawPath(entryPath);
  const { labels } = await resolveInner(path.basename(entryPath), await readFile(absolute), chain);
  return { ...read, parts: innerParts(read.parts, labels) };
}

/** A body's `paths`: a non-empty list of tree paths. */
function pathList(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p)) {
    throw httpError(400, 'field "paths" must list one or more entry paths');
  }
  return paths;
}

function fileRoutes(resolve) {
  const router = Router({ mergeParams: true });
  // Disk storage, not memory: buffering a whole upload batch in RAM is the
  // OOM class the parse cache exists to prevent (same reasoning as the RTAC upload route). The
  // store copies the temp files into place; they are removed after.
  const upload = uploads({ disk: true, maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 100 });

  router.get('/', async (req, res) => {
    const { files, artifacts, index } = await resolve(req);
    // A reload is also the index's cue, for when the folder watcher is down.
    index.schedule();
    res.json({ tree: await files.tree((name, isDirectory) => artifacts.kindOf(name, isDirectory)) });
  });

  // Search inside every file of the project: the tree filter's content half.
  router.get('/search', async (req, res) => {
    res.json(await (await resolve(req)).index.search(requireQuery(req, 'q')));
  });

  router.get('/index', async (req, res) => {
    const { index } = await resolve(req);
    await index.start();
    res.json(index.status());
  });

  // The text read out of one file (or an inner file, ?inner=): located
  // parts, plus whether OCR is still to come.
  router.get('/parts', async (req, res) => {
    const { files, index } = await resolve(req);
    const entryPath = requireQuery(req, 'path');
    index.prioritize(entryPath);
    res.json(await partsFor(index, files, entryPath, innerChain(req)));
  });

  // What the preview pane draws for formats it shows in-app (workbook grid,
  // slides, document HTML, a message, an archive listing).
  router.get('/view', async (req, res) => {
    const { files } = await resolve(req);
    const entryPath = requireQuery(req, 'path');
    const absolute = await files.rawPath(entryPath);
    res.json(await cachedView(absolute, path.basename(entryPath), innerChain(req)));
  });

  // The bytes of an inner file — an image in a zip, a PDF attached to a
  // message — typed by its own name so the pane can show it inline.
  router.get('/inner-raw', async (req, res) => {
    const { files } = await resolve(req);
    const entryPath = requireQuery(req, 'path');
    const absolute = await files.rawPath(entryPath);
    const inner = await resolveInner(path.basename(entryPath), await readFile(absolute), innerChain(req));
    res.type(mimeOf(inner.name));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(inner.name)}`);
    res.send(Buffer.from(inner.bytes));
  });

  // Hand an inner file to the OS default app: written to a temp folder of
  // its own under its real name, since that is what the app will show.
  router.post('/open-inner', async (req, res) => {
    const { files } = await resolve(req);
    const entryPath = req.body?.path;
    const chain = req.body?.inner;
    if (typeof entryPath !== 'string' || !Array.isArray(chain) || !chain.length) {
      throw httpError(400, 'fields "path" and "inner" are required');
    }
    const absolute = await files.rawPath(entryPath);
    const inner = await resolveInner(path.basename(entryPath), await readFile(absolute), chain);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'projector-open-'));
    const target = path.join(dir, path.basename(inner.name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'file');
    await writeFile(target, inner.bytes);
    openWithOs(target);
    res.json({ ok: true });
  });

  // Multipart field "files"; "dir" names the target folder ('' = root);
  // "note" is the mandatory version note shared by the batch. "versionOf"
  // (single-file batches) names the existing entry the upload supersedes —
  // the entry takes the uploaded file's name, history riding along.
  router.post('/upload', upload.array('files'), async (req, res) => {
    try {
      if (!req.files?.length) throw httpError(400, 'multipart field "files" required');
      const { files } = await resolve(req);
      res.status(201).json(
        await files.upload(req.body?.dir ?? '', req.files, req.body?.note, req.body?.versionOf || null),
      );
    } finally {
      await Promise.all((req.files ?? []).map(
        (file) => rm(file.path, { force: true }).catch(() => {}),
      ));
    }
  });

  router.post('/folder', async (req, res) => {
    await (await resolve(req)).files.createFolder(req.body?.dir ?? '', req.body?.name);
    res.status(201).json({ ok: true });
  });

  router.patch('/entry', async (req, res) => {
    await (await resolve(req)).files.renameEntry(req.body?.path, req.body?.name);
    res.json({ ok: true });
  });

  // Move / delete several entries as ONE operation. Each carries on past a
  // failing path and reports it: { moved: [{ from, to }] | removed: [path],
  // failed: [{ path, error }] }.
  router.post('/move', async (req, res) => {
    res.json(await (await resolve(req)).files.moveEntries(pathList(req.body?.paths), String(req.body?.to ?? '')));
  });

  router.post('/remove', async (req, res) => {
    res.json(await (await resolve(req)).files.removeEntries(pathList(req.body?.paths)));
  });

  // The built-in text editor's read/save pair. Saving in place is not a new
  // version (see services/files.js); PUT to a fresh path creates the file.
  router.get('/text', async (req, res) => {
    res.json({ text: await (await resolve(req)).files.readText(requireQuery(req, 'path')) });
  });

  router.put('/text', async (req, res) => {
    await (await resolve(req)).files.writeText(req.body?.path, req.body?.text);
    res.json({ ok: true });
  });

  // Raw file bytes for the preview pane's in-app viewers (the PDF viewer).
  // Streamed with a Content-Type from the extension so Chromium renders it
  // inline; dotfiles are allowed because archived versions live under
  // `.versions/`. The whole app shares one loopback origin, so an <iframe>
  // pointing here is same-origin — no CORS, no CSP to satisfy.
  router.get('/raw', async (req, res) => {
    const absolute = await (await resolve(req)).files.rawPath(requireQuery(req, 'path'));
    await res.sendFile(absolute);
  });

  // Find-in-PDF for the embedded viewer, which has no find of its own. The
  // answer is page numbers with the line each hit sits in; the viewer jumps
  // by reloading at `#page=N`. `q` omitted just reads the document (the bar
  // warms it on open, so the first keystroke does not wait on extraction).
  // The pages are the index's, so a scanned set is searchable once OCR has
  // read it; `ocr: 'pending'` says that is still to come.
  router.get('/pdf-search', async (req, res) => {
    const { files, index } = await resolve(req);
    const entryPath = requireQuery(req, 'path');
    const chain = innerChain(req);
    if (!chain.length && formatOf(entryPath) !== 'pdf') throw httpError(400, 'not a PDF');
    index.prioritize(entryPath);
    const { parts, meta, ocr } = await partsFor(index, files, entryPath, chain);
    const pageParts = parts.filter((p) => /^p\. \d+$/.test(p.where));
    const count = meta?.pages && !chain.length
      ? meta.pages
      : pageParts.reduce((n, p) => Math.max(n, Number(p.where.slice(3))), 0);
    const pages = Array.from({ length: count }, () => '');
    for (const p of pageParts) pages[Number(p.where.slice(3)) - 1] = p.text;
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ ...searchPages(pages, query), ocr });
  });

  router.post('/open', async (req, res) => {
    await (await resolve(req)).files.open(req.body?.path);
    res.json({ ok: true });
  });

  // The working-copy pair: an entry the OS edited in place either commits
  // as a new version (mandatory note; the pre-edit snapshot archives as the
  // superseded version) or restores from its snapshot.
  router.post('/record-edit', async (req, res) => {
    await (await resolve(req)).files.recordEdit(req.body?.path, req.body?.note);
    res.status(201).json({ ok: true });
  });

  router.post('/discard-edit', async (req, res) => {
    await (await resolve(req)).files.discardEdit(req.body?.path);
    res.json({ ok: true });
  });

  // Show an entry (or the root, path '') in the OS file manager.
  router.post('/reveal', async (req, res) => {
    await (await resolve(req)).files.reveal(req.body?.path ?? '');
    res.json({ ok: true });
  });

  return router;
}

export { fileRoutes };
