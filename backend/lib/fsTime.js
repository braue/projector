// When a folder came into being, for the "Uploaded"/"Added" dates the sidebar
// shows on hover. Shared so the two source families answer the question the
// same way — they sit next to each other in one list, and a date that means
// something different per row is worse than no date.

import { stat } from 'node:fs/promises';

/**
 * A folder's creation time in epoch ms, or null when it cannot be read.
 *
 * Birth time, not mtime: writing anything inside a folder moves its mtime, so
 * an antivirus touch or a re-parse would silently redate an artifact the user
 * has not touched. Filesystems without a creation time report 0, hence the
 * fall back to mtime — and null, never 0, when there is no answer at all, so
 * "unknown" cannot render as 1970.
 */
async function folderBirthTime(dir) {
  try {
    const info = await stat(dir);
    return Math.round(info.birthtimeMs || info.mtimeMs) || null;
  } catch {
    return null;
  }
}

export { folderBirthTime };
