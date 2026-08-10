// Project comparison — the reason the parsed model exists.
//
// Two levels, deliberately aligned:
//
//   File status (added / removed / edited / unchanged) comes from a canonical
//   signature of the PARSED item — raw-XML noise the parser does not model
//   (formatting shifts, ControllerPOU/CFC blob internals, export metadata)
//   never flags a file. The flip side is a deliberate user decision: a change
//   only the raw bytes can see reads as unchanged — only modeled settings
//   changes matter.
//
//   The detailed diff of one item works on the same parsed model: settings
//   keys, points keyed by page + tag name, page tables, logic source.
//   Anything the model carries that changed but isn't one of those shows up
//   by field name, so a new extractor's output is at worst reported coarsely,
//   never dropped.

import { rowText } from './inspect.js';

// --- file status -------------------------------------------------------------

const STATUS = {
  ADDED: 'added',
  REMOVED: 'removed',
  EDITED: 'edited',
  UNCHANGED: 'unchanged',
};

// Canonical change-signature of any parsed value: objects key-sorted at
// every depth (key order comes from line order in the artifact, and a
// reordered file is not an edit), arrays kept in order, then serialized.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function modelSignature(value) {
  return JSON.stringify(canonical(value));
}

// Merge two projects' per-file signature maps into { file -> status }.
function compareSignatures(originalSignatures, updatedSignatures) {
  const status = new Map();
  for (const [file, signature] of updatedSignatures) {
    const before = originalSignatures.get(file);
    if (before === undefined) status.set(file, STATUS.ADDED);
    else status.set(file, before === signature ? STATUS.UNCHANGED : STATUS.EDITED);
  }
  for (const file of originalSignatures.keys()) {
    if (!updatedSignatures.has(file)) status.set(file, STATUS.REMOVED);
  }
  return status;
}

// --- item diff ---------------------------------------------------------------

function diffSettings(a = {}, b = {}) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const inA = key in a;
    const inB = key in b;
    if (inA && !inB) out.push({ key, original: a[key], updated: null, status: 'removed' });
    else if (!inA && inB) out.push({ key, original: null, updated: b[key], status: 'added' });
    else if (a[key] !== b[key]) out.push({ key, original: a[key], updated: b[key], status: 'changed' });
  }
  return out;
}

// A point's identity within an item: its page plus its tag name (falling back
// to its position for pages whose rows carry no name).
function pointKey(point, index) {
  return `${point.page}\u0000${point.tagName ?? `#${index}`}`;
}

function indexPoints(points) {
  const map = new Map();
  points.forEach((point, index) => map.set(pointKey(point, index), point));
  return map;
}

function diffPoints(aPoints = [], bPoints = []) {
  const a = indexPoints(aPoints);
  const b = indexPoints(bPoints);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, bPoint] of b) {
    const aPoint = a.get(key);
    if (!aPoint) {
      added.push({ page: bPoint.page, tag: bPoint.tagName });
      continue;
    }
    const fields = rowFields(aPoint.raw, bPoint.raw);
    if (fields.length) changed.push({ page: bPoint.page, tag: bPoint.tagName, fields });
  }
  for (const [key, aPoint] of a) {
    if (!b.has(key)) removed.push({ page: aPoint.page, tag: aPoint.tagName });
  }

  return { added, removed, changed };
}

