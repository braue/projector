import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSignatures, diffItems, modelSignature } from '../lib/compare.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';

test('compareSignatures classifies added/removed/edited/unchanged', () => {
  const original = new Map([['a.xml', '1'], ['b.xml', '2'], ['c.xml', '3']]);
  const updated = new Map([['a.xml', '1'], ['b.xml', '9'], ['d.xml', '4']]);
  const status = compareSignatures(original, updated);
  assert.equal(status.get('a.xml'), 'unchanged');
  assert.equal(status.get('b.xml'), 'edited');
  assert.equal(status.get('c.xml'), 'removed');
  assert.equal(status.get('d.xml'), 'added');
});

// A connection file with one config setting; `noise` lets each variant differ
// in raw bytes (indentation, ControllerPOU blob content) without touching
// anything the parser models.
const deviceXml = ({ baud, noise = '' }) => `<?xml version="1.0"?>
<RTACModule>
  <ExportSource><Schema>1</Schema></ExportSource>
  <Device>${noise}
    <Name>Feeder</Name>
    <Protocol>DNPClient</Protocol>
    <ControllerPOU><![CDATA[<blob revision="${noise || 'base'}"/>]]></ControllerPOU>
    <SettingPage>
      <Name>Settings</Name>
      <Row>
        <Setting><Column>Setting</Column><Value>Baud Rate</Value></Setting>
        <Setting><Column>Value</Column><Value>${baud}</Value></Setting>
      </Row>
    </SettingPage>
  </Device>
</RTACModule>`;

const itemFor = (xml) => parseRtacProject([{ file: 'Feeder.xml', xml }]).items[0];

test('modelSignature ignores raw-XML noise; flags only modeled changes', () => {
  const base = itemFor(deviceXml({ baud: '9600' }));
  const noisy = itemFor(deviceXml({ baud: '9600', noise: '\n\n    ' }));
  const edited = itemFor(deviceXml({ baud: '19200' }));

  // Shifted whitespace and a different ControllerPOU blob: not an edit.
  assert.equal(modelSignature(base), modelSignature(noisy));
  // A changed setting value: an edit.
  assert.notEqual(modelSignature(base), modelSignature(edited));
});

test('graphical logic (ArchivedContent) edits still flag', () => {
  const pou = (blob) => `<?xml version="1.0"?>
<RTACModule>
  <ExportSource><Schema>1</Schema></ExportSource>
  <POU>
    <Name>Logic</Name>
    <POUKind>Program</POUKind>
    <ArchivedContent><![CDATA[${blob}]]></ArchivedContent>
  </POU>
</RTACModule>`;
  const a = itemFor(pou('<cfc rung="1"/>'));
  const b = itemFor(pou('<cfc rung="2"/>'));
  const aAgain = itemFor(pou('<cfc rung="1"/>'));

  assert.notEqual(modelSignature(a), modelSignature(b));
  assert.equal(modelSignature(a), modelSignature(aAgain));
  assert.equal(a.hasArchivedContent, true);

  // The diff states it as graphical logic, not a raw hash field.
  const diff = diffItems(a, b);
  assert.equal(diff.graphicalLogic, 'changed');
  assert.ok(!diff.otherFields.includes('archivedContentHash'));
  assert.ok(!diff.otherFields.includes('hasArchivedContent'));
});

test('ArchivedContent on a connection is RTAC plumbing, not user logic', () => {
  const item = itemFor(`<?xml version="1.0"?>
<RTACModule>
  <ExportSource><Schema>1</Schema></ExportSource>
  <Device>
    <Name>OPC</Name>
    <Protocol>OPCUAClient</Protocol>
    <ArchivedContent><![CDATA[<datasource v="1"/>]]></ArchivedContent>
  </Device>
</RTACModule>`);
  assert.equal(item.hasArchivedContent, undefined);
  assert.equal(item.archivedContentHash, undefined);
});

test('row matching is content-first: a shifted table is one added row', () => {
  // Rows with EMPTY lead cells previously fell back to positional identity,
  // so inserting one row at the top flagged every row below it as modified.
  const page = (rows) => [{ name: 'Map', columns: ['Dest', 'Src'], rows }];
  const shifted = diffItems(
    { settings: {}, points: [], pages: page([
      { Dest: '', Src: 'A' }, { Dest: '', Src: 'B' }, { Dest: '', Src: 'C' },
    ]) },
    { settings: {}, points: [], pages: page([
      { Dest: '', Src: 'NEW' }, { Dest: '', Src: 'A' }, { Dest: '', Src: 'B' }, { Dest: '', Src: 'C' },
    ]) },
  );
  assert.equal(shifted.pages[0].status, 'changed');
  assert.deepEqual(shifted.pages[0].added, ['NEW']);
  assert.deepEqual(shifted.pages[0].removed, []);
  assert.deepEqual(shifted.pages[0].changed, []);
});

