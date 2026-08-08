// Compare surface: two ready projects, addressed as ?original=A&updated=B.

import { Router } from 'express';

function compareRoutes(service) {
  const router = Router();

  const respond = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
    }
  };

  const pair = (req) => {
    const { original, updated } = req.query;
    if (typeof original !== 'string' || !original || typeof updated !== 'string' || !updated) {
      throw Object.assign(new Error('original and updated query parameters required'), { status: 400 });
    }
    return { original, updated };
  };

  // Union tree with per-item status tint.
  router.get('/tree', respond(async (req, res) => {
    const { original, updated } = pair(req);
    res.json(await service.compare(original, updated));
  }));

  // Structured diff of one file.
  router.get('/item', respond(async (req, res) => {
    const { original, updated } = pair(req);
    const file = req.query.file;
    if (typeof file !== 'string' || !file) {
      res.status(400).json({ error: 'file query parameter required' });
      return;
    }
    res.json(await service.compareItem(original, updated, file));
  }));

  return router;
}

export { compareRoutes };
