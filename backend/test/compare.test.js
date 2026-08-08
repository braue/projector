import assert from 'node:assert/strict';
import test from 'node:test';

import { compareHashes, diffItems } from '../lib/compare.js';

test('compareHashes classifies added/removed/edited/unchanged', () => {
  const original = new Map([['a.xml', '1'], ['b.xml', '2'], ['c.xml', '3']]);
  const updated = new Map([['a.xml', '1'], ['b.xml', '9'], ['d.xml', '4']]);
  const status = compareHashes(original, updated);
  assert.equal(status.get('a.xml'), 'unchanged');
  assert.equal(status.get('b.xml'), 'edited');
  assert.equal(status.get('c.xml'), 'removed');
  assert.equal(status.get('d.xml'), 'added');
});

test('diffItems reports settings, points, and code changes', () => {
  const original = {
    settings: { 'Baud Rate': '9600', 'Data Bits': '8', Gone: 'x' },
    points: [
      { page: 'Binary Inputs', tagName: 'BI_00', raw: { 'Tag Name': 'BI_00', Enable: 'True' } },
      { page: 'Binary Inputs', tagName: 'BI_01', raw: { 'Tag Name': 'BI_01', Enable: 'True' } },
    ],
    pages: [{ name: 'Extra', columns: ['X'], rows: [{ X: '1' }] }],
    code: { interface: 'PROGRAM P', implementation: 'old;' },
  };
  const updated = {
    settings: { 'Baud Rate': '19200', 'Data Bits': '8', New: 'y' },
    points: [
      { page: 'Binary Inputs', tagName: 'BI_00', raw: { 'Tag Name': 'BI_00', Enable: 'False' } },
      { page: 'Binary Inputs', tagName: 'BI_02', raw: { 'Tag Name': 'BI_02', Enable: 'True' } },
    ],
    pages: [{ name: 'Extra', columns: ['X'], rows: [{ X: '2' }] }],
    code: { interface: 'PROGRAM P', implementation: 'new;' },
  };

  const diff = diffItems(original, updated);

  const byKey = Object.fromEntries(diff.settings.map((s) => [s.key, s]));
  assert.equal(byKey['Baud Rate'].status, 'changed');
  assert.equal(byKey['Baud Rate'].updated, '19200');
  assert.equal(byKey.Gone.status, 'removed');
  assert.equal(byKey.New.status, 'added');
  assert.equal(byKey['Data Bits'], undefined);

  assert.deepEqual(diff.points.added, [{ page: 'Binary Inputs', tag: 'BI_02' }]);
  assert.deepEqual(diff.points.removed, [{ page: 'Binary Inputs', tag: 'BI_01' }]);
  assert.equal(diff.points.changed.length, 1);
  assert.deepEqual(diff.points.changed[0].fields, [
    { column: 'Enable', original: 'True', updated: 'False' },
  ]);

  assert.deepEqual(diff.pages, [{ name: 'Extra', status: 'changed', rows: 1 }]);
  assert.match(diff.code.updated, /new;/);
});

test('diffItems handles added and removed items (one side null)', () => {
  const item = { settings: { A: '1' }, points: [], pages: [] };
  const added = diffItems(null, item);
  assert.equal(added.settings[0].status, 'added');
  const removed = diffItems(item, null);
  assert.equal(removed.settings[0].status, 'removed');
});
