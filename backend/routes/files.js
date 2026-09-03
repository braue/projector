// Project-files surface: the folder tree (with artifact kinds annotated),
// versioned uploads, folder/rename/move/delete operations, plain-text
// read/save for the built-in notes editor, and OS-default-app open. Entry
// paths contain slashes, so they travel as ?path= / body fields, never as
// route params. `resolve(req)` supplies the project's { files, artifacts }.

import { rm } from 'node:fs/promises';
import os from 'node:os';

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function fileRoutes(resolve) {
  const router = Router({ mergeParams: true });
  // Disk storage, not memory: this backend shares the Electron main process,
  // and buffering a whole upload batch in RAM is the OOM class the parse
  // cache exists to prevent (same reasoning as the RTAC upload route). The
  // store copies the temp files into place; they are removed after.
  const upload = multer({
    storage: multer.diskStorage({ destination: os.tmpdir() }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 100 },
  });

  router.get('/', async (req, res) => {
    const { files, artifacts } = await resolve(req);
    res.json({ tree: await files.tree((name, isDirectory) => artifacts.kindOf(name, isDirectory)) });
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

  router.post('/move', async (req, res) => {
    await (await resolve(req)).files.moveEntry(req.body?.path, req.body?.to ?? '');
    res.json({ ok: true });
  });

  router.delete('/entry', async (req, res) => {
    await (await resolve(req)).files.removeEntry(requireQuery(req, 'path'));
    res.json({ ok: true });
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
