// REST surface over the project service. All handlers are thin: translate
// HTTP to service calls and coded errors ({ status }) back to HTTP.

import { Router } from 'express';

function projectRoutes(service) {
  const router = Router();

  const respond = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
    }
  };

  // Sidebar list: every AcRTAC project with its export state, plus the last
  // database-list error (null when the list is healthy).
  router.get('/', respond(async (_req, res) => {
    res.json(service.list());
  }));

  // Retry the database list after a failure.
  router.post('/refresh', respond(async (_req, res) => {
    await service.refreshList();
    res.json(service.list());
  }));

  // Double-click: start (or retry) the export. 202 — completion is polled.
  router.post('/:name/export', respond(async (req, res) => {
    res.status(202).json(service.startExport(req.params.name));
  }));

  // File-tree sidebar for an exported project.
  router.get('/:name/tree', respond(async (req, res) => {
    res.json(await service.tree(req.params.name));
  }));

  // Preview pane: one item's full parsed body. The file path arrives as a
  // query param because it contains slashes.
  router.get('/:name/item', respond(async (req, res) => {
    const file = req.query.file;
    if (typeof file !== 'string' || !file) {
      res.status(400).json({ error: 'file query parameter required' });
      return;
    }
    res.json(await service.item(req.params.name, file));
  }));

  // Aggregate a list of setting names across a range of objects.
  // Body: { terms: string[], files?: string[] } — empty files = whole project.
  router.post('/:name/aggregate', respond(async (req, res) => {
    const { terms, files } = req.body ?? {};
    res.json(await service.aggregate(req.params.name, {
      terms: Array.isArray(terms) ? terms : [],
      files: Array.isArray(files) ? files : [],
    }));
  }));

  return router;
}

export { projectRoutes };
