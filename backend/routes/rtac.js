// RTAC surface for one project: the sidebar list (machine-global catalog
// merged with this project's export states), export-into-project, and the
// inspect/aggregate reads. `resolve(req)` supplies the project's RtacService;
// `catalog` is the shared AcRTAC database catalog its refresh re-queries.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function rtacRoutes(resolve, catalog) {
  const router = Router({ mergeParams: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 5000 },
  });

  // Sidebar list: the RTAC exports in THIS project, with their states.
  router.get('/', async (req, res) => {
    res.json((await resolve(req)).list());
  });

  // The database browser: the machine-global catalog, flagged with what is
  // already here, plus the last database-list error (null when healthy).
  router.get('/available', async (req, res) => {
    res.json((await resolve(req)).available());
  });

  // (Re-)query the database list — the browser's refresh button.
  router.post('/refresh', async (req, res) => {
    await catalog.refresh();
    res.json((await resolve(req)).available());
  });

  // The no-database path: an exported folder uploaded from disk. Multer
  // basenames filenames, so the folder-relative paths travel in a parallel
  // JSON field, index-aligned with the files.
  router.post('/upload', upload.array('files'), async (req, res) => {
    if (!req.files?.length) throw httpError(400, 'multipart field "files" required');
    let paths;
    try {
      paths = JSON.parse(req.body?.paths ?? '');
    } catch {
      paths = null;
    }
    if (!Array.isArray(paths) || paths.length !== req.files.length) {
      throw httpError(400, 'field "paths" must list one folder-relative path per file');
    }
    const service = await resolve(req);
    res.status(201).json(await service.uploadFolder(
      req.files.map((file, index) => ({ path: paths[index], buffer: file.buffer })),
    ));
  });

  // Start (or retry) a database export into this project. 202 — completion
  // is polled via the list.
  router.post('/:name/export', async (req, res) => {
    res.status(202).json((await resolve(req)).startExport(req.params.name));
  });

  // Take an export out of this project.
  router.delete('/:name', async (req, res) => {
    await (await resolve(req)).remove(req.params.name);
    res.json({ ok: true });
  });

  // Rename an export in this project. The name is the canvas ref; the
  // service's onRenamed hook (wired by the project bundle) drags refs along.
  router.patch('/:name', async (req, res) => {
    res.json(await (await resolve(req)).rename(req.params.name, req.body?.name));
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
