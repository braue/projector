// Machine settings: read them all, or PATCH-merge some (null removes a key).

import { Router } from 'express';

function settingsRoutes(settings) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await settings.get());
  });

  router.patch('/', async (req, res) => {
    res.json(await settings.update(req.body ?? {}));
  });

  return router;
}

export { settingsRoutes };
