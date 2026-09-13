// Tiny fs helpers shared across the stores.

import { cp, stat } from 'node:fs/promises';
import path from 'node:path';

/** stat(), or null when the path does not exist; other errors still throw. */
async function statOrNull(absolute) {
  try {
    return await stat(absolute);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Copy a store entry (a file or a project folder) somewhere else, leaving the
 * store's bookkeeping behind — never drag `.versions/`, `.committed/` and
 * friends into a tool's run or a placed copy.
 */
async function copyEntry(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => !path.basename(source).startsWith('.'),
  });
}

/** Characters that cannot land in a file name (Windows-invalid set, which
 *  also covers the path separators). */
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/g;

export { copyEntry, statOrNull, INVALID_NAME };
