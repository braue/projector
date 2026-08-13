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

const NUMERIC_VALUE = /^-?\d+(?:\.\d+)?$/;

// How key-like `column` is within one side's rows: the share of rows it
// distinguishes. 0 for columns that are mostly empty or bare numbers — a
// numeric column that distinguishes every row (SolveOrder) is an execution
// ORDER that renumbers on insert, so keying on it mispairs rows exactly like
// row position does.
function keyness(rows, column) {
  if (!rows.length) return 1; // an empty side constrains nothing
  const values = rows.map((row) => row[column]).filter((value) => value != null && value !== '');
  if (values.length < rows.length / 2) return 0;
  if (values.every((value) => NUMERIC_VALUE.test(value))) return 0;
  return new Set(values).size / rows.length;
}

// The column that identifies rows across both sides of a page diff. Generic
// tables do NOT reliably lead with a name: the real Tag Processor leads with
// Build (True on every row) while the actual row identity is
// DestinationTagName. Take the column that is most key-like on BOTH sides,
// with near-ties going to the leftmost — several columns can be near-unique
// (destination tag, logging message) and the table leads with the designed
// identity among them.
function labelColumn(aPage, bPage, columns) {
  let best = columns[0];
  let bestScore = 0.5; // a column half of whose rows share labels is no key
  for (const column of columns) {
    const score = Math.min(keyness(aPage.rows, column), keyness(bPage.rows, column));
    if (score > bestScore + 0.05) {
      bestScore = score;
      best = column;
    }
  }
  return best;
}

// Order/index columns: bare numbers, nearly all distinct. AcSELerator
// renumbers these wholesale when a row is inserted or moved, so a difference
// confined to them is the row MOVING, not being edited — without this, one
// inserted Tag Processor row reads as an addition plus thirty bogus
// "changed" rows that differ only in SolveOrder.
function orderColumns(aPage, bPage, columns) {
  const orderlike = (rows, column) => {
    if (!rows.length) return true;
    const values = rows.map((row) => row[column]).filter((value) => value != null && value !== '');
    // A tiny table can't establish "this is an index" — treat its numbers as data.
    if (values.length < 3 || values.length < rows.length / 2) return false;
    if (!values.every((value) => NUMERIC_VALUE.test(value))) return false;
    return new Set(values).size >= values.length * 0.9;
  };
  return new Set(columns.filter(
    (column) => orderlike(aPage.rows, column) && orderlike(bPage.rows, column),
  ));
}

// A generic page's rows, each labeled by its identity-column value. An empty
// cell there falls back to the first non-empty cell (content identity), then
// to the row's position; duplicates get an ordinal.
function pageRows(page, label) {
  const seen = new Map();
  return page.rows.map((row, index) => {
    const base = (label && row[label])
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
// identity-column label, and what remains pairs positionally — with pairs
// sharing no column value reading as removed + added.
//
// Every reported row carries its WHOLE rendered text (rowText) — changed rows
// on both sides, added/removed rows in full — because a row named only by its
// lead cell or position is unreadable in review (Tag Processor especially).
function diffPageRows(aPage, bPage) {
  const columns = [...new Set([...(aPage.columns ?? []), ...(bPage.columns ?? [])])];
  const label = labelColumn(aPage, bPage, columns);
  const orderish = orderColumns(aPage, bPage, columns);
  // Field differences that mean the row was EDITED — order-column shifts are
  // the row moving, which the row-number-agnostic diff must not report.
  const editedFields = (a, b) => rowFields(a, b).filter((field) => !orderish.has(field.column));
  const aRows = pageRows(aPage, label);
  const bRows = pageRows(bPage, label);
  const matchedA = new Set();
  const unmatchedB = [];
  const changed = [];
  const added = [];
  const removed = [];

  // 1. Exact-content multiset match, position-blind. Order columns are left
  // out of the signature: a row whose only difference is its renumbered
  // SolveOrder is the SAME row that moved.
  const contentKey = (row) => modelSignature(
    Object.fromEntries(Object.entries(row).filter(([column]) => !orderish.has(column))),
  );
  const byContent = new Map();
  for (const a of aRows) {
    const key = contentKey(a.row);
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(a);
  }
  const labelCandidatesB = [];
  for (const b of bRows) {
    const bucket = byContent.get(contentKey(b.row));
    if (bucket?.length) matchedA.add(bucket.pop());
    else labelCandidatesB.push(b);
  }

  // 2. Identity-column label match over what content couldn't pair.
  const byLabel = new Map();
  for (const a of aRows) {
    if (!matchedA.has(a) && !byLabel.has(a.label)) byLabel.set(a.label, a);
  }
  for (const b of labelCandidatesB) {
    const a = byLabel.get(b.label);
    if (a && !matchedA.has(a)) {
      matchedA.add(a);
      if (editedFields(a.row, b.row).length) {
        changed.push({ row: b.label, original: rowText(a.row), updated: rowText(b.row) });
      }
    } else {
      unmatchedB.push(b);
    }
  }

  const unmatchedA = aRows.filter((a) => !matchedA.has(a));
  const pairs = Math.min(unmatchedA.length, unmatchedB.length);
  for (let i = 0; i < pairs; i += 1) {
    const fields = editedFields(unmatchedA[i].row, unmatchedB[i].row);
    // Positionally paired rows that share NOTHING are a deletion plus an
    // unrelated addition — reporting them as one "changed" row would hide
    // the removal entirely. (Order columns count on neither side of that
    // judgment.)
    const relevant = new Set(
      [...Object.keys(unmatchedA[i].row), ...Object.keys(unmatchedB[i].row)]
        .filter((column) => !orderish.has(column)),
    ).size;
    if (fields.length && fields.length >= relevant) {
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
