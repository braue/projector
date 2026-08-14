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
  assert.deepEqual(shifted.pages[0].added, [{ label: 'NEW', row: { Dest: '', Src: 'NEW' } }]);
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
  // which positional pairing must not fold into one "changed" row. Both
  // report their whole row.
  assert.deepEqual(diff.pages[0].added, [{ label: 'Charlie', row: { Name: 'Charlie', Val: '9' } }]);
  assert.deepEqual(diff.pages[0].removed, [{ label: 'Bravo', row: { Name: 'Bravo', Val: '2' } }]);
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
    columns: ['X'],
    added: [{ label: '2', row: { X: '2' } }],
    removed: [{ label: '1', row: { X: '1' } }],
    changed: [],
  }]);
  assert.equal(diff.code.interface, null); // unchanged part stays out of the diff
  assert.match(diff.code.implementation.updated, /new;/);
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
  // Changed rows carry the WHOLE row object on both sides plus the changed
  // column names — the UI renders them as real table rows.
  assert.deepEqual(tags.changed, [
    {
      label: 'BRK_2',
      original: { Destination: 'BRK_2', Source: 'SEL_451.BR2', Quality: 'True' },
      updated: { Destination: 'BRK_2', Source: 'SEL_735.BR2', Quality: 'False' },
      fields: ['Source', 'Quality'],
    },
  ]);
  // Positional leftovers with DIFFERENT identities split into a removal and
  // an addition — OLD_TAG did not "become" NEW_TAG.
  assert.deepEqual(tags.added, [
    { label: 'NEW_TAG', row: { Destination: 'NEW_TAG', Source: 'SEL_451.Y', Quality: 'True' } },
  ]);
  assert.deepEqual(tags.removed, [
    { label: 'OLD_TAG', row: { Destination: 'OLD_TAG', Source: 'SEL_451.X', Quality: 'True' } },
  ]);
  assert.deepEqual(tags.columns, ['Destination', 'Source', 'Quality']);
});

// The REAL Tag Processor shape (RTAC_PROJECT export): the lead column is
// Build (True on every row) — useless as identity — the actual row identity
// is DestinationTagName, and SolveOrder renumbers wholesale on every insert.
const tagProcessorPage = (rows) => [{
  name: 'Settings',
  columns: ['Build', 'DestinationTagName', 'LoggingEnable', 'SolveOrder'],
  rows: rows.map(([dest, logging], index) => ({
    Build: 'True',
    DestinationTagName: dest,
    LoggingEnable: logging,
    SolveOrder: String(index + 1),
  })),
}];

test('Tag Processor rows pair by their identity column, not the Build lead column', () => {
  const diff = diffItems(
    { settings: {}, points: [], pages: tagProcessorPage([
      ['SystemTags.User_Logged_On', 'True'],
      ['SystemTags.User_Logged_Off', 'True'],
      ['SystemTags.Password_Changed', 'True'],
      ['SystemTags.Settings_Changed', 'True'],
    ]) },
    // One row inserted up top (renumbering everything below it) and one field
    // edited further down — the diff must NOT pair unrelated rows.
    { settings: {}, points: [], pages: tagProcessorPage([
      ['SystemTags.Brand_New_Tag', 'True'],
      ['SystemTags.User_Logged_On', 'True'],
      ['SystemTags.User_Logged_Off', 'True'],
      ['SystemTags.Password_Changed', 'False'],
      ['SystemTags.Settings_Changed', 'True'],
    ]) },
  );

  const [page] = diff.pages;
  assert.equal(page.status, 'changed');
  assert.equal(page.added.length, 1);
  assert.equal(page.added[0].row.DestinationTagName, 'SystemTags.Brand_New_Tag');
  assert.deepEqual(page.removed, []);
  assert.equal(page.changed.length, 1);
  assert.equal(page.changed[0].label, 'SystemTags.Password_Changed');
  assert.equal(page.changed[0].original.LoggingEnable, 'True');
  assert.equal(page.changed[0].updated.LoggingEnable, 'False');
  assert.deepEqual(page.changed[0].fields, ['LoggingEnable']);
});

test('a replaced destination splits into removed + added, not a fake edit', () => {
  // Boilerplate columns (Build, DTDataType) make any two Tag Processor rows
  // look mostly similar — but rows with different destinations are
  // different rows, even when the positional pass pairs them.
  const diff = diffItems(
    { settings: {}, points: [], pages: tagProcessorPage([
      ['SystemTags.Station_Alarm', 'True'],
      ['SystemTags.Bus_Undervoltage', 'False'],
    ]) },
    { settings: {}, points: [], pages: tagProcessorPage([
      ['SystemTags.Station_Alarm', 'True'],
      ['SystemTags.Transformer_Sudden_Pressure', 'True'],
    ]) },
  );

  const [page] = diff.pages;
  assert.deepEqual(page.changed, []);
  assert.equal(page.added.length, 1);
  assert.equal(page.added[0].row.DestinationTagName, 'SystemTags.Transformer_Sudden_Pressure');
  assert.equal(page.removed.length, 1);
  assert.equal(page.removed[0].row.DestinationTagName, 'SystemTags.Bus_Undervoltage');
});

