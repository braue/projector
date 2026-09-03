// Per-artifact search: ?ref=&q= searches one artifact's parsed items.
// `resolve(req)` supplies the project's SearchService.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function searchRoutes(resolve) {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    res.json(await (await resolve(req)).search(requireQuery(req, 'ref'), requireQuery(req, 'q')));
  });

  return router;
}

export { searchRoutes };
