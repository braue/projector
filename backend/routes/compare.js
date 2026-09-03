// Compare surface for one project: two same-kind artifacts (or profiles),
// addressed as ?original=<ref>&updated=<ref>. The kind is derived from each
// ref server-side; a mismatch is a 400. `resolve(req)` supplies the
// project's CompareService.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function compareRoutes(resolve) {
  const router = Router({ mergeParams: true });

  // Union tree with per-item status tint.
  router.get('/tree', async (req, res) => {
    res.json(await (await resolve(req)).compare(
      requireQuery(req, 'original'),
      requireQuery(req, 'updated'),
    ));
  });

  // Structured diff of one item.
  router.get('/item', async (req, res) => {
    res.json(await (await resolve(req)).compareItem(
      requireQuery(req, 'original'),
      requireQuery(req, 'updated'),
      requireQuery(req, 'file'),
    ));
  });

  return router;
}

export { compareRoutes };