test('an unrelated replaced row reads as removed + added, not changed', () => {
  const page = (rows) => [{ name: 'T', columns: ['Name', 'Val'], rows }];
  const diff = diffItems(
    { settings: {}, points: [], pages: page([{ Name: 'Alpha', Val: '1' }, { Name: 'Bravo', Val: '2' }]) },
    { settings: {}, points: [], pages: page([{ Name: 'Alpha', Val: '1' }, { Name: 'Charlie', Val: '9' }]) },
  );
  // Bravo and Charlie share no column value — a delete plus an addition,
  // which positional pairing must not fold into one "changed" row.
  assert.deepEqual(diff.pages[0].added, ['Charlie']);
  assert.deepEqual(diff.pages[0].removed, ['Bravo']);
  assert.deepEqual(diff.pages[0].changed, []);
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

  // The single-column row shares nothing between sides, so it reads as a
  // replacement, not an edit.
  assert.deepEqual(diff.pages, [{
    name: 'Extra',
    status: 'changed',
    rows: 1,
    added: ['2'],
    removed: ['1'],
    changed: [],
  }]);
  assert.match(diff.code.updated, /new;/);
});

test('generic page diff pinpoints rows and fields', () => {
  // A Tag Processor-style table: name-ish lead column, no Tag Name / Setting.
  const page = (rows) => [{ name: 'Tags', columns: ['Destination', 'Source', 'Quality'], rows }];
  const diff = diffItems(
    { settings: {}, points: [], pages: page([
      { Destination: 'BRK_1', Source: 'SEL_451.BR1', Quality: 'True' },
      { Destination: 'BRK_2', Source: 'SEL_451.BR2', Quality: 'True' },
      { Destination: 'OLD_TAG', Source: 'SEL_451.X', Quality: 'True' },
    ]) },
    { settings: {}, points: [], pages: page([
      { Destination: 'BRK_1', Source: 'SEL_451.BR1', Quality: 'True' },
      { Destination: 'BRK_2', Source: 'SEL_735.BR2', Quality: 'False' },
      { Destination: 'NEW_TAG', Source: 'SEL_451.Y', Quality: 'True' },
    ]) },
  );

  const [tags] = diff.pages;
  assert.equal(tags.status, 'changed');
  // BRK_2's source and quality changed, field by field.
  assert.deepEqual(tags.changed, [
    {
      row: 'BRK_2',
      fields: [
        { column: 'Source', original: 'SEL_451.BR2', updated: 'SEL_735.BR2' },
        { column: 'Quality', original: 'True', updated: 'False' },
      ],
    },
    // Unmatched leftovers pair positionally: OLD_TAG became NEW_TAG.
    {
      row: 'NEW_TAG',
      fields: [
        { column: 'Destination', original: 'OLD_TAG', updated: 'NEW_TAG' },
        { column: 'Source', original: 'SEL_451.X', updated: 'SEL_451.Y' },
      ],
    },
  ]);
  assert.deepEqual(tags.added, []);
  assert.deepEqual(tags.removed, []);
});

test('a page with the same rows in a different order reads reordered', () => {
  const page = (rows) => [{ name: 'Tags', columns: ['Destination', 'Source'], rows }];
  const rowA = { Destination: 'BRK_1', Source: 'X' };
  const rowB = { Destination: 'BRK_2', Source: 'Y' };
  const diff = diffItems(
    { settings: {}, points: [], pages: page([rowA, rowB]) },
    { settings: {}, points: [], pages: page([rowB, rowA]) },
  );
  assert.deepEqual(diff.pages, [{ name: 'Tags', status: 'reordered', rows: 2 }]);
});

test('diffItems handles added and removed items (one side null)', () => {
  const item = { settings: { A: '1' }, points: [], pages: [] };
  const added = diffItems(null, item);
  assert.equal(added.settings[0].status, 'added');
  const removed = diffItems(item, null);
  assert.equal(removed.settings[0].status, 'removed');
});
