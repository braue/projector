// Parses the real sample export (Desktop/RTAC_PROJECT) end to end and checks
// that every file yields a module, the new kinds classify, and the semantic
// layer links what it should. Skips cleanly if the sample folder is absent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { loadSample, sampleExists } from './helpers/loadSample.js';

test('sample export parses fully', { skip: !sampleExists }, async () => {
  const files = await loadSample();
  const project = parseRtacProject(files);

  assert.equal(project.errors.length, 0,
    `parse errors: ${JSON.stringify(project.errors, null, 2)}`);
  assert.equal(project.items.length, files.length);
  assert.ok(project.name, 'project name from NavigatorLayout');

  // No file may fall through to the unknown bucket for this known sample.
  const other = project.items.filter((item) => item.category === 'other');
  assert.deepEqual(other.map((item) => item.file), []);

  // The kinds volture's parser lacked all classify.
  const kinds = new Set(project.items.map((item) => item.kind));
  for (const kind of ['GVL', 'DataType', 'CustomApplication', 'CustomApplicationDefinition', 'EtherCATNetwork']) {
    assert.ok(kinds.has(kind), `expected kind ${kind}`);
  }

  // ST logic carries source; graphical POUs are flagged instead.
  const st = project.items.find((item) => item.file.endsWith('STProgram.xml'));
  assert.match(st.code.interface, /PROGRAM STProgram/);
  const cfc = project.items.find((item) => item.file.endsWith('CFCProgram.xml'));
  assert.equal(cfc.hasArchivedContent, true);

  // Shared maps link to their server connections.
  const linked = project.items.filter((item) => item.sharedMap);
  assert.ok(linked.length >= 1, 'at least one server linked its shared map');

  // Connections classify into roles and derive endpoints somewhere.
  assert.ok(project.summary.clients > 0);
  assert.ok(project.summary.servers > 0);
  assert.ok(project.summary.totalPoints > 0);
});

test('an NGVL connection surfaces its variable list as code', () => {
  const xml = `<?xml version="1.0"?>
    <RTACModule>
      <Device>
        <ExportSource><Schema>39</Schema></ExportSource>
        <Name>Other_22</Name>
        <Manufacturer>Any</Manufacturer>
        <Model>Other</Model>
        <Connection>
          <Protocol>NGVL</Protocol>
          <ConnectionType>Ethernet</ConnectionType>
          <SettingPages><SettingPage><Name>Settings</Name>
            <Row><Setting><Column>Setting</Column><Value>GVL Type</Value></Setting>
                 <Setting><Column>Value</Column><Value>Transmit</Value></Setting></Row>
          </SettingPage></SettingPages>
          <Variables><![CDATA[VAR_GLOBAL
\tEXAMPLE_VAR1 : BOOL;
END_VAR
]]></Variables>
        </Connection>
      </Device>
    </RTACModule>`;
  const project = parseRtacProject([{ file: 'SEL_RTAC/NGVL/Other_22_NGVL.xml', xml }]);
  assert.equal(project.errors.length, 0);
  const [item] = project.items;
  assert.equal(item.protocol, 'NGVL');
  assert.match(item.code.implementation, /VAR_GLOBAL/);
  assert.match(item.code.implementation, /EXAMPLE_VAR1 : BOOL;/);
  // Ordinary connections must not grow a code block from this.
  assert.equal(project.items.every((i) => i.protocol === 'NGVL' || i.code == null), true);
});

test('unknown kinds still parse generically', () => {
  const xml = `<?xml version="1.0"?>
    <RTACModule>
      <ExportSource><Schema>39</Schema></ExportSource>
      <FutureWidget>
        <Name>Widget1</Name>
        <SettingPages><SettingPage><Name>Settings</Name>
          <Row><Setting><Column>Setting</Column><Value>Mode</Value></Setting>
               <Setting><Column>Value</Column><Value>Auto</Value></Setting></Row>
        </SettingPage></SettingPages>
      </FutureWidget>
    </RTACModule>`;
  const project = parseRtacProject([{ file: 'Future/Widget1.xml', xml }]);
  assert.equal(project.errors.length, 0);
  const [item] = project.items;
  assert.equal(item.kind, 'FutureWidget');
  assert.equal(item.category, 'other');
  assert.equal(item.name, 'Widget1');
  assert.equal(item.settings.Mode, 'Auto');
});
