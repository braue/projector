// Project-files surface: the folder tree (with artifact kinds annotated),
// versioned uploads, folder/rename/move/delete operations, plain-text
// read/save for the built-in notes editor, and OS-default-app open. Entry
// paths contain slashes, so they travel as ?path= / body fields, never as
// route params. `resolve(req)` supplies the project's { files, artifacts }.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function fileRoutes(resolve) {
  const router = Router({ mergeParams: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 100 },
  });

  router.get('/', async (req, res) => {
    const { files, artifacts } = await resolve(req);
    res.json({ tree: await files.tree((name, isDirectory) => artifacts.kindOf(name, isDirectory)) });
  });

  // Multipart field "files"; "dir" names the target folder ('' = root);
  // "note" is the mandatory version note shared by the batch.
  router.post('/upload', upload.array('files'), async (req, res) => {
    if (!req.files?.length) throw httpError(400, 'multipart field "files" required');
    const { files } = await resolve(req);
    res.status(201).json(await files.upload(req.body?.dir ?? '', req.files, req.body?.note));
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

  // Show an entry (or the root, path '') in the OS file manager.
  router.post('/reveal', async (req, res) => {
    await (await resolve(req)).files.reveal(req.body?.path ?? '');
    res.json({ ok: true });
  });

  return router;
}

export { fileRoutes };
