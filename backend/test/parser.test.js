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

// --- kinds found in real field exports (USB corpus census, 2026-09) ----------

const wrap = (inner) => `<?xml version="1.0" encoding="utf-8"?><RTACModule>${inner}</RTACModule>`;

test('read-in items flatten their XML body into settings', () => {
  const { items } = parseRtacProject([{
    file: 'Advanced Read-in Items/Ethernet Settings.xml',
    xml: wrap(`<RTACBackupableObject>
      <ObjectName>Ethernet Settings</ObjectName>
      <ObjectText>
        <schema version="schema_38">
          <global_keep_alive time="10" probes="5" />
          <ipv4_network_interfaces ipv4_address="172.17.16.76/24" name="Eth_01">
            <static_routes destination="0.0.0.0/0" gateway="172.17.16.10" />
          </ipv4_network_interfaces>
          <ipv4_network_interfaces ipv4_address="192.168.2.2/24" name="Eth_02" />
        </schema>
      </ObjectText>
    </RTACBackupableObject>`),
  }]);
  const [item] = items;
  assert.equal(item.kind, 'RTACBackupableObject');
  assert.equal(item.category, 'system');
  assert.equal(item.name, 'Ethernet Settings');
  assert.equal(item.settings['schema/ipv4_network_interfaces[1] · ipv4_address'], '172.17.16.76/24');
  assert.equal(item.settings['schema/ipv4_network_interfaces[1]/static_routes · gateway'], '172.17.16.10');
  assert.equal(item.settings['schema/ipv4_network_interfaces[2] · name'], 'Eth_02');
  assert.equal(item.settings['schema/global_keep_alive · probes'], '5');
});

test('the main controller surfaces its task table', () => {
  const { items } = parseRtacProject([{
    file: 'System/Main Controller.xml',
    xml: wrap(`<MainController>
      <MainTask><CycleTime>100</CycleTime><WatchdogTime>15000</WatchdogTime></MainTask>
      <Task><Name>Automation</Name><CycleTime>1000</CycleTime><WatchdogTime>15000</WatchdogTime></Task>
    </MainController>`),
  }]);
  const [item] = items;
  assert.equal(item.settings['Main Task · Cycle Time (ms)'], '100');
  assert.equal(item.settings['Task Automation · Cycle Time (ms)'], '1000');
  assert.equal(item.settings['Task Automation · Watchdog Time (ms)'], '15000');
});

test('user libraries carry their nameplate; logic objects their type + fingerprint', () => {
  const { items } = parseRtacProject([
    {
      file: 'Libraries/DA_Simulator.xml',
      xml: wrap(`<UserLibrary>
        <Name>DA_Simulator</Name><Company>SEL ES</Company>
        <Title>DA_Simulator</Title><Version>1.8.2</Version>
      </UserLibrary>`),
    },
    {
      file: 'POUs/GlobalTextList.xml',
      xml: wrap(`<LogicEngineObject>
        <Name>GlobalTextList</Name><Type>TextList</Type>
        <ArchivedContent><![CDATA[<Single>blob</Single>]]></ArchivedContent>
      </LogicEngineObject>`),
    },
  ]);
  const library = items.find((item) => item.kind === 'UserLibrary');
  assert.equal(library.category, 'extension');
  assert.equal(library.settings.Version, '1.8.2');
  const textList = items.find((item) => item.kind === 'LogicEngineObject');
  assert.equal(textList.category, 'logic');
  assert.equal(textList.pouKind, 'TextList');
  assert.ok(textList.archivedContentHash, 'blob fingerprinted for compare');
});

test('visualizations classify with a fingerprinted screen blob', () => {
  const { items } = parseRtacProject([{
    file: 'Visualizations/Overview.xml',
    xml: wrap(`<Visualization>
      <Name>Overview</Name>
      <ArchivedContent><![CDATA[<Single>screen</Single>]]></ArchivedContent>
    </Visualization>`),
  }]);
  const [item] = items;
  assert.equal(item.category, 'visual');
  assert.equal(item.kindLabel, 'Visualization');
  assert.equal(item.hasArchivedContent, true);
  assert.ok(item.archivedContentHash);
});
