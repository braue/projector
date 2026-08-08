// RDB upload surface. Uploads are multipart (field name "file"); everything
// else mirrors the projects routes so the Inspect UI can reuse its shapes.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function rdbRoutes(service) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

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

  // Inspect shapes; the profile ref travels as ?ref= because it contains "::".
  router.get('/tree', (req, res) => {
    res.json(service.tree(requireQuery(req, 'ref')));
  });

  router.get('/item', (req, res) => {
    res.json(service.item(requireQuery(req, 'ref'), requireQuery(req, 'file')));
  });

  // Generated front/rear panel drawing PNG for one profile.
  router.get('/drawing', (req, res, next) => {
    const file = service.drawingPath(requireQuery(req, 'ref'), requireQuery(req, 'view'));
    res.sendFile(file, (err) => {
      if (err) next(err);
    });
  });

  return router;
}

export { rdbRoutes };
