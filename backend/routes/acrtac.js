// The AcRTAC database's project list — machine-global, cached
// (services/rtacCatalog.js). Every project picker reads it here.
//
//   GET  /api/acrtac/projects           { projects, error } — reads once
//   POST /api/acrtac/projects/refresh   re-read the database, then the same

import { Router } from 'express';

function acrtacRoutes(catalog) {
  const router = Router();

  router.get('/projects', async (_req, res) => {
    res.json(await catalog.list());
  });

  router.post('/projects/refresh', async (_req, res) => {
    await catalog.refresh();
    res.json(await catalog.list());
  });

  return router;
}

export { acrtacRoutes };
