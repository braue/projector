// The machine-global todo list: read it, or replace it wholesale.

import { Router } from 'express';

function todoRoutes(todos) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ todos: await todos.list() });
  });

  router.put('/', async (req, res) => {
    res.json({ todos: await todos.replace(req.body?.todos) });
  });

  return router;
}

export { todoRoutes };
