// The app's background work (services/jobs.js) and the event stream that
// carries it — and every other "something changed" — to the window.
//
//   GET    /api/events        Server-Sent Events (lib/events.js)
//   GET    /api/jobs/:id      one job in full, result included
//   POST   /api/jobs/:id/retry  start a failed job again → { job }
//   DELETE /api/jobs/:id      forget a finished job (the popover's ✕)
//   DELETE /api/jobs          forget every finished job

import { Router } from 'express';

import { JobRegistry } from '../services/jobs.js';

function eventRoutes(events, jobs) {
  const router = Router();
  router.get('/', events.handler(() => [['jobs', { jobs: jobs.list().map(JobRegistry.summary) }]]));
  return router;
}

function jobRoutes(jobs) {
  const router = Router();

  router.get('/:id', (req, res) => {
    res.json(jobs.get(req.params.id));
  });

  router.post('/:id/retry', async (req, res) => {
    res.status(202).json({ job: await jobs.retry(req.params.id) });
  });

  router.delete('/:id', (req, res) => {
    jobs.remove(req.params.id);
    res.json({ ok: true });
  });

  router.delete('/', (_req, res) => {
    jobs.clearFinished();
    res.json({ ok: true });
  });

  return router;
}

export { eventRoutes, jobRoutes };
