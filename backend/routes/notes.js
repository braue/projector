// Notes surface for one project: CRUD plus wholesale text replacement.
// `resolve(req)` supplies the project's NotesService.

import { Router } from 'express';

function noteRoutes(resolve) {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    res.json({ notes: await (await resolve(req)).list() });
  });

  router.post('/', async (req, res) => {
    res.status(201).json(await (await resolve(req)).create(req.body?.name));
  });

  router.patch('/:id', async (req, res) => {
    res.json(await (await resolve(req)).rename(req.params.id, req.body?.name));
  });

  router.put('/:id/text', async (req, res) => {
    res.json(await (await resolve(req)).setText(req.params.id, req.body?.text));
  });

  router.delete('/:id', async (req, res) => {
    await (await resolve(req)).remove(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

export { noteRoutes };
