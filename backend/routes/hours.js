// Billable hours: read them all, or set one cell — a project's hours on a
// day, or its budget.

import { Router } from 'express';

function hourRoutes(hours) {
  const router = Router();

  router.get('/', async (_req, res) => {
    res.json(await hours.get());
  });

  router.put('/day', async (req, res) => {
    const { date, project, hours: value } = req.body ?? {};
    res.json(await hours.setDay(date, project, value));
  });

  router.put('/budget', async (req, res) => {
    const { project, hours: value } = req.body ?? {};
    res.json(await hours.setBudget(project, value));
  });

  return router;
}

export { hourRoutes };
