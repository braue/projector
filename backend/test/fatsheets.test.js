// Automatic FAT → Excel: the report parser, the per-test answers, and the
// graft into a workbook — which must add (or, on a re-run, replace) the four
// checkout sheets while leaving every other part of the workbook as it was.
// Fixtures are synthetic: a tiny report in the simulator's markup and a tiny
// workbook with a banded Under Frequency sheet; the shipped template is real.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { zipSync } from 'fflate';

import { FilesService } from '../services/files.js';
import { JobRegistry } from '../services/jobs.js';
import { FatSheetsService } from '../services/tools/fatsheets.js';
import { parseAutoFat } from '../services/tools/fatsheets/autofat.js';
import { columnFor, configuration } from '../services/tools/fatsheets/columns.js';
import { convertAutoFat } from '../services/tools/fatsheets/index.js';
import { SHEETS } from '../services/tools/fatsheets/layout.js';
import {
  attrsOf, block, cellText, elements, parseSheet, partText, readPackage, sharedStrings,
} from '../services/tools/fatsheets/ooxml.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../resources/fatSheets/checkout-template.xlsx');
const settled = (job) => new Promise((resolve) => {
  const tick = () => (job.status === 'running' ? setTimeout(tick, 5) : resolve(job));
  tick();
});
const enc = (text) => new TextEncoder().encode(text);

// --- a report in the simulator's markup ----------------------------------------

