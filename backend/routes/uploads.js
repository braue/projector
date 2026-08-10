// Shared router for upload-backed sources (RDB, SCD, SW): multipart upload
// (field name "file"), list, delete, and the inspect tree/item pair whose
// profile refs travel as ?ref= because they contain "::". Routes are
// project-scoped, so `resolve(req)` supplies the right project's service per
// request. Callers may append type-specific routes (RDB adds /drawing) to
// the returned router.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

function uploadSourceRoutes(resolve, { maxBytes }) {
  const router = Router({ mergeParams: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes } });

  router.get('/', async (req, res) => {
    res.json({ files: (await resolve(req)).list() });
  });

  router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) throw httpError(400, 'multipart field "file" required');
    const service = await resolve(req);
    res.status(201).json(await service.upload(req.file.originalname, req.file.buffer));
  });

  router.delete('/:id', async (req, res) => {
    await (await resolve(req)).remove(req.params.id);
    res.json({ ok: true });
  });

  router.get('/tree', async (req, res) => {
    res.json((await resolve(req)).tree(requireQuery(req, 'ref')));
  });

  router.get('/item', async (req, res) => {
    res.json((await resolve(req)).item(requireQuery(req, 'ref'), requireQuery(req, 'file')));
  });

  return router;
}

export { uploadSourceRoutes };
