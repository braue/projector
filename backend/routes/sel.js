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

  // The instruction manual for a device model, resolved from the index's
  // document list. `manual` is null when no index is loaded, no manual names
  // the model, or the PDF itself is not on this machine — the caller hides
  // the affordance rather than erroring.
  router.get('/manual', async (req, res) => {
    const manual = fullText.manualFor(requireQuery(req, 'model'));
    const present = manual
      ? await library.filePath(manual.path).then(() => true, () => false)
      : false;
    res.json({ manual: present ? manual : null });
  });

  // The manual itself, streamed inline so it renders in a browser tab.
  router.get('/manual/file', async (req, res) => {
    const model = requireQuery(req, 'model');
    const manual = fullText.manualFor(model);
    if (!manual) throw httpError(404, `no instruction manual indexed for ${model}`);
    res.sendFile(await library.filePath(manual.path));
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
