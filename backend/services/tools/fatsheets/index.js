// Automatic FAT → FAT workbook: the conversion as one call. Parse the
// report, pick each sheet's tests (fault and open phase paired per segment,
// one per feeder where the checkout is done once per feeder — see select.js), turn each into its column, and graft the four
// sheets into the workbook (see build.js). Pure buffers in and out — the
// service around it (../fatsheets.js) owns files, runs and versions.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAutoFat } from './autofat.js';
import { graftSheets } from './build.js';
import { columnFor } from './columns.js';
import { KIND_ORDER, SHEETS } from './layout.js';
import { selectSheets } from './select.js';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../resources/fatSheets/checkout-template.xlsx');

/** The report's feeders, in report order, with how many tests each has. */
function reportFeeders(html) {
  const { title, tests } = parseAutoFat(html);
  const counts = new Map();
  for (const t of tests) counts.set(t.feeder, (counts.get(t.feeder) ?? 0) + 1);
  return { title, feeders: [...counts].map(([feeder, count]) => ({ feeder, tests: count })) };
}

/**
 * { workbook: Buffer, html: string, engineer?: string, feeders?: string[],
 *   bands?: [{ name, color, feeders }], template?: Buffer }
 *   `feeders` limits the run to those feeders' tests (all when omitted).
 *   `bands` says which feeder sits under which substation and each
 *   substation's colour ('RRGGBB'); without it they are read from the
 *   workbook's Under Frequency / Loss of Source sheets.
 *   All four sheets are always rewritten, a kind with no tests left empty.
 *   → { buffer, title, sheets: [{kind, name, count, inReport, replaced}], bands,
 *       flagged: [{ index, kind, sheet, column, feeder, status, comment }],
 *       unpaired: [{ location, feeders, reason, tests }], abnormalUnmatched: [feeder] }
 */
async function convertAutoFat({ workbook, html, engineer = '', feeders = null, bands = null, template }) {
  const parsed = parseAutoFat(html);
  const { title } = parsed;
  if (!parsed.tests.length) throw new Error('the report has no fault, open phase, miscoordination or abnormal tests');
  const wanted = feeders ? new Set(feeders) : null;
  const tests = wanted ? parsed.tests.filter((t) => wanted.has(t.feeder)) : parsed.tests;
  if (!tests.length) throw new Error('none of the picked feeders has tests in the report');
  const selected = selectSheets(tests);
  // An abnormal column's baseline answer reads off the fault-sheet test it re-runs.
  const plainTests = [...selected.fault, ...tests.filter((t) => !t.abnormal)];
  const byKind = {};
  const inReport = {};
  for (const kind of KIND_ORDER) {
    inReport[kind] = tests.filter((t) => t.kind === kind).length;
    byKind[kind] = selected[kind].map((test) => ({
      feeder: test.feeder,
      test,
      values: columnFor(kind, test, { engineer, plainTests }),
    }));
  }
  const result = graftSheets(workbook, template ?? await readFile(TEMPLATE), byKind, { bands });

  // Where the tests that need a second look landed. graftSheets sorts each
  // sheet's columns by substation/feeder, so positions come from its order.
  const flagged = [];
  for (const sheet of result.sheets) {
    sheet.columns.forEach((column, i) => {
      if (column.test.status === 'Complete') return;
      flagged.push({
        index: column.test.index,
        kind: sheet.kind,
        sheet: sheet.name,
        column: `${SHEETS[sheet.kind].prefix}-${i + 1}`,
        feeder: column.feeder,
        status: column.test.status,
        comment: column.values.comments,
      });
    });
    delete sheet.columns;
    sheet.inReport = inReport[sheet.kind];
  }
  return { buffer: result.buffer, title, sheets: result.sheets, bands: result.bands, flagged,
    unpaired: selected.unpaired, abnormalUnmatched: selected.abnormalUnmatched };
}

export { convertAutoFat, reportFeeders };
