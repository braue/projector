// Per-source search: ?type=&ref=&q= searches one source's parsed items.
// `resolve(req)` supplies the project's SearchService.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function searchRoutes(resolve) {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const source = { type: requireQuery(req, 'type'), ref: requireQuery(req, 'ref') };
    res.json(await (await resolve(req)).search(source, requireQuery(req, 'q')));
  });

  return router;
}

// The everywhere search: ?q= across every project's sources and notes.
// Unscoped by design, so it mounts beside /api/projects, not under it.
function globalSearchRoutes(search) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await search.search(requireQuery(req, 'q')));
  });

  return router;
}

export { globalSearchRoutes, searchRoutes };
