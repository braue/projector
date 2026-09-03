// The project surface — everything is scoped to /api/projects/:project/...
// A project bundles its file tree, the artifacts layered over it, and
// compare/search; this router owns project CRUD and mounts each sub-surface
// with a per-request bundle resolver.

import { Router } from 'express';

import { artifactRoutes } from './artifacts.js';
import { compareRoutes } from './compare.js';
import { fileRoutes } from './files.js';
import { searchRoutes } from './search.js';

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
  scoped.use('/files', fileRoutes(bundle));
  scoped.use('/artifacts', artifactRoutes(async (req) => (await bundle(req)).artifacts, catalog));
  scoped.use('/compare', compareRoutes(async (req) => (await bundle(req)).compare));
  scoped.use('/search', searchRoutes(async (req) => (await bundle(req)).search));
  router.use('/:project', scoped);

  return router;
}

export { projectRoutes };
