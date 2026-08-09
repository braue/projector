// Shared router for upload-backed sources (RDB, SCD): multipart upload
// (field name "file"), list, delete, and the inspect tree/item pair whose
// profile refs travel as ?ref= because they contain "::". Callers may append
// type-specific routes (RDB adds /drawing) to the returned router.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

function uploadSourceRoutes(service, { maxBytes }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes } });

  router.get('/', (_req, res) => {
    res.json({ files: service.list() });
  });

  router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) throw httpError(400, 'multipart field "file" required');
    res.status(201).json(await service.upload(req.file.originalname, req.file.buffer));
  });

  router.delete('/:id', async (req, res) => {
    await service.remove(req.params.id);
    res.json({ ok: true });
  });

  router.get('/tree', (req, res) => {
    res.json(service.tree(requireQuery(req, 'ref')));
  });

  router.get('/item', (req, res) => {
    res.json(service.item(requireQuery(req, 'ref'), requireQuery(req, 'file')));
  });

  return router;
}

export { uploadSourceRoutes };
