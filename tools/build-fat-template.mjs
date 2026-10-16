// Build the FAT checkout-sheet template from a hand-completed FAT workbook.
//
//   node tools/build-fat-template.mjs "<completed FAT>.xlsm" [--out <file>]
//
// The automatic-FAT converter (backend/services/tools/fatsheets) fills the
// Fault / Open Phase / Miscoordination / Abnormal checkout sheets in the
// look of a FAT someone already completed by hand. This script distils that
// look into a small, ordinary .xlsx: for each of the four sheets it keeps
// the label columns, every row (heights, hidden SAT section, merges, list
// validations, print setup) and ONE prototype test column — each row's
// prototype cell carrying the style most of the completed columns used,
// blank except for the test-id formula. The converter clones that column
// once per test.
//
// The output is a real workbook: open it in Excel to adjust wording or
// formatting, save, and the converter picks the change up.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHEETS, KIND_ORDER } from '../backend/services/tools/fatsheets/layout.js';
import {
  attrsOf, elements, parseSheet, partText, readPackage, sharedStrings, writePackage,
} from '../backend/services/tools/fatsheets/ooxml.js';
import { printTail, readSheet, writeSheet } from '../backend/services/tools/fatsheets/sheetxml.js';

const encoder = new TextEncoder();
const strToU8 = (text) => encoder.encode(text);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(HERE, '../backend/resources/fatSheets/checkout-template.xlsx');

function sheetParts(pkg) {
  const workbook = partText(pkg, 'xl/workbook.xml');
  const rels = partText(pkg, 'xl/_rels/workbook.xml.rels');
  const targets = new Map(elements(rels, 'Relationship').map((tag) => {
    const a = attrsOf(tag);
    return [a.Id, `xl/${a.Target.replace(/^\/?xl\//, '')}`];
  }));
  return new Map(elements(workbook, 'sheet').map((tag) => {
    const a = attrsOf(tag);
    return [a.name, targets.get(a['r:id'])];
  }));
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function distil(xml, strings, layout) {
  const parsed = parseSheet(xml);
  const sheet = readSheet(xml, parsed, strings);
  const first = layout.firstCol;
  const feederRow = sheet.rows.find((row) => row.r === layout.rows.feeder);
  const testCols = (feederRow?.cells ?? [])
    .filter((c) => c.col >= first && c.kind === 'str' && c.value.trim())
    .map((c) => c.col);
  if (!testCols.length) throw new Error(`${layout.name}: no completed test columns to learn from`);

  const rows = sheet.rows.map((row) => {
    const labels = row.cells.filter((c) => c.col < first);
    const styles = row.cells.filter((c) => testCols.includes(c.col)).map((c) => c.s);
    const cells = [...labels];
    if (styles.length) {
      // Row 4's band is the substation's colour, which the converter takes
      // from the target workbook — the prototype keeps the first band's.
      const s = row.r === 4 ? row.cells.find((c) => c.col === first)?.s ?? mode(styles) : mode(styles);
      cells.push(row.r === 5
        ? { col: first, s, kind: 'formula', formula: `"${layout.prefix}-"&COLUMN()-${first - 1}`, value: `${layout.prefix}-1` }
        : { col: first, s, kind: 'blank' });
    }
    return { r: row.r, attrs: row.attrs, cells };
  });

  const clip = (r) => (r.c1 < first ? { ...r, c2: Math.min(r.c2, first) } : null);
  // A label merge that reached into the test columns ends at the prototype
  // column, and the converter stretches it back across every test; one wholly
  // inside the labels stays as is. Row 4's band merges are rebuilt per run.
  const merges = sheet.merges.map(clip).filter(Boolean);
  const validations = sheet.validations.map((v) => ({
    ...v,
    ranges: v.ranges
      .filter((r) => r.c2 >= first)
      .map((r) => ({ ...r, c1: first, c2: first })),
  }));
  const cols = sheet.cols
    .filter((c) => c.min <= first)
    .map((c) => ({ ...c, max: Math.min(c.max, first) }));
  const { margins, setup, headerFooter } = printTail(xml);
  return writeSheet({
    pane: sheet.pane,
    formatPr: sheet.formatPr,
    cols,
    rows,
    merges,
    validations,
    tail: margins + setup + headerFooter,
  });
}

function templatePackage(styles, theme, sheets) {
  const pkg = new Map();
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';
  pkg.set('[Content_Types].xml', strToU8(ct));
  pkg.set('_rels/.rels', strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'));
  pkg.set('xl/workbook.xml', strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews><sheets>'
    + sheets.map(({ name }, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>'));
  pkg.set('xl/_rels/workbook.xml.rels', strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`
    + `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + '</Relationships>'));
  pkg.set('xl/styles.xml', strToU8(styles));
  pkg.set('xl/theme/theme1.xml', strToU8(theme));
  sheets.forEach(({ xml }, i) => pkg.set(`xl/worksheets/sheet${i + 1}.xml`, strToU8(xml)));
  return pkg;
}

function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? path.resolve(args[outAt + 1]) : DEFAULT_OUT;
  const source = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  if (!source) {
    console.error('usage: node tools/build-fat-template.mjs "<completed FAT>.xlsm" [--out <file>]');
    process.exit(2);
  }
  const pkg = readPackage(readFileSync(source));
  const strings = sharedStrings(pkg);
  const parts = sheetParts(pkg);
  const sheets = KIND_ORDER.map((kind) => {
    const layout = SHEETS[kind];
    const part = parts.get(layout.name);
    if (!part) throw new Error(`${source} has no "${layout.name}" sheet`);
    return { name: layout.name, xml: distil(partText(pkg, part), strings, layout) };
  });
  const template = templatePackage(
    partText(pkg, 'xl/styles.xml'),
    partText(pkg, 'xl/theme/theme1.xml'),
    sheets,
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, writePackage(template));
  console.log(`wrote ${out}`);
}

main();
