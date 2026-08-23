// The SEL document library: full-text search across every page of every PDF,
// and opening one in the OS PDF viewer at a given page.
//
// Machine-global, like the AcRTAC catalog — the library is a folder of PDFs on
// this machine, not project state, so these routes are not project-scoped.

import { Router } from 'express';

import { httpError, requireQuery } from '../lib/http.js';

function selRoutes(library, fullText) {
  const router = Router();

  router.get('/status', async (_req, res) => {
    res.json({ ...(await library.status()), fullText: fullText.status() });
  });

  // Full text across every page of every PDF. Absent when no index has been
  // built; the caller shows nothing rather than an error.
  router.get('/text', async (req, res) => {
    res.json(fullText.search(requireQuery(req, 'q')));
  });

  router.post('/open', async (req, res) => {
    const relPath = req.body?.path;
    if (typeof relPath !== 'string') throw httpError(400, 'body field "path" required');
    await library.open(relPath, req.body?.page ?? null);
    res.json({ ok: true });
  });

  return router;
}

export { selRoutes };