test('an edit to a distinct numeric DATA column is reported, never eaten as order', () => {
  // Near-unique numeric alone must not make a column an "order" — register
  // addresses and DNP indices are data. Only a contiguous 1..N run is.
  const page = (rows) => [{
    name: 'Map',
    columns: ['Tag', 'Address'],
    rows: rows.map(([tag, address]) => ({ Tag: tag, Address: address })),
  }];
  const diff = diffItems(
    { settings: {}, points: [], pages: page([['A', '300'], ['B', '301'], ['C', '400']]) },
    { settings: {}, points: [], pages: page([['A', '300'], ['B', '333'], ['C', '400']]) },
  );
  const [map] = diff.pages;
  assert.equal(map.status, 'changed');
  assert.equal(map.changed.length, 1);
  assert.equal(map.changed[0].label, 'B');
  assert.equal(map.changed[0].original.Address, '301');
  assert.equal(map.changed[0].updated.Address, '333');
  assert.deepEqual(map.changed[0].fields, ['Address']);
});

test('the leftmost qualified key beats a more-unique free-text column', () => {
  // TagName (one duplicate) is the designed identity; Description is unique
  // prose. Editing a description must read as ONE changed row, not as the
  // row being removed and an unrelated one added.
  const page = (rows) => [{
    name: 'Tags',
    columns: ['TagName', 'Description'],
    rows: rows.map(([tag, desc]) => ({ TagName: tag, Description: desc })),
  }];
  const diff = diffItems(
    { settings: {}, points: [], pages: page([
      ['PUMP_1', 'Main pump'], ['VALVE_1', 'Inlet valve'], ['VALVE_1', 'Inlet valve twin'],
      ['BRKR_1', 'Feeder breaker'], ['XFMR_1', 'Station transformer'],
    ]) },
    { settings: {}, points: [], pages: page([
      ['PUMP_1', 'Main pump'], ['VALVE_1', 'Inlet valve'], ['VALVE_1', 'Inlet valve twin'],
      ['BRKR_1', 'Feeder breaker REVISED'], ['XFMR_1', 'Station transformer'],
    ]) },
  );
  const [tags] = diff.pages;
  assert.deepEqual(tags.added, []);
  assert.deepEqual(tags.removed, []);
  assert.equal(tags.changed.length, 1);
  assert.equal(tags.changed[0].label, 'BRKR_1');
});

test('SolveOrder is declared a row-number column — ignored even when NOT contiguous', () => {
  // The user's call: solve order corresponds to the row number, full stop.
  // Even a sparse/gapped SolveOrder (5, 10, 20) must never read as an edit.
  const page = (orders) => [{
    name: 'Settings',
    columns: ['DestinationTagName', 'SolveOrder'],
    rows: orders.map((order, i) => ({ DestinationTagName: `SystemTags.T${i}`, SolveOrder: order })),
  }];
  const diff = diffItems(
    { settings: {}, points: [], pages: page(['5', '10', '20']) },
    { settings: {}, points: [], pages: page(['6', '11', '21']) },
  );
  assert.deepEqual(diff.pages, [{ name: 'Settings', status: 'reordered', rows: 3 }]);
});

test('code diffs normalize line endings and split parts, with no phantom lines', () => {
  const diff = diffItems(
    { settings: {}, points: [], pages: [], code: { interface: null, implementation: 'a;\r\nb;' } },
    { settings: {}, points: [], pages: [], code: { interface: 'VAR x : BOOL; END_VAR', implementation: 'a;\nb;' } },
  );
  // CRLF-vs-LF alone is not an implementation edit; the added interface is.
  assert.equal(diff.code.implementation, null);
  assert.deepEqual(diff.code.interface, { original: null, updated: 'VAR x : BOOL; END_VAR' });
});

test('a SolveOrder renumber alone reads reordered, not N edits', () => {
  const rows = [
    ['SystemTags.User_Logged_On', 'True'],
    ['SystemTags.User_Logged_Off', 'True'],
    ['SystemTags.Password_Changed', 'True'],
  ];
  const [original] = tagProcessorPage(rows);
  const [updated] = tagProcessorPage([rows[2], rows[0], rows[1]]);
  const diff = diffItems(
    { settings: {}, points: [], pages: [original] },
    { settings: {}, points: [], pages: [updated] },
  );
  assert.deepEqual(diff.pages, [{ name: 'Settings', status: 'reordered', rows: 3 }]);
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
