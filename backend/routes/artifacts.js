// Artifact surface for one project: inspect (tree/item/profiles), aggregate,
// panel drawings, and the RTAC intake (AcRTAC catalog, export-into-folder,
// exported-folder upload). Refs and paths contain slashes and "::", so they
// travel as ?ref= / ?path= / body fields, never as route params.
// `resolve(req)` supplies the project's { artifacts } bundle slice.

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_RTAC_UPLOAD_BYTES = 64 * 1024 * 1024;

function artifactRoutes(resolve, catalog) {
  const router = Router({ mergeParams: true });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_RTAC_UPLOAD_BYTES, files: 5000 },
  });

  // File-tree sidebar for one artifact (or one profile of one).
  router.get('/tree', async (req, res) => {
    res.json(await (await resolve(req)).tree(requireQuery(req, 'ref')));
  });

  // Preview pane: one item's full parsed body.
  router.get('/item', async (req, res) => {
    res.json(await (await resolve(req)).item(requireQuery(req, 'ref'), requireQuery(req, 'file')));
  });

  // The profiles inside one artifact (RDB relays, SCD IEDs, the one switch) —
  // fetched when the artifact is opened, so listing the tree parses nothing.
  router.get('/profiles', async (req, res) => {
    res.json({ profiles: await (await resolve(req)).profiles(requireQuery(req, 'path')) });
  });

  // Aggregate a list of setting names across a range of objects (RTAC).
  // Body: { path, terms: string[], files?: string[] }.
  router.post('/aggregate', async (req, res) => {
    const { path: treePath, terms, files } = req.body ?? {};
    if (typeof treePath !== 'string' || !treePath) throw httpError(400, 'path required');
    res.json(await (await resolve(req)).aggregate(treePath, {
      terms: Array.isArray(terms) ? terms : [],
      files: Array.isArray(files) ? files : [],
    }));
  });

  // One generated RDB panel drawing PNG.
  router.get('/drawing', async (req, res) => {
    const artifacts = await resolve(req);
    const kind = artifacts.kinds.rdb;
    if (!kind) throw httpError(404, 'no drawings here');
    const file = await kind.drawingPath(requireQuery(req, 'ref'), requireQuery(req, 'view'));
    res.sendFile(file);
  });

  // --- RTAC intake -----------------------------------------------------------

  // The database browser: the machine-global AcRTAC catalog.
  router.get('/rtac/available', async (req, res) => {
    res.json((await resolve(req)).available());
  });

  // (Re-)query the database list — the browser's refresh button.
  router.post('/rtac/refresh', async (req, res) => {
    await catalog.refresh();
    res.json((await resolve(req)).available());
  });

  // Download a DATABASE project into a folder of the tree, as a new version
  // if the export is already there. Body: { dir, name, note, into? } —
  // `into` names an existing .rtac entry to version onto regardless of the
  // database name. 202 — completion is polled via /rtac/status.
  router.post('/rtac/export', async (req, res) => {
    const { dir = '', name, note, into } = req.body ?? {};
    if (typeof name !== 'string' || !name) throw httpError(400, 'name required');
    res.status(202).json((await resolve(req)).startExport(
      String(dir),
      name,
      note,
      typeof into === 'string' && into ? into : null,
    ));
  });

  // In-flight and failed exports, for the sidebar overlay.
  router.get('/rtac/status', async (req, res) => {
    res.json({ exports: (await resolve(req)).exportStatus() });
  });

  // Dismiss one failed export from the overlay.
  router.delete('/rtac/status', async (req, res) => {
    (await resolve(req)).dismissExportError(requireQuery(req, 'path'));
    res.json({ ok: true });
  });

  // The no-database path: an exported folder uploaded from disk. Multer
  // basenames filenames, so the folder-relative paths travel in a parallel
  // JSON field, index-aligned with the files. "dir" and "note" ride the
  // same form.
  router.post('/rtac/upload', upload.array('files'), async (req, res) => {
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
    const artifacts = await resolve(req);
    res.status(201).json(await artifacts.uploadFolder(
      String(req.body?.dir ?? ''),
      req.files.map((file, index) => ({ path: paths[index], buffer: file.buffer })),
      req.body?.note,
    ));
  });

  return router;
}

export { artifactRoutes };