// A generic page's rows, each labeled by its first-column value — these
// tables lead with a name-ish column. An empty lead cell falls back to the
// first non-empty cell (content identity), then to the row's position;
// duplicates get an ordinal.
function pageRows(page) {
  const first = page.columns?.[0];
  const seen = new Map();
  return page.rows.map((row, index) => {
    const base = (first && row[first])
      || (page.columns ?? []).map((column) => row[column]).find((value) => value)
      || `#${index + 1}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return { label: ordinal > 1 ? `${base} (${ordinal})` : base, row };
  });
}

function rowFields(aRow, bRow) {
  const fields = [];
  for (const column of new Set([...Object.keys(aRow), ...Object.keys(bRow)])) {
    const original = aRow[column] ?? null;
    const updated = bRow[column] ?? null;
    if (original !== updated) fields.push({ column, original, updated });
  }
  return fields;
}

// Row-level diff of one generic page. Row identity is CONTENT-first, so the
// diff is row-number agnostic: identical rows pair off wherever they sit (a
// table shifted down a row is not N edits). Leftovers then match by
// lead-column label, and what remains pairs positionally — with pairs
// sharing no column value reading as removed + added.
//
// Every reported row carries its WHOLE rendered text (rowText) — changed rows
// on both sides, added/removed rows in full — because a row named only by its
// lead cell or position is unreadable in review (Tag Processor especially).
function diffPageRows(aPage, bPage) {
  const aRows = pageRows(aPage);
  const bRows = pageRows(bPage);
  const matchedA = new Set();
  const unmatchedB = [];
  const changed = [];
  const added = [];
  const removed = [];

  // 1. Exact-content multiset match, position-blind.
  const byContent = new Map();
  for (const a of aRows) {
    const key = modelSignature(a.row);
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(a);
  }
  const labelCandidatesB = [];
  for (const b of bRows) {
    const bucket = byContent.get(modelSignature(b.row));
    if (bucket?.length) matchedA.add(bucket.pop());
    else labelCandidatesB.push(b);
  }

  // 2. Lead-column label match over what content couldn't pair.
  const byLabel = new Map();
  for (const a of aRows) {
    if (!matchedA.has(a) && !byLabel.has(a.label)) byLabel.set(a.label, a);
  }
  for (const b of labelCandidatesB) {
    const a = byLabel.get(b.label);
    if (a && !matchedA.has(a)) {
      matchedA.add(a);
      if (rowFields(a.row, b.row).length) {
        changed.push({ row: b.label, original: rowText(a.row), updated: rowText(b.row) });
      }
    } else {
      unmatchedB.push(b);
    }
  }

  const unmatchedA = aRows.filter((a) => !matchedA.has(a));
  const pairs = Math.min(unmatchedA.length, unmatchedB.length);
  for (let i = 0; i < pairs; i += 1) {
    const fields = rowFields(unmatchedA[i].row, unmatchedB[i].row);
    // Positionally paired rows that share NOTHING are a deletion plus an
    // unrelated addition — reporting them as one "changed" row would hide
    // the removal entirely.
    const columns = new Set([...Object.keys(unmatchedA[i].row), ...Object.keys(unmatchedB[i].row)]).size;
    if (fields.length >= columns) {
      removed.push(rowText(unmatchedA[i].row));
      added.push(rowText(unmatchedB[i].row));
    } else if (fields.length) {
      changed.push({
        row: unmatchedB[i].label,
        original: rowText(unmatchedA[i].row),
        updated: rowText(unmatchedB[i].row),
      });
    }
  }

  return {
    added: [...added, ...unmatchedB.slice(pairs).map((b) => rowText(b.row))],
    removed: [...removed, ...unmatchedA.slice(pairs).map((a) => rowText(a.row))],
    changed,
  };
}

function diffPages(aPages = [], bPages = []) {
  const byName = (pages) => new Map(pages.map((page) => [page.name, page]));
  const a = byName(aPages);
  const b = byName(bPages);
  const out = [];
  for (const [name, bPage] of b) {
    const aPage = a.get(name);
    if (!aPage) out.push({ name, status: 'added', rows: bPage.rows.length });
    else if (JSON.stringify(aPage.rows) !== JSON.stringify(bPage.rows)) {
      const rowDiff = diffPageRows(aPage, bPage);
      const hasDetail = rowDiff.added.length || rowDiff.removed.length || rowDiff.changed.length;
      // Same rows in a different order (or key-order noise): state it as data
      // rather than leaving the UI to infer it from empty detail arrays.
      out.push(hasDetail
        ? { name, status: 'changed', rows: bPage.rows.length, ...rowDiff }
        : { name, status: 'reordered', rows: bPage.rows.length });
    }
  }
  for (const [name, aPage] of a) {
    if (!b.has(name)) out.push({ name, status: 'removed', rows: aPage.rows.length });
  }
  return out;
}

function codeText(item) {
  if (!item?.code) return null;
  const parts = [item.code.interface, item.code.implementation].filter(
    (part) => part != null && part !== '',
  );
  return parts.length ? parts.join('\n') : null;
}

// Model fields already covered by the dedicated diffs above, or derived from
// them, or identity — everything else that differs is reported by name.
const COVERED_FIELDS = new Set([
  'id', 'file', 'settings', 'points', 'pointCount', 'pages', 'settingPages',
  'code', 'sharedMap', 'sharedMapRef', 'endpoint',
  'archivedContentHash', 'hasArchivedContent',
]);

function diffOtherFields(a = {}, b = {}) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (COVERED_FIELDS.has(key)) continue;
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) out.push(key);
  }
  return out;
}

// Graphical (CFC/LD) logic is only a fingerprint in the model — the diff can
// say THAT it changed, never what changed. Stated as its own result so the UI
// renders a sentence, not a raw hash field name.
function diffGraphicalLogic(original, updated) {
  const before = original?.archivedContentHash ?? null;
  const after = updated?.archivedContentHash ?? null;
  if (before === after) return null;
  if (before === null) return 'added';
  if (after === null) return 'removed';
  return 'changed';
}

// Full structured diff of one item across the two exports. Either side may be
// null (added / removed files).
function diffItems(original, updated) {
  const originalCode = codeText(original);
  const updatedCode = codeText(updated);

  return {
    settings: diffSettings(original?.settings, updated?.settings),
    points: diffPoints(
      [...(original?.points ?? []), ...(original?.sharedMap?.points ?? [])],
      [...(updated?.points ?? []), ...(updated?.sharedMap?.points ?? [])],
    ),
    pages: diffPages(original?.pages, updated?.pages),
    code:
      originalCode !== updatedCode
        ? { original: originalCode, updated: updatedCode }
        : null,
    graphicalLogic: diffGraphicalLogic(original, updated),
    otherFields: diffOtherFields(original ?? {}, updated ?? {}),
  };
}

export { STATUS, compareSignatures, diffItems, modelSignature };
