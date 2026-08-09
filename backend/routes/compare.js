// Compare surface: two same-type sources, addressed as
// ?originalType=rdb&original=<ref>&updatedType=rdb&updated=<ref>.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function compareRoutes(service) {
  const router = Router();

  const pair = (req) => ({
    a: { type: requireQuery(req, 'originalType'), ref: requireQuery(req, 'original') },
    b: { type: requireQuery(req, 'updatedType'), ref: requireQuery(req, 'updated') },
  });

  // Union tree with per-item status tint.
  router.get('/tree', async (req, res) => {
    const { a, b } = pair(req);
    res.json(await service.compare(a, b));
  });

  // Structured diff of one item.
  router.get('/item', async (req, res) => {
    const { a, b } = pair(req);
    res.json(await service.compareItem(a, b, requireQuery(req, 'file')));
  });

  return router;
}

export { compareRoutes };
