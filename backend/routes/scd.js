// SCD upload surface: the shared upload router, with a higher cap — SCL
// substation files run larger than relay databases.

import { uploadSourceRoutes } from './uploads.js';

const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

function scdRoutes(resolve) {
  return uploadSourceRoutes(resolve, { maxBytes: MAX_UPLOAD_BYTES });
}

export { scdRoutes };
