// REST surface over the project service. All handlers are thin: translate
// HTTP to service calls; thrown coded errors ({ status }) become JSON in the
// app-level error middleware.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function projectRoutes(service) {
  const router = Router();

  // Sidebar list: every AcRTAC project with its export state, plus the last
  // database-list error (null when the list is healthy).
  router.get('/', (_req, res) => {
    res.json(service.list());
  });

  // Retry the database list after a failure.
  router.post('/refresh', async (_req, res) => {
    await service.refreshList();
    res.json(service.list());
  });

  // Double-click: start (or retry) the export. 202 — completion is polled.
  router.post('/:name/export', (req, res) => {
    res.status(202).json(service.startExport(req.params.name));
  });

  // File-tree sidebar for an exported project.
  router.get('/:name/tree', async (req, res) => {
    res.json(await service.tree(req.params.name));
  });

  // Preview pane: one item's full parsed body. The file path arrives as a
  // query param because it contains slashes.
  router.get('/:name/item', async (req, res) => {
    res.json(await service.item(req.params.name, requireQuery(req, 'file')));
  });

  // Aggregate a list of setting names across a range of objects.
  // Body: { terms: string[], files?: string[] } — empty files = whole project.
  router.post('/:name/aggregate', async (req, res) => {
    const { terms, files } = req.body ?? {};
    res.json(await service.aggregate(req.params.name, {
      terms: Array.isArray(terms) ? terms : [],
      files: Array.isArray(files) ? files : [],
    }));
  });

  return router;
}

export { projectRoutes };
