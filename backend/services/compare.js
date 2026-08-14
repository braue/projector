// Generic settings compare — two sources of the SAME type, for any type that
// can enumerate its inspect items. Per-type adapters (injected from index.js)
// supply { label, entries: [{ path, name, item, signature }] }:
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

class CompareService {
  // adapters: type -> async (ref) => { label, entries }
  constructor({ adapters }) {
    this.adapters = adapters;
  }

  async #load({ type, ref }) {
    const adapter = this.adapters[type];
    if (!adapter) throw httpError(400, `unsupported compare type: ${type}`);
    return adapter(ref);
  }

  async #pair(a, b) {
    if (a.type !== b.type) {
      throw httpError(400, 'compare requires two sources of the same type');
    }
    return Promise.all([this.#load(a), this.#load(b)]);
  }

  // The shared first half of compare() and report(): load both sides, sign,
  // derive per-path status and the summary tally. ONE home, so the tree
  // legend and the PDF header can never disagree about the same pair.
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
      tree: foldTree(nodes),
    };
  }

  // Report data: every non-unchanged item with its full diff, path-sorted —
  // the PDF export renders this and nothing else (differences only).
  async report(a, b) {
    const { original, updated, status, summary } = await this.#status(a, b);
    const byPath = (entries) => new Map(entries.map((entry) => [entry.path, entry]));
    const originals = byPath(original.entries);
    const updates = byPath(updated.entries);

    const items = [...status.entries()]
      .filter(([, value]) => value !== STATUS.UNCHANGED)
      .sort(([a2], [b2]) => a2.localeCompare(b2))
      .map(([path, value]) => ({
        path,
        status: value,
        diff: value === STATUS.EDITED
          ? diffItems(originals.get(path)?.item ?? null, updates.get(path)?.item ?? null)
          : null,
        // Added/removed files render their FULL content in the report — the
        // reader must see what appeared or vanished, not just that it did.
        item: value === STATUS.ADDED
          ? updates.get(path)?.item ?? null
          : value === STATUS.REMOVED
            ? originals.get(path)?.item ?? null
            : null,
      }));

    return { original: original.label, updated: updated.label, summary, items };
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
