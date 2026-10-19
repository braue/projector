// Graft the four checkout sheets into a FAT workbook.
//
// The sheets are cloned from the template (resources/fatSheets — label
// columns plus one prototype test column), one column per test, and written
// into the target as new parts — or over the existing parts when the
// workbook already has sheets by those names, in place, so a re-run replaces
// the previous conversion instead of stacking copies. Everything else in the
// workbook is left byte-for-byte as it was.
//
// The row-4 substation band is taken from the target itself: its Under
// Frequency / Loss of Source sheets already band each feeder under its
// substation in that project's colours, so the new sheets match them.

import {
  StyleMerger, attrsOf, block, cellText, colLetters, elements, escapeXml, parseSheet, partText,
  readPackage, setPartText, sharedStrings, withAttr, writePackage,
} from './ooxml.js';
import { BAND_SOURCES, INSERT_AFTER, INSERT_BEFORE, KIND_ORDER, SHEETS } from './layout.js';
import { printTail, readSheet, writeSheet } from './sheetxml.js';

const WORKSHEET_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WORKSHEET_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

// --- workbook structure -------------------------------------------------------

// Excel compares sheet names without regard to case: a workbook can't hold
// "Fault Test Checkout" next to "fault test checkout", so matching must not
// tell them apart either.
function sameName(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function findSheet(sheets, name) {
  return sheets.find((s) => sameName(s.name, name));
}

function workbookSheets(pkg) {
  const rels = partText(pkg, 'xl/_rels/workbook.xml.rels');
  const targets = new Map(elements(rels, 'Relationship').map((tag) => {
    const a = attrsOf(tag);
    const target = a.Target.startsWith('/') ? a.Target.slice(1) : `xl/${a.Target}`;
    return [a.Id, target];
  }));
  return elements(partText(pkg, 'xl/workbook.xml'), 'sheet').map((tag) => {
    const a = attrsOf(tag);
    return { tag, name: a.name, sheetId: Number(a.sheetId), rid: a['r:id'], part: targets.get(a['r:id']) };
  });
}

function relsPathOf(part) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

// --- substation bands -----------------------------------------------------------

/**
 * feeder → { substation, style } from the workbook's banded sheets, plus the
 * order substations and feeders appear in. `style` is the TARGET's own
 * cellXfs index for that substation's band.
 */
function readBands(pkg, sheets, strings) {
  const feeders = new Map();
  const substations = [];
  for (const name of BAND_SOURCES) {
    const sheet = findSheet(sheets, name);
    if (!sheet || !pkg.has(sheet.part)) continue;
    const xml = partText(pkg, sheet.part);
    const parsed = parseSheet(xml);
    const bandRow = parsed.rows.get(4);
    const feederRow = parsed.rows.get(6);
    if (!bandRow || !feederRow) continue;
    // Band starts: row-4 cells with text. A band runs to the next start.
    const starts = [...bandRow.cells.entries()]
      .filter(([col, cell]) => col >= 4 && cellText(cell, strings).trim())
      .map(([col, cell]) => ({ col, name: cellText(cell, strings).trim(), style: Number(cell.attrs.s ?? 0) }))
      .sort((a, b) => a.col - b.col);
    for (const [col, cell] of [...feederRow.cells.entries()].sort((a, b) => a[0] - b[0])) {
      const band = starts.filter((b) => b.col <= col).at(-1);
      if (!band) continue;
      if (!substations.some((s) => s.name === band.name)) substations.push({ name: band.name, style: band.style });
      for (const feeder of cellText(cell, strings).split(/[,\n]/).map((f) => f.trim()).filter(Boolean)) {
        if (!feeders.has(feeder)) feeders.set(feeder, { substation: band.name, style: band.style });
      }
    }
  }
  return { feeders, substations };
}

/** A footer from the target's own checkout sheets (project name, date code). */
function targetFooter(pkg, sheets) {
  for (const name of [...BAND_SOURCES, ...INSERT_BEFORE]) {
    const sheet = findSheet(sheets, name);
    if (!sheet || !pkg.has(sheet.part)) continue;
    const footer = block(partText(pkg, sheet.part), 'headerFooter');
    if (footer) return footer;
  }
  return null;
}

// --- one sheet -------------------------------------------------------------------

const LINE_HEIGHT = 14.4; // points per line of 11pt Calibri
const DEFAULT_WIDTH = 26.6640625;

/**
 * Row attributes tall enough for the row's longest test value. Rows keep a
 * fixed height in the template, and Excel does not re-fit stored heights on
 * open, so a three-line device list would otherwise print clipped. Only ever
 * grows a row. The estimate counts a character per column-width unit —
 * device names are capitals and digits, the widest Calibri glyphs.
 */
function fitHeight(attrs, cells, first, width) {
  const perLine = Math.max(8, Math.floor(width) - 1);
  let lines = 1;
  for (const cell of cells) {
    if (cell.col < first || cell.kind !== 'str') continue;
    const needed = String(cell.value).split('\n')
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
    lines = Math.max(lines, needed);
  }
  const height = lines * LINE_HEIGHT;
  const current = Number(attrs.ht ?? LINE_HEIGHT);
  if (lines === 1 || height <= current) return attrs;
  return { ...attrs, ht: String(height), customHeight: '1' };
}

function excelDate({ y, m, d }) {
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/**
 * Build one sheet's XML. `columns` are the per-test answer objects (row
 * name → value) already in display order, each with its band
 * { label, style } (style already a target index, or null for the
 * template's own band style).
 */
function buildSheet(kind, templateXml, templateStrings, columns, { styles, footer }) {
  const layout = SHEETS[kind];
  const first = layout.firstCol;
  const last = first + columns.length - 1;
  const template = readSheet(templateXml, parseSheet(templateXml), templateStrings);
  const rowName = new Map(Object.entries(layout.rows).map(([name, r]) => [r, name]));
  const protoBand = template.rows.find((r) => r.r === 4)?.cells.find((c) => c.col === first);
  const protoWidth = template.cols.find((c) => c.min <= first && first <= c.max)?.width ?? DEFAULT_WIDTH;

  const rows = template.rows.map((row) => {
    const cells = row.cells
      .filter((c) => c.col < first)
      .map((c) => ({ ...c, s: styles.map(c.s) }));
    const proto = row.cells.find((c) => c.col === first);
    if (proto) {
      columns.forEach((column, i) => {
        const col = first + i;
        const s = styles.map(proto.s);
        if (row.r === 4) {
          const band = column.band;
          const starts = i === 0 || columns[i - 1].band.label !== band.label;
          const style = band.style ?? styles.map(protoBand?.s ?? proto.s);
          cells.push(starts ? { col, s: style, kind: 'str', value: band.label } : { col, s: style, kind: 'blank' });
        } else if (row.r === 5) {
          cells.push({
            col, s, kind: 'formula',
            formula: `"${layout.prefix}-"&COLUMN()-${first - 1}`,
            value: `${layout.prefix}-${i + 1}`,
          });
        } else {
          const name = rowName.get(row.r);
          const value = name ? column.values[name] : undefined;
          if (value && typeof value === 'object' && 'y' in value) cells.push({ col, s, kind: 'num', value: excelDate(value) });
          else if (value) cells.push({ col, s, kind: 'str', value: String(value) });
          else cells.push({ col, s, kind: 'blank' });
        }
      });
    }
    return { r: row.r, attrs: fitHeight(row.attrs, cells, first, protoWidth), cells };
  });

  // Label merges that reached the prototype column span every test; row 4
  // gets one merge per substation run.
  const merges = template.merges.map((m) => (m.c2 === first && m.c1 < first ? { ...m, c2: last } : m));
  let runStart = 0;
  columns.forEach((column, i) => {
    const endsRun = i === columns.length - 1 || columns[i + 1].band.label !== column.band.label;
    if (!endsRun) return;
    if (i > runStart) merges.push({ c1: first + runStart, r1: 4, c2: first + i, r2: 4 });
    runStart = i + 1;
  });

  const validations = template.validations.map((v) => ({
    ...v,
    ranges: v.ranges.map((r) => (r.c1 === first ? { ...r, c2: last } : r)),
  }));
  const cols = template.cols.map((c) => (c.min === first ? { ...c, max: last } : c))
    .map((c) => ({ ...c, style: c.style != null ? styles.map(c.style) : undefined }));
  const { margins, setup, headerFooter } = printTail(templateXml);

  return {
    xml: writeSheet({
      pane: template.pane,
      formatPr: template.formatPr,
      cols,
      rows,
      merges,
      validations,
      tail: margins + setup + (footer ?? headerFooter),
    }),
    lastCol: last,
    // Print to the last row that says something (footnotes included), not
    // to trailing rows that only carry formatting.
    lastRow: Math.max(...template.rows.filter((r) => r.cells.some((c) => c.kind !== 'blank')).map((r) => r.r)),
  };
}

// --- workbook surgery --------------------------------------------------------------

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Drop then re-add this sheet's print area / titles (its localSheetId). */
function setPrintNames(workbookXml, localId, name, firstCol, lastCol, lastRow) {
  let xml = workbookXml;
  const names = [
    `<definedName name="_xlnm.Print_Area" localSheetId="${localId}">${escapeXml(`${quoteSheet(name)}!$A$1:$${colLetters(lastCol)}$${lastRow}`)}</definedName>`,
    `<definedName name="_xlnm.Print_Titles" localSheetId="${localId}">${escapeXml(`${quoteSheet(name)}!$A:$${colLetters(firstCol - 1)},${quoteSheet(name)}!$1:$5`)}</definedName>`,
  ];
  const existing = block(xml, 'definedNames');
  if (existing) {
    const kept = elements(existing, 'definedName').filter((tag) => {
      const a = attrsOf(tag.match(/^<definedName\b[^>]*>/)[0]);
      return !(Number(a.localSheetId) === localId && /^_xlnm\.Print_(Area|Titles)$/.test(a.name));
    });
    xml = xml.replace(existing, () => `<definedNames>${[...kept, ...names].join('')}</definedNames>`);
  } else {
    xml = xml.replace('</sheets>', () => `</sheets><definedNames>${names.join('')}</definedNames>`);
  }
  return xml;
}

/** Shift every sheet-position reference at or after `position` by one. */
function shiftPositions(workbookXml, position) {
  let xml = workbookXml.replace(/(<definedName\b[^>]*\slocalSheetId=")(\d+)(")/g,
    (whole, a, n, b) => (Number(n) >= position ? `${a}${Number(n) + 1}${b}` : whole));
  xml = xml.replace(/<workbookView\b[^>]*?\/?>/g, (tag) => {
    const a = attrsOf(tag);
    let out = tag;
    if (a.activeTab != null && Number(a.activeTab) >= position) out = withAttr(out, 'activeTab', String(Number(a.activeTab) + 1));
    if (a.firstSheet != null && Number(a.firstSheet) >= position) out = withAttr(out, 'firstSheet', String(Number(a.firstSheet) + 1));
    return out;
  });
  return xml;
}

function insertPosition(sheets, placed) {
  // After the last of our sheets already placed, else after INSERT_AFTER,
  // else before the first INSERT_BEFORE sheet, else at the end.
  const ours = sheets.map((s, i) => ([...placed].some((p) => sameName(p, s.name)) ? i : -1)).filter((i) => i >= 0);
  if (ours.length) return Math.max(...ours) + 1;
  const after = sheets.findIndex((s) => sameName(s.name, INSERT_AFTER));
  if (after >= 0) return after + 1;
  const before = sheets.findIndex((s) => INSERT_BEFORE.some((n) => sameName(n, s.name)));
  return before >= 0 ? before : sheets.length;
}

/**
 * The replaced sheet's <sheetPr> carried into its new XML. It holds the
 * sheet's codeName — the name a macro workbook's VBA project knows the sheet
 * by, which Excel "repairs" when it goes missing — and its tab colour.
 */
function keepSheetPr(newXml, oldXml) {
  const sheetPr = block(oldXml, 'sheetPr');
  if (!sheetPr) return newXml;
  return newXml.replace(/(<worksheet\b[^>]*>)/, (open) => open + sheetPr);
}

function dropCalcChain(pkg) {
  if (!pkg.has('xl/calcChain.xml')) return;
  // Excel rebuilds the calculation chain; a stale one naming cells of a
  // replaced sheet is what makes it offer a "repair".
  pkg.delete('xl/calcChain.xml');
  const relsPath = 'xl/_rels/workbook.xml.rels';
  setPartText(pkg, relsPath, partText(pkg, relsPath).replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/g, ''));
  setPartText(pkg, '[Content_Types].xml', partText(pkg, '[Content_Types].xml')
    .replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ''));
}

