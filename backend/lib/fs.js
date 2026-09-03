// Tiny fs helpers shared across the stores.

import { stat } from 'node:fs/promises';

/** stat(), or null when the path does not exist; other errors still throw. */
async function statOrNull(absolute) {
  try {
    return await stat(absolute);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Characters that cannot land in a file name (Windows-invalid set, which
 *  also covers the path separators). */
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/g;

export { statOrNull, INVALID_NAME };