const table = (headers, rows, rowClass = 'bodyRow') => `<table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`
  + rows.map((r) => `<tr class="${rowClass}">${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') + '</table>';

const SUMMARY = ['Fault Type', 'Index', 'Start Time', 'Status', 'Fail Reason', 'Feeder', 'Zone Entry', 'Trip Device', 'Fault Location', 'Fault Phase'];
const SWITCHING = ['Feeder', 'Fault Location', 'Index', 'ID', 'Status', 'Fail Reason', 'Setup Open', 'Setup Close', 'Copy Test Setup', 'Open', 'Close', 'Open -&gt; Closed', 'Closed -&gt; Opened', 'Copy Results'];

/** tests: [{ type, index, status, reason, feeder, trip, loc, abn, so, sc, open, close, oc, groups, failures, alarms, event }] */
function report(tests) {
  const plain = tests.filter((t) => !t.type.startsWith('Abnormal'));
  const abnormal = tests.filter((t) => t.type.startsWith('Abnormal'));
  const summaryRow = (t) => [t.type, t.index, '2026/10/07 14:15:15.572', t.status, t.reason ?? 'None', t.feeder,
    `${t.trip}.A`, `${t.trip}.A`, `${t.loc}.B`, 'ALL'];
  const sections = tests.map((t) => {
    const validation = [['Switching', 'Parallel', 'None', '', '']];
    for (const g of t.groups ?? []) validation.push([g, 'Series', 'None', '', '']);
    for (const f of t.failures ?? []) validation.push([f[0], '', 'Value', f[1], f[2]]);
    const soe = [[`T-${t.index}`, 'Step', 'Fault', '2026/10/07 14:16:23.272']];
    if (t.event !== false) soe.push([`${t.feeder}.Event`, 'InProgress', 'TRUE', '2026/10/07 14:16:39.272']);
    const sequence = [['Initialize', 'Series', 'Set', '']];
    for (const a of t.alarms ?? []) sequence.push([a, '', 'Set', 'TRUE']);
    return `<h2 id="${t.feeder}-${t.type}-${t.index}-header" class="sectionHeader">${t.feeder}-${t.type}-${t.index}: ${t.status}</h2>`
      + `<div class="report" id="${t.feeder}-${t.type}-${t.index}-body">`
      + table(['ID', 'Sequence', 'Fail Reason', 'Expected', 'Actual'], validation)
      + table(['RootTag', 'PointId', 'Value', 'TimeStamp'], soe)
      + table(['ID', 'Sequence', 'Action', 'Value'], sequence)
      + '</div>';
  });
  return '<!DOCTYPE html><html><body><h1 id="page-title">Default - Aggregate - Oct 08, 2026</h1>'
    + '<h2>Summary</h2>'
    + table(SUMMARY, plain.map(summaryRow))
    + table([...SUMMARY, 'Abnormal Device'], abnormal.map((t) => [...summaryRow(t), `${t.abn}.A`]))
    + '<h2>Switching Summary</h2>'
    + table(SWITCHING, tests.map((t) => [t.feeder, `${t.loc}.B`, t.index, `ID-${t.index}`, t.status, t.reason ?? 'None',
      t.so ?? '', t.sc ?? '', 'Copy', t.open ?? '', t.close ?? '', t.oc ?? '', '', 'Copy']))
    + sections.join('')
    + '</body></html>';
}

const TESTS = [
  { type: 'FaultLo', index: 1, status: 'Complete', feeder: 'F2', trip: 'B2', loc: 'B2', open: 'B2 , R21', close: 'R99', groups: ['R21-IsoFltDwn', 'R99-Rest'] },
  { type: 'FaultLo', index: 2, status: 'Fail', reason: 'OutOfSequence', feeder: 'F1', trip: 'R11', loc: 'R11', open: 'R11', groups: ['R12-IsoFltDwn'],
    failures: [['R12.SW.Switch.Status.ALL', 'FALSE', 'TRUE'], ['R98.SW.Switch.Status.ALL', 'TRUE', 'FALSE']] },
  { type: 'FaultLo', index: 3, status: 'Complete', feeder: 'F1', trip: 'R12', loc: 'R12', open: 'R12', so: 'R13.A', sc: 'R14.B' },
  { type: 'OpenPhase', index: 4, status: 'Questionable', feeder: 'F1', trip: 'R11', loc: 'R11', open: 'R11 , R12', close: 'R98' },
  { type: 'Miscoordination', index: 5, status: 'Complete', feeder: 'F1', trip: 'R11', loc: 'R12', open: 'R12', close: 'R98', oc: 'R11' },
  { type: 'AbnormalFaultLo', index: 6, status: 'Complete', feeder: 'F2', trip: 'B2', loc: 'B2', abn: 'R21', alarms: ['R21.Alarms.Reclose'], close: 'R77' },
  { type: 'AbnormalOpenPhase', index: 7, status: 'Fail', reason: 'OutOfSequence', feeder: 'F1', trip: 'R11', loc: 'R11', abn: 'R12',
    alarms: ['R12.Alarms.Remote'], failures: [['R11.SW.Switch.Status.ALL', 'FALSE', 'TRUE']], event: false },
  { type: 'FaultLo', index: 8, status: 'Complete', feeder: 'F9', trip: 'B9', loc: 'B9', open: 'B9' },
];

// --- a small FAT workbook ----------------------------------------------------------

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FF92D050"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

const sheetXml = (rows) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  + rows.map(([r, cells]) => `<row r="${r}">${cells.map(([ref, s, text]) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${text}</t></is></c>`).join('')}</row>`).join('')
  + '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
  + '<headerFooter><oddFooter>&amp;LProject Footer</oddFooter></headerFooter></worksheet>';

const MEDIA = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function workbookPackage() {
  const sheets = ['FAT Info', 'Simulator HMI screens', 'Under Frequency Test Checkout'];
  const files = {
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'
      + '</Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView activeTab="2"/></bookViews><sheets>'
      + sheets.map((name, i) => `<sheet name="${name}" sheetId="${i + 3}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="2">\'Under Frequency Test Checkout\'!$A$1:$F$34</definedName></definedNames>'
      + '</workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>'
      + '</Relationships>'),
    'xl/styles.xml': enc(STYLES),
    'xl/calcChain.xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A1" i="3"/></calcChain>'),
    'xl/media/image1.png': MEDIA,
    'xl/worksheets/sheet1.xml': enc(sheetXml([[1, [['A1', 0, 'FAT Info']]]])),
    'xl/worksheets/sheet2.xml': enc(sheetXml([[1, [['A1', 0, 'Simulator HMI Screens']]]])),
    // Two substations banded over three feeders; Eunice's band is style 2.
    'xl/worksheets/sheet3.xml': enc(sheetXml([
      [4, [['D4', 2, 'Eunice'], ['F4', 1, 'Habetz']]],
      [6, [['D6', 0, 'F1'], ['E6', 0, 'F2'], ['F6', 0, 'F3']]],
    ])),
  };
  return Buffer.from(zipSync(files));
}

function sheetsOf(pkg) {
  const rels = partText(pkg, 'xl/_rels/workbook.xml.rels');
  const targets = new Map(elements(rels, 'Relationship').map((t) => [attrsOf(t).Id, `xl/${attrsOf(t).Target}`]));
  return elements(partText(pkg, 'xl/workbook.xml'), 'sheet').map((t) => ({ name: attrsOf(t).name, part: targets.get(attrsOf(t)['r:id']) }));
}

function grid(pkg, name) {
  const sheet = sheetsOf(pkg).find((s) => s.name === name);
  const parsed = parseSheet(partText(pkg, sheet.part));
  const strings = sharedStrings(pkg);
  return (row, col) => {
    const cell = parsed.rows.get(row)?.cells.get(col);
    return cell ? { text: cellText(cell, strings), s: Number(cell.attrs.s ?? 0) } : null;
  };
}

// --- tests -------------------------------------------------------------------------

test('parseAutoFat reads summary, switching and each test section', () => {
  const { title, tests } = parseAutoFat(report(TESTS));
  assert.match(title, /Aggregate/);
  assert.equal(tests.length, TESTS.length);
  const [first, second, third] = tests;
  assert.equal(first.kind, 'fault');
  assert.equal(first.trip, 'B2'); // terminal suffix stripped
  assert.deepEqual(first.open, ['B2', 'R21']);
  assert.deepEqual(first.groups, [{ device: 'R21', action: 'IsoFltDwn' }, { device: 'R99', action: 'Rest' }]);
  assert.equal(second.status, 'Fail');
  assert.equal(second.failReason, 'OutOfSequence');
  assert.equal(second.failures.length, 2);
  assert.deepEqual(third.setupOpen, ['R13']);
  assert.deepEqual(third.setupClose, ['R14']);
  const abnormal = tests.find((t) => t.index === 6);
  assert.equal(abnormal.kind, 'abnormal');
  assert.equal(abnormal.baseKind, 'fault');
  assert.equal(abnormal.abnormalDevice, 'R21');
  assert.deepEqual(abnormal.alarms, [{ device: 'R21', alarm: 'Reclose' }]);
  assert.equal(tests.find((t) => t.index === 7).eventSeen, false);
  assert.deepEqual(tests.find((t) => t.index === 5).openClosed, ['R11']);
  assert.throws(() => parseAutoFat('<html><table><tr><th>x</th></tr></table></html>'), /not an automatic-FAT report/);
});

test('columns: phrasing and footnote marks follow the hand-completed FAT', () => {
  const { tests } = parseAutoFat(report(TESTS));
  const byIndex = (i) => tests.find((t) => t.index === i);
  const plainTests = tests.filter((t) => !t.abnormal);

  assert.equal(configuration({ setupOpen: [], setupClose: [] }), 'Normal Configuration');
  assert.equal(configuration({ setupOpen: ['R1744'], setupClose: ['R2943'] }), 'Move open point from R2943 to R1744');
  assert.equal(configuration({ setupOpen: ['R3240', 'R3573'], setupClose: ['R463', 'R3390'] }),
    'Open R3240 and R3573, close R463 and R3390');

  const fault = columnFor('fault', byIndex(1), { engineer: 'Noah Braue' });
  assert.equal(fault.location, 'Downstream B2');
  assert.equal(fault.opened, 'B2*, R21'); // trip device marked "opened due to protection"
  assert.equal(fault.closed, 'R99');
  assert.equal(fault.downstream, 'YES');
  assert.equal(fault.rtn, ''); // the automatic run never exercises RTN
  assert.equal(fault.comments, '');
  assert.equal(fault.engineer, 'Noah Braue');

  const failed = columnFor('fault', byIndex(2));
  assert.equal(failed.recognized, 'YES'); // the SOE shows the event
  assert.equal(failed.downstream, 'NO');
  assert.equal(failed.acceptable, 'NO');
  assert.equal(failed.closed, 'None');
  assert.match(failed.comments, /Fail \(OutOfSequence\) — R12 did not open; R98 did not close\. Test 2/);

  assert.equal(columnFor('fault', byIndex(3)).downstream, 'N/A'); // nothing downstream

  // A device protection opened and the DAC then closed to correct the
  // miscoordination is in both rows: * where it opened, ** where it closed.
  const corrected = columnFor('fault', { ...byIndex(1), open: ['B2'], openClosed: ['R21'], close: ['R99'] });
  assert.equal(corrected.opened, 'B2*, R21*');
  assert.equal(corrected.closed, 'R21**, R99');

  const openPhase = columnFor('openPhase', byIndex(4));
  assert.equal(openPhase.opened, 'R11, R12'); // no marks on the open phase sheet
  assert.equal(openPhase.acceptable, 'YES');
  assert.match(openPhase.comments, /Questionable — review test 4/);

  const mis = columnFor('miscoordination', byIndex(5));
  assert.equal(mis.location, 'Downstream R12\nLockout R11');
  assert.equal(mis.opened, 'R11, R12'); // the tripped device leads
  assert.equal(mis.closed, 'R11*, R98'); // closed to correct the miscoordination

  const abn = columnFor('abnormal', byIndex(6), { plainTests });
  assert.equal(abn.abnormal, 'R21 Reclose Disabled');
  assert.equal(abn.location, 'Fault: Downstream B2');
  assert.equal(abn.baseline, 'YES'); // test 1 re-run with the abnormal condition
  assert.equal(abn.tags, 'YES');
  assert.equal(abn.feederUsed, 'NO');
  assert.equal(abn.elsewhere, 'YES');
  assert.equal(abn.elsewhereClosed, 'R77');

  const abnFail = columnFor('abnormal', byIndex(7), { plainTests });
  assert.equal(abnFail.abnormal, 'R12 Remote Disabled');
  assert.equal(abnFail.baseline, 'YES'); // test 4 (open phase at R11), questionable but validated
  assert.equal(abnFail.tags, '');
  assert.equal(abnFail.feederUsed, 'YES');
  assert.equal(abnFail.elsewhere, 'N/A');
});

test('the shipped template carries the rows the layout fills', async () => {
  const pkg = readPackage(await readFile(TEMPLATE));
  const labels = {
    fault: { 6: 'Feeder', 8: 'Event location', 9: 'recognize the fault', 13: 'closed points opened', 15: 'Return to Normal', 16: 'Comments', 17: 'Engineer', 18: 'Date' },
    openPhase: { 6: 'Feeder', 9: 'recognize the open phase', 11: 'closed points opened', 12: 'open points closed', 13: 'Comments', 14: 'engineer', 15: 'Date' },
    miscoordination: { 6: 'Feeder', 8: 'Event location', 9: 'recognize the miscoordination', 12: 'open points closed', 15: 'Date' },
    abnormal: { 8: 'Condition', 9: 'Event location', 10: 'acceptable reconfiguration', 11: 'abnormal condition tags', 12: 'feeder with the abnormal condition', 14: 'open points closed', 15: 'Comments', 17: 'Date' },
  };
  for (const [kind, rows] of Object.entries(labels)) {
    const layout = SHEETS[kind];
    const cell = grid(pkg, layout.name);
    const labelCol = layout.firstCol - 1;
    for (const [row, text] of Object.entries(rows)) {
      assert.match(cell(Number(row), labelCol)?.text ?? '', new RegExp(text, 'i'), `${layout.name} row ${row}`);
    }
    for (const [name, row] of Object.entries(layout.rows)) {
      assert.ok(cell(row, layout.firstCol), `${layout.name}: prototype cell for ${name} (row ${row})`);
    }
  }
});

test('convertAutoFat grafts the sheets and leaves the rest of the workbook alone', async () => {
  const input = workbookPackage();
  const result = await convertAutoFat({ workbook: input, html: report(TESTS), engineer: 'Noah Braue' });
  const before = readPackage(input);
  const pkg = readPackage(result.buffer);

  // Inserted after "Simulator HMI screens", in the standard order.
  assert.deepEqual(sheetsOf(pkg).map((s) => s.name), [
    'FAT Info', 'Simulator HMI screens',
    'Fault Test Checkout', 'Open Phase Test Checkout', 'Miscoordination Test Checkout', 'Abnormal Condition Checkout',
    'Under Frequency Test Checkout',
  ]);
  assert.deepEqual(result.sheets.map((s) => [s.kind, s.count, s.replaced]),
    [['fault', 4, false], ['openPhase', 1, false], ['miscoordination', 1, false], ['abnormal', 2, false]]);

  // Untouched parts are byte-identical; the stale calc chain is gone.
  assert.deepEqual(pkg.get('xl/media/image1.png'), MEDIA);
  assert.deepEqual(pkg.get('xl/worksheets/sheet3.xml'), before.get('xl/worksheets/sheet3.xml'));
  assert.equal(pkg.has('xl/calcChain.xml'), false);
  assert.doesNotMatch(partText(pkg, '[Content_Types].xml'), /calcChain/);

  // The UF sheet's print area followed it to its new position (2 → 6), the
  // active tab too, and each new sheet got its own print area and titles.
  const workbook = partText(pkg, 'xl/workbook.xml');
  assert.match(workbook, /localSheetId="6">'Under Frequency Test Checkout'!\$A\$1:\$F\$34/);
  assert.match(workbook, /activeTab="6"/);
  assert.match(workbook, /localSheetId="2">'Fault Test Checkout'!\$A\$1:\$G\$37</);
  assert.match(workbook, /localSheetId="2">'Fault Test Checkout'!\$A:\$C,'Fault Test Checkout'!\$1:\$5</);

  // Styles are append-only: existing indices keep their meaning.
  const styles = partText(pkg, 'xl/styles.xml');
  const xfs = elements(block(styles, 'cellXfs'), 'xf');
  assert.ok(xfs.length > 3);
  assert.deepEqual(xfs.slice(0, 3), elements(block(STYLES, 'cellXfs'), 'xf'));

  // Fault sheet: columns grouped by the UF sheet's substation order (Eunice
  // F1 then F2), feeders it doesn't band last under their own name.
  const fault = grid(pkg, 'Fault Test Checkout');
  assert.deepEqual([4, 5, 6, 7].map((c) => fault(6, c)?.text), ['F1', 'F1', 'F2', 'F9']);
  assert.equal(fault(4, 4).text, 'Eunice');
  assert.equal(fault(4, 4).s, 2); // the workbook's own band style
  assert.equal(fault(4, 7).text, 'F9');
  assert.deepEqual(result.bands.unbanded, ['F9']);
  assert.equal(fault(5, 6).text, 'FT-3');
  assert.equal(fault(13, 6).text, 'B2*, R21');
  assert.equal(fault(17, 4).text, 'Noah Braue');
  assert.equal(Number(fault(18, 4).text), 46302); // 2026-10-07 as an Excel date
  assert.match(partText(pkg, sheetsOf(pkg).find((s) => s.name === 'Fault Test Checkout').part), /Project Footer/);

  // Flagged tests point at their column.
  assert.deepEqual(result.flagged.map((f) => [f.index, f.column, f.status]),
    [[2, 'FT-1', 'Fail'], [4, 'OP-1', 'Questionable'], [7, 'ABN-1', 'Fail']]);

  // A re-run replaces the sheets in place instead of stacking copies.
  const again = await convertAutoFat({ workbook: result.buffer, html: report(TESTS.slice(0, 1)) });
  const pkg2 = readPackage(again.buffer);
  assert.deepEqual(sheetsOf(pkg2).map((s) => s.name), sheetsOf(pkg).map((s) => s.name));
  assert.deepEqual(again.sheets.map((s) => [s.kind, s.count, s.replaced]), [['fault', 1, true]]);
  assert.equal(grid(pkg2, 'Fault Test Checkout')(6, 5), null);
  assert.equal((partText(pkg2, 'xl/workbook.xml').match(/'Fault Test Checkout'!\$A\$1/g) ?? []).length, 1);
});

test('fatsheets service: project workbook in, new version of that entry out', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-fatsheets-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.placeEntry('', 'Eunice FAT.xlsm', 'from the team', (target) => writeFile(target, workbookPackage()));
    await files.placeEntry('', 'auto.html', 'automatic FAT run', (target) => writeFile(target, report(TESTS)));
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const jobs = new JobRegistry();
    const service = new FatSheetsService({ workspace, jobs });
    const filesFor = async () => files;

    await assert.rejects(service.generate(filesFor, { workbook: { name: 'x.docx', buffer: Buffer.alloc(0) }, report: {} }), /not an \.xlsm/);

    const { job: jobId, run } = await service.generate(filesFor, {
      workbook: { project: 'P', path: 'Eunice FAT.xlsm' },
      report: { project: 'P', path: 'auto.html' },
      engineer: 'Noah Braue',
    });
    const job = await settled(jobs.get(jobId));
    assert.equal(job.status, 'done', job.error ?? '');
    assert.equal(job.result.note, 'Automatic FAT sheets: 4 fault, 1 open phase, 1 miscoordination, 2 abnormal from auto.html');
    assert.deepEqual(job.result.reports, [{ path: 'Eunice FAT.xlsm', label: 'Eunice FAT.xlsm' }]);

    const saved = await service.save(filesFor, run);
    assert.equal(saved.placed, 'Eunice FAT.xlsm');
    const entry = (await files.tree(() => null)).find((n) => n.name === 'Eunice FAT.xlsm');
    assert.equal(entry.versions.length, 1); // the workbook as it was, archived
    const live = readPackage(await files.read('Eunice FAT.xlsm'));
    assert.ok(sheetsOf(live).some((s) => s.name === 'Abnormal Condition Checkout'));

    // An uploaded workbook has no entry to version.
    const upload = await service.generate(filesFor, {
      workbook: { name: 'Up.xlsx', buffer: workbookPackage() },
      report: { name: 'auto.html', buffer: Buffer.from(report(TESTS)) },
    });
    assert.equal((await settled(jobs.get(upload.job))).status, 'done');
    await assert.rejects(service.save(filesFor, upload.run), /uploaded/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
