// Workspace + canvas surface.

import { Router } from 'express';

function workspaceRoutes(service) {
  const router = Router();

  const respond = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(err?.status ?? 500).json({ error: err?.message ?? String(err) });
    }
  };

  router.get('/', respond(async (_req, res) => {
    res.json({ workspaces: await service.list() });
  }));

  router.post('/', respond(async (req, res) => {
    res.status(201).json(await service.create(req.body?.name));
  }));

  router.delete('/:name', respond(async (req, res) => {
    await service.remove(req.params.name);
    res.json({ ok: true });
  }));

  // The canvas: devices + ghosts + inferred links, computed fresh per read.
  router.get('/:name/graph', respond(async (req, res) => {
    res.json(await service.graph(req.params.name));
  }));

  router.post('/:name/devices', respond(async (req, res) => {
    res.status(201).json(await service.addDevice(req.params.name, req.body ?? {}));
  }));

  router.patch('/:name/devices/:id', respond(async (req, res) => {
    res.json(await service.moveDevice(req.params.name, req.params.id, req.body ?? {}));
  }));

  router.delete('/:name/devices/:id', respond(async (req, res) => {
    await service.removeDevice(req.params.name, req.params.id);
    res.json({ ok: true });
  }));

  return router;
}

export { workspaceRoutes };
