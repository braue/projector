// Automatic FAT → FAT workbook: the conversion as one call. Parse the
// report, turn each test into its checkout-sheet column, and graft the four
// sheets into the workbook (see build.js). Pure buffers in and out — the
// service around it (../fatsheets.js) owns files, runs and versions.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAutoFat } from './autofat.js';
import { graftSheets } from './build.js';
import { columnFor } from './columns.js';
import { KIND_ORDER, SHEETS } from './layout.js';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../resources/fatSheets/checkout-template.xlsx');

/**
 * { workbook: Buffer, html: string, engineer?: string, template?: Buffer }
 *   → { buffer, title, sheets: [{kind, name, count, replaced}], bands,
 *       flagged: [{ index, kind, sheet, column, feeder, status, comment }] }
 */
async function convertAutoFat({ workbook, html, engineer = '', template }) {
  const { title, tests } = parseAutoFat(html);
  if (!tests.length) throw new Error('the report has no fault, open phase, miscoordination or abnormal tests');
  const plainTests = tests.filter((t) => !t.abnormal);
  const byKind = Object.fromEntries(KIND_ORDER.map((kind) => [kind, []]));
  for (const test of tests) {
    byKind[test.kind].push({
      feeder: test.feeder,
      test,
      values: columnFor(test.kind, test, { engineer, plainTests }),
    });
  }
  const result = graftSheets(workbook, template ?? await readFile(TEMPLATE), byKind);

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
  }
  return { buffer: result.buffer, title, sheets: result.sheets, bands: result.bands, flagged };
}

export { convertAutoFat };
