// Compare surface for one project: two same-type sources, addressed as
// ?originalType=rdb&original=<ref>&updatedType=rdb&updated=<ref>.
// `resolve(req)` supplies the project's CompareService.

import { Router } from 'express';

import { requireQuery } from '../lib/http.js';
import { compareReportPdf } from '../lib/report.js';

function compareRoutes(resolve) {
  const router = Router({ mergeParams: true });

  const pair = (req) => ({
    a: { type: requireQuery(req, 'originalType'), ref: requireQuery(req, 'original') },
    b: { type: requireQuery(req, 'updatedType'), ref: requireQuery(req, 'updated') },
  });

  // Union tree with per-item status tint.
  router.get('/tree', async (req, res) => {
    const { a, b } = pair(req);
    res.json(await (await resolve(req)).compare(a, b));
  });

  // Structured diff of one item.
  router.get('/item', async (req, res) => {
    const { a, b } = pair(req);
    res.json(await (await resolve(req)).compareItem(a, b, requireQuery(req, 'file')));
  });

  // Differences-only PDF report of the whole comparison, as a download.
  router.get('/report', async (req, res) => {
    const { a, b } = pair(req);
    const report = await (await resolve(req)).report(a, b);
    const bytes = await compareReportPdf(report, { project: req.params.project, type: a.type });
    const safe = (label) => label.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="compare_${safe(report.original)}_vs_${safe(report.updated)}.pdf"`,
    );
    res.send(Buffer.from(bytes));
  });

  return router;
}

export { compareRoutes };
