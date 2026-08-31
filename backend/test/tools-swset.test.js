// SWSET: XML primitives round-trip and the parse -> edit -> generate flow
// over a real SEL-2730M factory-default configuration.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SwsetService } from '../services/tools/swset/index.js';
import {
  collectSettings,
  parseConfigXml,
  xmlGet,
  xmlSet,
} from '../services/tools/swset/xml.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const SAMPLE = '/home/noah/Work/old-tools/SWSET V0.3/Default/SEL2730M/R106-V0.xml';

const XML = `<?xml version="1.0"?>
<Configuration>
  <Nameplate><Type>2730M</Type><FID>SEL-2730M-R106-V0</FID></Nameplate>
  <Settings>
    <CompositeSetting name="device_contact">
      <Settings>
        <CompositeSetting name="contact_info">
          <Settings>
            <Setting name="GS_CONTACT_ST"><Value>Ops Desk</Value></Setting>
            <Setting name="GS_LOCATION_ST"><Value/></Setting>
          </Settings>
        </CompositeSetting>
      </Settings>
    </CompositeSetting>
    <CompositeSetting name="alarm_contact">
      <Settings>
        <CompositeSetting name="alarm_signal_settings">
          <Settings>
            <Setting name="IO_ALMAUTH_TYPE_ST"><Value>IO_ALM_PULSE</Value></Setting>
          </Settings>
        </CompositeSetting>
      </Settings>
    </CompositeSetting>
  </Settings>
</Configuration>`;

test('swset xml: collect, translated get, and set round-trip', () => {
  const doc = parseConfigXml(XML);
  const config = doc.Configuration;
  const settings = collectSettings(config);

  assert.equal(xmlGet(settings, ['device_contact', 'contact_info', 'GS_CONTACT_ST']), 'Ops Desk');
  // Empty element reads as null -> the UI's ''.
  assert.equal(xmlGet(settings, ['device_contact', 'contact_info', 'GS_LOCATION_ST']), null);
  // Enum tokens translate on read.
  assert.equal(
    xmlGet(settings, ['alarm_contact', 'alarm_signal_settings', 'IO_ALMAUTH_TYPE_ST']),
    'Pulse',
  );
  assert.equal(xmlGet(settings, ['nope', 'x'], 'fallback'), 'fallback');

  // Writes land in the ORIGINAL doc; display labels translate back to tokens.
  assert.ok(xmlSet(config, ['alarm_contact', 'alarm_signal_settings', 'IO_ALMAUTH_TYPE_ST'], 'Latch (Manual Clear)'));
  assert.equal(
    xmlGet(collectSettings(config), ['alarm_contact', 'alarm_signal_settings', 'IO_ALMAUTH_TYPE_ST']),
    'Latch (Manual Clear)',
  );
  // create=false refuses paths that do not exist; create=true builds them.
  assert.equal(xmlSet(config, ['brand_new', 'leaf'], 'x'), false);
  assert.ok(xmlSet(config, ['brand_new', 'leaf'], 'x', { create: true }));
});

test('swset schema: constrained fields carry the workbook dropdown vocabularies', async () => {
  const { buildSchema273x } = await import('../services/tools/swset/schema273x.js');
  const { sections } = buildSchema273x({ Type: 'SEL-2730M' });
  const table = (id) => sections.flatMap((s) => s.tables).find((t) => t.id === id);

  // The Excel data validations, verbatim.
  const rstp = table('tbl_RSTP');
  assert.deepEqual(rstp.fields.find((f) => f.id === 'stpMode').options, ['OFF', 'RSTP']);
  assert.equal(rstp.fields.find((f) => f.id === 'bridgePriority').options.length, 16);
  const ports = table('tbl_PortSettings');
  assert.deepEqual(ports.columns.find((c) => c.id === 'enabled').options, ['True', 'False']);
  assert.equal(ports.columns.find((c) => c.id === 'ingressRate').options.length, 12);
  // Speed/duplex is row-block-dependent: SFP, combo, then Fast Ethernet.
  const speed = ports.columns.find((c) => c.id === 'speedDuplex');
  assert.deepEqual(speed.optionsByRow[0], { start: 0, end: 3, options: ['Auto', '1Gbps Full Duplex'] });
  assert.equal(speed.optionsByRow[2].options.length, 5);
  // Enum vocabularies from the translation table.
  const users = table('tbl_LocalUser');
  assert.deepEqual(users.columns.find((c) => c.id === 'role').options, ['Admin', 'Engineer', 'User Manager', 'Monitor']);
  assert.deepEqual(
    table('tbl_SyslogLocal').fields[0].options,
    ['Informational', 'Notice', 'Warning', 'Error', 'Critical', 'Alert'],
  );
  // Free-form fields stay free: no options on text-shaped settings.
  assert.equal(table('tbl_Global').fields.find((f) => f.id === 'contact').options, undefined);
  assert.equal(table('tbl_IP').columns.find((c) => c.id === 'ipAddress').options, undefined);
});

test('swset service: parse -> edit -> generate over a real 2730M default', { skip: !existsSync(SAMPLE) }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-swset-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const service = new SwsetService({ workspace });

    const text = await readFile(SAMPLE);
    const parsed = await service.parse({ originalname: 'R106-V0.xml', buffer: text });
    assert.equal(parsed.deviceType, '2730M');
    assert.equal(parsed.sections.length, 5);
    const system = parsed.sections.find((s) => s.id === 'system');
    const global = system.tables.find((t) => t.id === 'tbl_Global');
    assert.ok(global.fields.some((f) => f.label === 'Contact'));

    const result = await service.generate(parsed.run, {
      tbl_Global: { fields: { [global.fields.find((f) => f.label === 'Contact').id]: 'Noah B' } },
    });
    assert.ok(result.applied >= 1);
    assert.equal(result.reports.length, 1);
    assert.match(result.reports[0].path, /updated\.xml$/);

    // The emitted XML carries the edit and still parses as the same device.
    const output = (await workspace.readFile('swset', parsed.run, result.reports[0].path)).toString();
    assert.ok(output.includes('Noah B'));
    const reparsed = await service.parse({ originalname: 'again.xml', buffer: Buffer.from(output) });
    const again = reparsed.sections.find((s) => s.id === 'system').tables.find((t) => t.id === 'tbl_Global');
    const contactId = again.fields.find((f) => f.label === 'Contact').id;
    assert.equal(again.values[contactId], 'Noah B');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
