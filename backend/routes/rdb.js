// RDB upload surface. Uploads are multipart (field name "file"); everything
// else mirrors the projects routes so the Inspect UI can reuse its shapes.

import { Router } from 'express';
import multer from 'multer';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function rdbRoutes(service) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

  const respond = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
    }
  };

  router.get('/', respond(async (_req, res) => {
    res.json({ files: service.list() });
  }));

  router.post('/', upload.single('file'), respond(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'multipart field "file" required' });
      return;
    }
    res.status(201).json(await service.upload(req.file.originalname, req.file.buffer));
  }));

  router.delete('/:id', respond(async (req, res) => {
    await service.remove(req.params.id);
    res.json({ ok: true });
  }));

  // Inspect shapes; the profile ref travels as ?ref= because it contains "::".
  router.get('/tree', respond(async (req, res) => {
    res.json(service.tree(String(req.query.ref ?? '')));
  }));

  router.get('/item', respond(async (req, res) => {
    res.json(service.item(String(req.query.ref ?? ''), String(req.query.file ?? '')));
  }));

  return router;
}

export { rdbRoutes };
