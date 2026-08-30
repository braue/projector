// The drawing-revision rule, stated once: an SEL drawing stem is its base
// number (`i7182`) plus a revision suffix in either of SEL's naming forms
// (`i7182.C`, `i7074d`). SEL revises drawings in place under the same base,
// so two stems with one base are the same drawing at different revisions,
// latest wins. Both the corpus fetcher (tools/fetch-sel-dwgs.mjs) and the
// dwgen service consume this — if they disagree, a fetched DWG gets filed
// under a name the runtime lookup no longer recognizes.

import { readdir } from 'node:fs/promises';

function drawingBase(stem) {
  return /^i\d+/i.exec(stem)?.[0].toLowerCase() ?? String(stem).toLowerCase();
}

/** The latest .dwg revision of `stem`'s drawing in deviceDir, or null. */
async function latestDwgRevision(deviceDir, stem) {
  const base = drawingBase(stem);
  const revs = (await readdir(deviceDir))
    .filter((f) => /\.dwg$/i.test(f))
    .map((f) => f.replace(/\.dwg$/i, ''))
    .filter((s) => drawingBase(s) === base);
  return revs.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).pop() ?? null;
}

export { drawingBase, latestDwgRevision };
