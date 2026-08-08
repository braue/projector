// Compare surface: two ready projects, addressed as ?original=A&updated=B.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function compareRoutes(service) {
  const router = Router();

  const pair = (req) => ({
    original: requireQuery(req, 'original'),
    updated: requireQuery(req, 'updated'),
  });

  // Union tree with per-item status tint.
  router.get('/tree', async (req, res) => {
    const { original, updated } = pair(req);
    res.json(await service.compare(original, updated));
  });

  // Structured diff of one file.
  router.get('/item', async (req, res) => {
    const { original, updated } = pair(req);
    res.json(await service.compareItem(original, updated, requireQuery(req, 'file')));
  });

  return router;
}

export { compareRoutes };
