import assert from 'node:assert/strict';
import test from 'node:test';

import { compareReportPdf } from '../lib/report.js';
import { lineDiff } from '../lib/lineDiff.js';
import { modelSignature } from '../lib/compare.js';
import { CompareService } from '../services/compare.js';

const entry = (path, item) => ({ path, name: path, item, signature: modelSignature(item) });

const service = new CompareService({
  adapters: {
    fake: async (ref) => (ref === 'orig'
      ? {
        label: 'Original Export',
        entries: [
          entry('Same.xml', { settings: { A: '1' } }),
          entry('Edited.xml', { settings: { Baud: '9600' }, pages: [] }),
          entry('Gone.xml', { settings: {} }),
        ],
      }
      : {
        label: 'New Export',
        entries: [
          entry('Same.xml', { settings: { A: '1' } }),
          entry('Edited.xml', { settings: { Baud: '19200' }, pages: [] }),
          entry('New.xml', { settings: {} }),
        ],
      }),
  },
});

test('report carries only the differences, path-sorted, with diffs for edits', async () => {
  const report = await service.report({ type: 'fake', ref: 'orig' }, { type: 'fake', ref: 'new' });

  assert.equal(report.original, 'Original Export');
  assert.equal(report.updated, 'New Export');
  assert.deepEqual(report.summary, { added: 1, removed: 1, edited: 1, unchanged: 1 });
  assert.deepEqual(report.items.map((item) => [item.path, item.status]), [
    ['Edited.xml', 'edited'],
    ['Gone.xml', 'removed'],
    ['New.xml', 'added'],
  ]);
  const edited = report.items[0];
  assert.deepEqual(edited.diff.settings, [
    { key: 'Baud', original: '9600', updated: '19200', status: 'changed' },
  ]);
  assert.equal(report.items[1].diff, null);
  // Added/removed items carry their FULL content for the report to print.
  assert.deepEqual(report.items[1].item, { settings: {} }); // Gone.xml, from the original
  assert.deepEqual(report.items[2].item, { settings: {} }); // New.xml, from the update
  assert.equal(edited.item, null);
});

test('the report renders to a PDF', async () => {
  const report = await service.report({ type: 'fake', ref: 'orig' }, { type: 'fake', ref: 'new' });
  const bytes = await compareReportPdf(report, { project: 'demo', type: 'fake' });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(bytes.length > 1000);
});

test('lineDiff (backend twin) numbers each side and matches the app LCS', () => {
  const lines = lineDiff('a\nb\nc\nb', 'b\nc\nd\nb');
  assert.deepEqual(
    lines.filter((line) => line.kind === 'del').map((line) => [line.oldNo, line.text]),
    [[1, 'a']],
  );
  assert.deepEqual(
    lines.filter((line) => line.kind === 'add').map((line) => [line.newNo, line.text]),
    [[3, 'd']],
  );
});

test('a part existing on only one side diffs as pure additions — no phantom blank line', () => {
  const lines = lineDiff('', 'x := 1;\n\ny := 2;');
  assert.deepEqual(lines.map((line) => line.kind), ['add', 'add', 'add']);
  assert.deepEqual(lines.map((line) => line.newNo), [1, 2, 3]);
  assert.deepEqual(lineDiff('', ''), []);
});
