// One worksheet as plain data, and its XML. Both the template builder
// (tools/build-fat-template.mjs) and the grafting code write sheets through
// writeSheet, so a sheet is always assembled in schema order with inline
// strings — no shared-string table to keep in step with the workbook's.
//
//   sheet = {
//     pane: { xSplit, ySplit } | null,       // frozen label columns / header rows
//     formatPr: '<sheetFormatPr …/>',
//     cols: [{ min, max, width, style? }],
//     rows: [{ r, attrs: {ht, hidden, …}, cells: [cell] }],
//     merges: [{ c1, r1, c2, r2 }],
//     validations: [{ attrs: {type, …}, formula1, ranges: [{c1, r1, c2, r2}] }],
//     tail: '<pageMargins …/><pageSetup …/><headerFooter>…'
//   }
//   cell = { col, s, kind: 'blank' | 'str' | 'num' | 'formula', value?, formula? }

import {
  attrsOf, block, cellText, colLetters, elements, escapeXml, parseRange, rangeRef, unescapeXml,
} from './ooxml.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" '
  + 'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"';

// Row attributes worth carrying (spans is recomputed; the rest is layout).
const ROW_ATTRS = ['s', 'customFormat', 'ht', 'hidden', 'customHeight', 'thickTop', 'thickBot', 'x14ac:dyDescent'];

function attrString(attrs, order) {
  return order
    .filter((key) => attrs[key] != null && attrs[key] !== '')
    .map((key) => ` ${key}="${escapeXml(attrs[key])}"`)
    .join('');
}

