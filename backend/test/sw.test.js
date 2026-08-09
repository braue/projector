// SW parser: a synthetic minimal switch export proves the general shapes
// (port list, default + static VLANs, port ranges, management addresses),
// and the real SEL-2730M export on the Desktop — like the RTAC and SCD
// samples, not committed — verifies against ground truth when present.

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSw } from '../lib/parsers/sw/index.js';
import { MINI_SW } from './helpers/miniSw.js';

const SAMPLE = process.env.SW_SAMPLE
  ?? path.join(os.homedir(), 'Desktop', 'example_sw.xml');
const sampleExists = await access(SAMPLE).then(() => true, () => false);

test('parseSw models a minimal switch export: nameplate, ports, VLANs, interfaces', () => {
  const model = parseSw(MINI_SW);

  assert.equal(model.nameplate.type, 'SEL-2730M');
  assert.equal(model.nameplate.id, 'SW-STATION-A');
  assert.equal(model.hostname, 'SW-STATION-A');
  assert.equal(model.defaultGateway, '10.0.0.1');
  assert.equal(model.vlanAware, true);

  // Ports: 1-based numbers, decoded speed, verbatim enable state and label.
  assert.equal(model.ports.length, 4);
  assert.deepEqual(model.ports[0], {
    number: 1, id: 'eth1', name: 'To RTAC', enabled: true, speed: '1G full',
  });
  assert.equal(model.ports[2].enabled, false);
  assert.equal(model.ports[3].speed, '100M full');

  // VLANs: the default VLAN leads, static VLANs keep their authored port
  // lists — including a range ("1-3").
  assert.equal(model.vlans.length, 3);
  assert.deepEqual(model.vlans[0], {
    vid: 1, name: 'Default', isDefault: true, taggedPorts: [], untaggedPorts: [],
  });
  assert.deepEqual(model.vlans[1], {
    vid: 20, name: 'GOOSE-BAY1', isDefault: false, taggedPorts: [1, 2], untaggedPorts: [4],
  });
  assert.deepEqual(model.vlans[2].taggedPorts, [1, 2, 3]);

  // Management interfaces: CIDR split, service flags filtered to enabled.
  assert.equal(model.interfaces.length, 1);
  const [mgmt] = model.interfaces;
  assert.equal(mgmt.id, 'Mgmt');
  assert.equal(mgmt.vlan, 1000);
  assert.deepEqual(mgmt.addresses, [
    { ip: '10.0.0.30', prefix: 24, alias: 'Mgmt', services: ['HTTPS'] },
  ]);

  assert.equal(model.ports.filter((port) => port.enabled).length, 3);
});

test('parseSw rejects non-switch XML', () => {
  assert.throws(() => parseSw('<NotASwitch />'), /not a switch settings export/);
  assert.throws(() => parseSw('<Configuration><Settings /></Configuration>'), /not a switch settings export/);
});

test('parseSw handles a sparse export (nameplate only)', () => {
  const model = parseSw('<Configuration><Nameplate><Type>SEL-2730M</Type></Nameplate></Configuration>');
  assert.equal(model.nameplate.type, 'SEL-2730M');
  assert.deepEqual(model.ports, []);
  assert.deepEqual(model.vlans, []);
  assert.deepEqual(model.interfaces, []);
});

test('real SEL-2730M export parses to ground truth', { skip: !sampleExists }, async () => {
  const model = parseSw(await readFile(SAMPLE, 'utf8'));

  assert.equal(model.nameplate.type, 'SEL-2730M');
  assert.equal(model.nameplate.id, 'SEL2730M-UPS143-EAST');
  assert.equal(model.hostname, 'SEL2730M-UPS143-EAST');
  assert.equal(model.defaultGateway, '10.3.90.1');
  assert.equal(model.rstpMode, 'STP_RSTP_MODE');
  assert.equal(model.ports.length, 24);
  assert.equal(model.ports.filter((port) => port.enabled).length, 5);
  assert.equal(model.vlans.length, 51);
  assert.equal(model.interfaces.length, 2);

  // The trunk ports carry every SEL2411 VLAN tagged.
  const vlan20 = model.vlans.find((vlan) => vlan.vid === 20);
  assert.equal(vlan20.name, 'SEL2411-IDF252-255');
  assert.deepEqual(vlan20.taggedPorts, [1, 2]);

  // Management interface: routable address, HTTPS + SNMP answering.
  const mgmt = model.interfaces.find((iface) => iface.id === 'Mgmt');
  assert.equal(mgmt.vlan, 1000);
  assert.deepEqual(mgmt.addresses, [
    { ip: '10.3.90.15', prefix: 24, alias: 'SEL2730M-UPS143-EAST', services: ['HTTPS', 'SNMP'] },
  ]);
});
