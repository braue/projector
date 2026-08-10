// The project surface — everything is scoped to /api/projects/:project/...
// A project bundles its own sources (rtac exports, rdb/scd/sw uploads),
// canvas, and compare; this router owns project CRUD and mounts each
// sub-surface with a per-request bundle resolver.

import { Router } from 'express';

import { canvasRoutes } from './canvas.js';
import { compareRoutes } from './compare.js';
import { noteRoutes } from './notes.js';
import { rdbRoutes } from './rdb.js';
import { rtacRoutes } from './rtac.js';
import { scdRoutes } from './scd.js';
import { swRoutes } from './sw.js';

function projectRoutes(projects, catalog) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ projects: await projects.list() });
  });

  router.post('/', async (req, res) => {
    res.status(201).json(await projects.create(req.body?.name));
  });

  router.delete('/:project', async (req, res) => {
    await projects.remove(req.params.project);
    res.json({ ok: true });
  });

  router.patch('/:project', async (req, res) => {
    res.json(await projects.rename(req.params.project, req.body?.name));
  });

  const bundle = (req) => projects.bundle(req.params.project);
  const scoped = Router({ mergeParams: true });
  scoped.use('/rtac', rtacRoutes(async (req) => (await bundle(req)).rtac, catalog));
  scoped.use('/rdb', rdbRoutes(async (req) => (await bundle(req)).rdb));
  scoped.use('/scd', scdRoutes(async (req) => (await bundle(req)).scd));
  scoped.use('/sw', swRoutes(async (req) => (await bundle(req)).sw));
  scoped.use('/compare', compareRoutes(async (req) => (await bundle(req)).compare));
  scoped.use('/notes', noteRoutes(async (req) => (await bundle(req)).notes));
  scoped.use('/', canvasRoutes(async (req) => (await bundle(req)).canvas));
  router.use('/:project', scoped);

  return router;
}

export { projectRoutes };