function cellXml(rowNumber, cell) {
  const ref = `${colLetters(cell.col)}${rowNumber}`;
  const s = cell.s ? ` s="${cell.s}"` : '';
  switch (cell.kind) {
    case 'str': {
      const text = String(cell.value ?? '');
      if (!text) return `<c r="${ref}"${s}/>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
    }
    case 'num':
      return `<c r="${ref}"${s}><v>${Number(cell.value)}</v></c>`;
    case 'formula':
      return `<c r="${ref}"${s} t="str"><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.value ?? '')}</v></c>`;
    default:
      return `<c r="${ref}"${s}/>`;
  }
}

function writeSheet(sheet) {
  const rows = [...sheet.rows].sort((a, b) => a.r - b.r);
  const maxCol = Math.max(1, ...rows.flatMap((row) => row.cells.map((c) => c.col)));
  const maxRow = Math.max(1, ...rows.map((row) => row.r));

  let pane = '';
  if (sheet.pane && (sheet.pane.xSplit || sheet.pane.ySplit)) {
    const { xSplit = 0, ySplit = 0 } = sheet.pane;
    const topLeft = `${colLetters(xSplit + 1)}${ySplit + 1}`;
    const active = xSplit && ySplit ? 'bottomRight' : xSplit ? 'topRight' : 'bottomLeft';
    pane = `<pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''}`
      + ` topLeftCell="${topLeft}" activePane="${active}" state="frozen"/>`
      + `<selection pane="${active}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  }

  const cols = sheet.cols.length
    ? `<cols>${sheet.cols.map((c) => `<col min="${c.min}" max="${c.max}" width="${c.width}"`
      + `${c.style ? ` style="${c.style}"` : ''} customWidth="1"/>`).join('')}</cols>`
    : '';

  const data = rows.map((row) => {
    const cells = [...row.cells].sort((a, b) => a.col - b.col);
    const spans = cells.length ? ` spans="${cells[0].col}:${cells[cells.length - 1].col}"` : '';
    const open = `<row r="${row.r}"${spans}${attrString(row.attrs ?? {}, ROW_ATTRS)}`;
    return cells.length ? `${open}>${cells.map((c) => cellXml(row.r, c)).join('')}</row>` : `${open}/>`;
  }).join('');

  const merges = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${rangeRef(m)}"/>`).join('')}</mergeCells>`
    : '';

  const validations = sheet.validations.filter((v) => v.ranges.length);
  const dv = validations.length
    ? `<dataValidations count="${validations.length}">${validations.map((v) => {
      const attrs = Object.entries(v.attrs).map(([k, val]) => ` ${k}="${escapeXml(val)}"`).join('');
      return `<dataValidation${attrs} sqref="${v.ranges.map(rangeRef).join(' ')}">`
        + `<formula1>${escapeXml(v.formula1)}</formula1></dataValidation>`;
    }).join('')}</dataValidations>`
    : '';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<worksheet ${NS}>`
    + `<dimension ref="A1:${colLetters(maxCol)}${maxRow}"/>`
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + (sheet.formatPr || '<sheetFormatPr defaultRowHeight="14.4" x14ac:dyDescent="0.3"/>')
    + cols
    + `<sheetData>${data}</sheetData>`
    + merges
    + dv
    + (sheet.tail ?? '')
    + '</worksheet>';
}

/**
 * Reads a worksheet (Excel's or writeSheet's) back into the plain shape —
 * cells resolved to text/number/formula with their style index.
 */
function readSheet(xml, parsed, strings) {
  const paneTag = block(block(xml, 'sheetViews') ?? '', 'pane');
  const pane = paneTag ? {
    xSplit: Number(attrsOf(paneTag).xSplit ?? 0),
    ySplit: Number(attrsOf(paneTag).ySplit ?? 0),
  } : null;
  const cols = elements(block(xml, 'cols') ?? '', 'col').map((tag) => {
    const a = attrsOf(tag);
    return { min: Number(a.min), max: Number(a.max), width: Number(a.width), style: a.style };
  });
  const rows = [...parsed.rows.values()].map(({ attrs, cells }) => ({
    r: Number(attrs.r),
    attrs,
    cells: [...cells.entries()].map(([col, cell]) => {
      const s = cell.attrs.s ? Number(cell.attrs.s) : 0;
      const formula = cell.inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      if (formula != null) return { col, s, kind: 'formula', formula: unescapeXml(formula), value: cellText(cell, strings) };
      const hasValue = /<v>|<is>/.test(cell.inner);
      if (!hasValue) return { col, s, kind: 'blank' };
      if (cell.attrs.t === 's' || cell.attrs.t === 'inlineStr' || cell.attrs.t === 'str') {
        return { col, s, kind: 'str', value: cellText(cell, strings) };
      }
      return { col, s, kind: 'num', value: Number(cellText(cell, strings)) };
    }),
  }));
  const merges = elements(block(xml, 'mergeCells') ?? '', 'mergeCell').map((m) => parseRange(attrsOf(m).ref));
  const validations = elements(block(xml, 'dataValidations') ?? '', 'dataValidation').map((tag) => {
    const { sqref, 'xr:uid': _uid, ...attrs } = attrsOf(tag.match(/^<dataValidation\b[^>]*>/)[0]);
    return {
      attrs,
      formula1: unescapeXml(tag.match(/<formula1>([\s\S]*?)<\/formula1>/)?.[1] ?? ''),
      ranges: String(sqref ?? '').split(/\s+/).filter(Boolean).map(parseRange),
    };
  });
  const formatPr = block(xml, 'sheetFormatPr') ?? '';
  return { pane, cols, rows, merges, validations, formatPr };
}

/** The print-layout tail of a worksheet (margins, setup minus printer part, header/footer). */
function printTail(xml) {
  const margins = block(xml, 'pageMargins') ?? '';
  const setupTag = block(xml, 'pageSetup');
  // The printer-settings part belongs to the sheet it came from.
  const setup = setupTag ? setupTag.replace(/\sr:id="[^"]*"/, '') : '';
  const headerFooter = block(xml, 'headerFooter') ?? '';
  return { margins, setup, headerFooter };
}

export { printTail, readSheet, writeSheet };