// --- entry point ---------------------------------------------------------------------

/**
 * targetBuffer: the FAT workbook (.xlsm/.xlsx). templateBuffer: the
 * checkout-sheet template. byKind: { fault: [column], … } where each column
 * is { feeder, values } in report order.
 *
 * Returns { buffer, sheets: [{ kind, name, count, replaced }], bands }.
 */
function graftSheets(targetBuffer, templateBuffer, byKind) {
  const pkg = readPackage(targetBuffer);
  const tpl = readPackage(templateBuffer);
  const strings = sharedStrings(pkg);
  const tplStrings = sharedStrings(tpl);
  const tplSheets = workbookSheets(tpl);
  let sheets = workbookSheets(pkg);
  const { feeders, substations } = readBands(pkg, sheets, strings);
  const footer = targetFooter(pkg, sheets);
  const styles = new StyleMerger(partText(pkg, 'xl/styles.xml'), partText(tpl, 'xl/styles.xml'));

  const feederOrder = [...feeders.keys()];
  const substationRank = (name) => {
    const i = substations.findIndex((s) => s.name === name);
    return i < 0 ? substations.length : i;
  };

  let workbookXml = partText(pkg, 'xl/workbook.xml');
  let relsXml = partText(pkg, 'xl/_rels/workbook.xml.rels');
  let typesXml = partText(pkg, '[Content_Types].xml');
  const placed = new Set();
  const report = [];
  const unbanded = new Set();

  for (const kind of KIND_ORDER) {
    const tests = byKind[kind] ?? [];
    if (!tests.length) continue;
    const layout = SHEETS[kind];
    const tplSheet = tplSheets.find((s) => s.name === layout.name);
    if (!tplSheet) throw new Error(`the template has no "${layout.name}" sheet`);

    // Substation runs in the workbook's own order, feeders in theirs, tests
    // in report order within a feeder. Feeders no banded sheet names go last,
    // banded by their own name.
    const columns = tests.map((column, order) => {
      const band = feeders.get(column.feeder);
      if (!band) unbanded.add(column.feeder);
      return {
        ...column,
        order,
        band: band ? { label: band.substation, style: band.style } : { label: column.feeder, style: null },
        rank: band ? substationRank(band.substation) : substations.length,
        feederRank: band ? feederOrder.indexOf(column.feeder) : feederOrder.length,
      };
    }).sort((a, b) => a.rank - b.rank || a.feederRank - b.feederRank
      || (a.rank === substations.length ? a.feeder.localeCompare(b.feeder) : 0) || a.order - b.order);

    const built = buildSheet(kind, partText(tpl, tplSheet.part), tplStrings, columns, { styles, footer });
    const existing = findSheet(sheets, layout.name);
    let localId;
    if (existing) {
      pkg.set(existing.part, new TextEncoder().encode(keepSheetPr(built.xml, partText(pkg, existing.part))));
      // The old sheet's own relationships (printer settings, comments) no
      // longer describe what's in the part.
      pkg.delete(relsPathOf(existing.part));
      localId = sheets.indexOf(existing);
    } else {
      const position = insertPosition(sheets, placed);
      const partNumbers = [...pkg.keys()]
        .map((k) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k)?.[1]).filter(Boolean).map(Number);
      const part = `xl/worksheets/sheet${Math.max(0, ...partNumbers) + 1}.xml`;
      const rIds = elements(relsXml, 'Relationship').map((t) => Number(/^rId(\d+)$/.exec(attrsOf(t).Id)?.[1] ?? 0));
      const rid = `rId${Math.max(0, ...rIds) + 1}`;
      const sheetId = Math.max(0, ...sheets.map((s) => s.sheetId)) + 1;
      pkg.set(part, new TextEncoder().encode(built.xml));
      relsXml = relsXml.replace('</Relationships>',
        `<Relationship Id="${rid}" Type="${WORKSHEET_TYPE}" Target="${part.slice('xl/'.length)}"/></Relationships>`);
      typesXml = typesXml.replace('</Types>', `<Override PartName="/${part}" ContentType="${WORKSHEET_CT}"/></Types>`);
      const tag = `<sheet name="${escapeXml(layout.name)}" sheetId="${sheetId}" r:id="${rid}"/>`;
      workbookXml = shiftPositions(workbookXml, position);
      const anchor = sheets[position]?.tag;
      workbookXml = anchor
        ? workbookXml.replace(anchor, () => tag + anchor)
        : workbookXml.replace('</sheets>', () => `${tag}</sheets>`);
      sheets = [...sheets.slice(0, position), { tag, name: layout.name, sheetId, rid, part }, ...sheets.slice(position)];
      localId = position;
    }
    const sheetName = existing?.name ?? layout.name;
    placed.add(sheetName);
    workbookXml = setPrintNames(workbookXml, localId, sheetName, layout.firstCol, built.lastCol, built.lastRow);
    report.push({ kind, name: sheetName, count: columns.length, replaced: Boolean(existing), columns });
  }

  setPartText(pkg, 'xl/workbook.xml', workbookXml);
  setPartText(pkg, 'xl/_rels/workbook.xml.rels', relsXml);
  setPartText(pkg, '[Content_Types].xml', typesXml);
  setPartText(pkg, 'xl/styles.xml', styles.toXml());
  dropCalcChain(pkg);

  return {
    buffer: writePackage(pkg),
    sheets: report,
    bands: {
      substations: substations.map((s) => ({ name: s.name, feeders: feederOrder.filter((f) => feeders.get(f).substation === s.name) })),
      unbanded: [...unbanded].sort(),
    },
  };
}

export { graftSheets, readBands };
