// Workspace + canvas surface.

import { Router } from 'express';

function workspaceRoutes(service) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ workspaces: await service.list() });
  });

  router.post('/', async (req, res) => {
    res.status(201).json(await service.create(req.body?.name));
  });

  router.delete('/:name', async (req, res) => {
    await service.remove(req.params.name);
    res.json({ ok: true });
  });

  // The canvas: devices + ghosts + inferred links, computed fresh per read.
  router.get('/:name/graph', async (req, res) => {
    res.json(await service.graph(req.params.name));
  });

  router.post('/:name/devices', async (req, res) => {
    res.status(201).json(await service.addDevice(req.params.name, req.body ?? {}));
  });

  router.patch('/:name/devices/:id', async (req, res) => {
    res.json(await service.moveDevice(req.params.name, req.params.id, req.body ?? {}));
  });

  router.delete('/:name/devices/:id', async (req, res) => {
    await service.removeDevice(req.params.name, req.params.id);
    res.json({ ok: true });
  });

  // SCD augmentation: attach a second document to a placed device.
  router.post('/:name/devices/:id/scd', async (req, res) => {
    res.json(await service.attachScd(req.params.name, req.params.id, req.body?.ref));
  });

  router.delete('/:name/devices/:id/scd', async (req, res) => {
    res.json(await service.detachScd(req.params.name, req.params.id));
  });

  return router;
}

export { workspaceRoutes };
