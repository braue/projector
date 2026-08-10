// Project-files surface: the folder tree, uploads, folder/rename/move/
// delete operations, and OS-default-app open. Entry paths contain slashes,
// so they travel as ?path= / body fields, never as route params.
// `resolve(req)` supplies the project's FilesService.

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
    res.json({ tree: await (await resolve(req)).tree() });
  });

  // Multipart field "files"; "dir" names the target folder ('' = root).
  router.post('/upload', upload.array('files'), async (req, res) => {
    if (!req.files?.length) throw httpError(400, 'multipart field "files" required');
    const service = await resolve(req);
    res.status(201).json(await service.upload(req.body?.dir ?? '', req.files));
  });

  router.post('/folder', async (req, res) => {
    await (await resolve(req)).createFolder(req.body?.dir ?? '', req.body?.name);
    res.status(201).json({ ok: true });
  });

  router.patch('/entry', async (req, res) => {
    await (await resolve(req)).renameEntry(req.body?.path, req.body?.name);
    res.json({ ok: true });
  });

  router.post('/move', async (req, res) => {
    await (await resolve(req)).moveEntry(req.body?.path, req.body?.to ?? '');
    res.json({ ok: true });
  });

  router.delete('/entry', async (req, res) => {
    await (await resolve(req)).removeEntry(requireQuery(req, 'path'));
    res.json({ ok: true });
  });

  router.post('/open', async (req, res) => {
    await (await resolve(req)).open(req.body?.path);
    res.json({ ok: true });
  });

  return router;
}

export { fileRoutes };
