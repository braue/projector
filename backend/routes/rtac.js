// RTAC surface for one project: the sidebar list (machine-global catalog
// merged with this project's export states), export-into-project, and the
// inspect/aggregate reads. `resolve(req)` supplies the project's RtacService;
// `catalog` is the shared AcRTAC database catalog its refresh re-queries.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';

function rtacRoutes(resolve, catalog) {
  const router = Router({ mergeParams: true });

  // Sidebar list: every AcRTAC project with its export state in THIS
  // project, plus the last database-list error (null when healthy).
  router.get('/', async (req, res) => {
    res.json((await resolve(req)).list());
  });

  // Retry the database list after a failure.
  router.post('/refresh', async (req, res) => {
    await catalog.refresh();
    res.json((await resolve(req)).list());
  });

  // Double-click: start (or retry) the export into this project. 202 —
  // completion is polled.
  router.post('/:name/export', async (req, res) => {
    res.status(202).json((await resolve(req)).startExport(req.params.name));
  });

  // File-tree sidebar for an exported RTAC project.
  router.get('/:name/tree', async (req, res) => {
    res.json(await (await resolve(req)).tree(req.params.name));
  });

  // Preview pane: one item's full parsed body. The file path arrives as a
  // query param because it contains slashes.
  router.get('/:name/item', async (req, res) => {
    res.json(await (await resolve(req)).item(req.params.name, requireQuery(req, 'file')));
  });

  // Aggregate a list of setting names across a range of objects.
  // Body: { terms: string[], files?: string[] } — empty files = whole project.
  router.post('/:name/aggregate', async (req, res) => {
    const { terms, files } = req.body ?? {};
    res.json(await (await resolve(req)).aggregate(req.params.name, {
      terms: Array.isArray(terms) ? terms : [],
      files: Array.isArray(files) ? files : [],
    }));
  });

  return router;
}

export { rtacRoutes };
