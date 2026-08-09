// SCD parser: a synthetic minimal SCL proves the general shapes (including
// fast-xml-parser's single-element collapse and unbound ExtRef slots), and
// the real Architect export on the Desktop — like the RTAC sample, too big
// to commit — verifies against ground truth when present.

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseScd } from '../lib/parsers/scd/index.js';
import { MINI_SCL } from './helpers/miniScl.js';

const SAMPLE = process.env.SCD_SAMPLE
  ?? path.join(os.homedir(), 'Desktop', 'example_scd.scd');
const sampleExists = await access(SAMPLE).then(() => true, () => false);

test('parseScd models a minimal SCL: comm, publications, bound vs unbound subscriptions', () => {
  const model = parseScd(MINI_SCL);

  assert.equal(model.header.id, 'mini');
  assert.equal(model.header.toolId, 'hand-rolled');

  // Communication: single-element collapse everywhere (one subnet, one AP...).
  assert.equal(model.subNetworks.length, 1);
  const [ap] = model.subNetworks[0].connectedAps;
  assert.equal(ap.iedName, 'RELAY_1');
  assert.equal(ap.address.IP, '10.0.0.5');
  assert.deepEqual(ap.ports, ['Port 5']);
  assert.equal(ap.gses[0].cbName, 'GPub01');
  assert.equal(ap.gses[0].address['MAC-Address'], '01-0C-CD-01-00-01');

  // Publisher side: dataset + control blocks on LN0.
  const relay = model.ieds.find((ied) => ied.name === 'RELAY_1');
  const [ldevice] = relay.accessPoints[0].ldevices;
  assert.equal(ldevice.logicalNodes, 2);
  assert.deepEqual(ldevice.datasets, [{ name: 'GPDSet01', desc: null, points: 1 }]);
  assert.equal(ldevice.gooseControls[0].appId, 'Bay1');
  assert.equal(ldevice.reportControls[0].buffered, true);

  // Subscriber side: one bound ref groups to a subscription, the unbound
  // template slot is only tallied.
  const rtu = model.ieds.find((ied) => ied.name === 'RTU_1');
  assert.deepEqual(rtu.subscriptions, [
    { publisher: 'RELAY_1', serviceType: 'GOOSE', control: 'CFG/GPub01', points: 1 },
  ]);
  assert.equal(rtu.accessPoints[0].ldevices[0].unboundExtRefs, 1);

  assert.equal(model.summary.boundExtRefs, 1);
  assert.equal(model.summary.unboundExtRefs, 1);
});

test('parseScd rejects non-SCL XML', () => {
  assert.throws(() => parseScd('<NotScl />'), /missing <SCL> root/);
});

test('parseScd handles a sparse SCL (no Communication, no IEDs)', () => {
  const model = parseScd('<SCL><Header id="empty" /></SCL>');
  assert.equal(model.header.id, 'empty');
  assert.deepEqual(model.ieds, []);
  assert.deepEqual(model.subNetworks, []);
});

test('real Architect export parses to ground truth', { skip: !sampleExists }, async () => {
  const model = parseScd(await readFile(SAMPLE, 'utf8'));

  assert.equal(model.header.id, 'example_scd');
  assert.match(model.header.toolId, /Architect/);
  assert.deepEqual(model.summary, {
    ieds: 3,
    subNetworks: 11,
    connectedAps: 12,
    gooseControls: 2,
    reportControls: 28,
    smvControls: 0,
    boundExtRefs: 6,
    unboundExtRefs: 2180,
  });

  assert.deepEqual(model.ieds.map((ied) => ied.name), ['SEL_RTAC_1', 'SEL_487B_1', 'SEL_751_1']);

  // The declared links: RTAC consumes the 487B's GOOSE, the 487B the 751's.
  const rtac = model.ieds.find((ied) => ied.name === 'SEL_RTAC_1');
  assert.deepEqual(rtac.subscriptions, [
    { publisher: 'SEL_487B_1', serviceType: 'GOOSE', control: 'CFG/GPub01', points: 4 },
  ]);
  const relay487 = model.ieds.find((ied) => ied.name === 'SEL_487B_1');
  assert.deepEqual(relay487.subscriptions, [
    { publisher: 'SEL_751_1', serviceType: 'GOOSE', control: 'CFG/GPub01', points: 2 },
  ]);

  // The RTAC's first interface carries the only IP in this file.
  const eth01 = model.subNetworks[0].connectedAps[0];
  assert.equal(eth01.iedName, 'SEL_RTAC_1');
  assert.equal(eth01.address.IP, '123.123.123.123');

  // The 487B's GOOSE publication has its multicast wire address.
  const relayAp = model.subNetworks
    .flatMap((sn) => sn.connectedAps)
    .find((ap) => ap.iedName === 'SEL_487B_1');
  assert.deepEqual(relayAp.gses[0].address, {
    'MAC-Address': '01-0C-CD-01-00-04',
    APPID: '1004',
    'VLAN-PRIORITY': '4',
    'VLAN-ID': '001',
  });
});
