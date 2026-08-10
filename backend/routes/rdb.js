// RDB upload surface: the shared upload router plus the generated panel
// drawing PNGs.

import { requireQuery } from '../lib/http.js';
import { uploadSourceRoutes } from './uploads.js';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function rdbRoutes(resolve) {
  const router = uploadSourceRoutes(resolve, { maxBytes: MAX_UPLOAD_BYTES });

  // Generated front/rear panel drawing PNG for one profile.
  router.get('/drawing', async (req, res, next) => {
    const service = await resolve(req);
    const file = service.drawingPath(requireQuery(req, 'ref'), requireQuery(req, 'view'));
    res.sendFile(file, (err) => {
      if (err) next(err);
    });
  });

  return router;
}

export { rdbRoutes };
