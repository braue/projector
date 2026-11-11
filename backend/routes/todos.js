// The machine-global todo board: read it, or change one card. Every write
// answers with the whole board.

import { Router } from '../lib/router.js';

function todoRoutes(todos) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json({ todos: await todos.list() });
  });

  router.post('/', async (req, res) => {
    res.json({ todos: await todos.create(req.body) });
  });

  router.post('/clear-done', async (_req, res) => {
    res.json({ todos: await todos.clearDone() });
  });

  router.patch('/:id', async (req, res) => {
    res.json({ todos: await todos.update(req.params.id, req.body) });
  });

  router.delete('/:id', async (req, res) => {
    res.json({ todos: await todos.remove(req.params.id) });
  });

  router.post('/:id/move', async (req, res) => {
    const { status, before = null } = req.body ?? {};
    res.json({ todos: await todos.move(req.params.id, status, before) });
  });

  return router;
}

export { todoRoutes };
