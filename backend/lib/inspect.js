// The inspect-item shapes in one place. Every source service builds the same
// two structures — tree section nodes and items carrying settings + tabular
// pages — and the frontend renders them generically (FileTree reads
// name/kindLabel/category, Preview renders settings and pages). These
// builders are the single home of the shape; services supply only content.

/** One tree entry for a section of a source. */
function sectionNode({ name, path, kindLabel, category, pointCount = null }) {
  return { type: 'item', name, path, kindLabel, category, pointCount };
}

/** One tabular sheet: positional rows zipped into column-keyed records. */
function tablePage(name, columns, rows) {
  return {
    name,
    columns,
    rows: rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i] ?? '']))),
  };
}

/** An inspect item; overrides carry the section's content. */
function sectionItem(kind, overrides) {
  return {
    kind,
    category: 'connection',
    schema: null,
    settings: {},
    points: [],
    pointCount: 0,
    pages: [],
    ...overrides,
  };
}

/** Verbatim boolean for settings/pages — the review UI shows what is set. */
function flag(value) {
  return value ? 'true' : 'false';
}

export { flag, sectionItem, sectionNode, tablePage };
