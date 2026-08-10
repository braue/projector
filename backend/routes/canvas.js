// Canvas surface for one project: devices + ghosts + inferred links,
// computed fresh per read, plus the placements and manual links the user
// draws. `resolve(req)` supplies the project's CanvasService.

import { Router } from 'express';

function canvasRoutes(resolve) {
  const router = Router({ mergeParams: true });

  router.get('/graph', async (req, res) => {
    res.json(await (await resolve(req)).graph());
  });

  router.post('/devices', async (req, res) => {
    res.status(201).json(await (await resolve(req)).addDevice(req.body ?? {}));
  });

  router.patch('/devices/:id', async (req, res) => {
    res.json(await (await resolve(req)).moveDevice(req.params.id, req.body ?? {}));
  });

  router.delete('/devices/:id', async (req, res) => {
    await (await resolve(req)).removeDevice(req.params.id);
    res.json({ ok: true });
  });

  // SCD augmentation: attach a second document to a placed device.
  router.post('/devices/:id/scd', async (req, res) => {
    res.json(await (await resolve(req)).attachScd(req.params.id, req.body?.ref));
  });

  router.delete('/devices/:id/scd', async (req, res) => {
    res.json(await (await resolve(req)).detachScd(req.params.id));
  });

  // Manual links: connections the user drew (ethernet port runs, serial pairs).
  router.post('/links', async (req, res) => {
    res.status(201).json(await (await resolve(req)).addManualLink(req.body ?? {}));
  });

  router.delete('/links/:id', async (req, res) => {
    await (await resolve(req)).removeManualLink(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

export { canvasRoutes };
