// SW upload surface: the shared upload router. Switch settings exports are
// small XML files — the default cap is generous.

import { uploadSourceRoutes } from './uploads.js';

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

function swRoutes(resolve) {
  return uploadSourceRoutes(resolve, { maxBytes: MAX_UPLOAD_BYTES });
}

export { swRoutes };
