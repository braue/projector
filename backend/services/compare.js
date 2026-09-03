// Generic settings compare — two artifacts of the SAME kind, for any kind
// that can enumerate its inspect items. The injected loader resolves a ref
// to { kind, label, entries: [{ path, name, item, signature }] }:
//
//   signature decides added/removed/edited/unchanged. Every type signs the
//   whole canonical PARSED item — raw-XML noise the parser doesn't model
//   never flags a file (RTAC folds a raw hash back in only for items the
//   parser models nothing from; see services/rtac.js).
//
//   item is the shared inspect shape, so diffItems covers every type: flat
//   settings for RDB sections and SCD logical devices, plus points/pages/
//   logic source where the type has them.

import { compareSignatures, diffItems, STATUS } from '../lib/compare.js';
import { httpError } from '../lib/http.js';
import { itemSummary } from '../lib/inspect.js';
import { foldTree } from '../lib/tree.js';

function node(entry, status) {
  return {
    type: 'item',
    name: entry.name,
    path: entry.path,
    ...itemSummary(entry.item),
    status,
  };
}

function signatures(entries) {
  return new Map(entries.map((entry) => [entry.path, entry.signature]));
}

// A folder wears its contents' status: wholly added or wholly removed reads
// as that, any other mix containing a change reads edited. Whole-file
// compares fold one folder per profile (an SCD's IEDs) and those folders
// start closed, so a folder that says nothing would hide everything.
function rollUpStatus(nodes) {
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    rollUpStatus(node.children);
    const seen = new Set(node.children.map((child) => child.status ?? STATUS.UNCHANGED));
    node.status = seen.size === 1 ? [...seen][0] : STATUS.EDITED;
  }
  return nodes;
}

class CompareService {
  // load: async (ref) => { kind, label, entries }
  constructor({ load }) {
    this.load = load;
  }

  async #pair(a, b) {
    const [original, updated] = await Promise.all([this.load(a), this.load(b)]);
    if (original.kind !== updated.kind) {
      throw httpError(400, 'compare requires two artifacts of the same kind');
    }
    return [original, updated];
  }

  // Load both sides, sign, derive per-path status and the summary tally.
  async #status(a, b) {
    const [original, updated] = await this.#pair(a, b);
    const status = compareSignatures(signatures(original.entries), signatures(updated.entries));
    const summary = { added: 0, removed: 0, edited: 0, unchanged: 0 };
    for (const value of status.values()) summary[value] += 1;
    return { original, updated, status, summary };
  }

  async compare(a, b) {
    const { original, updated, status, summary } = await this.#status(a, b);

    const nodes = [
      ...updated.entries.map((entry) => node(entry, status.get(entry.path))),
      ...original.entries
        .filter((entry) => status.get(entry.path) === STATUS.REMOVED)
        .map((entry) => node(entry, STATUS.REMOVED)),
    ];

    return {
      original: { name: original.label },
      updated: { name: updated.label },
      summary,
      tree: rollUpStatus(foldTree(nodes)),
    };
  }

  async compareItem(a, b, path) {
    const [original, updated] = await this.#pair(a, b);
    const originalEntry = original.entries.find((entry) => entry.path === path) ?? null;
    const updatedEntry = updated.entries.find((entry) => entry.path === path) ?? null;
    if (!originalEntry && !updatedEntry) {
      throw httpError(404, `no such item: ${path}`);
    }

    const status =
      !originalEntry ? STATUS.ADDED
      : !updatedEntry ? STATUS.REMOVED
      : originalEntry.signature === updatedEntry.signature ? STATUS.UNCHANGED
      : STATUS.EDITED;

    return {
      file: path,
      status,
      original: originalEntry?.item ?? null,
      updated: updatedEntry?.item ?? null,
      diff: diffItems(originalEntry?.item ?? null, updatedEntry?.item ?? null),
    };
  }
}

export { CompareService };
