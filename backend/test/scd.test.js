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

  // Publisher side: dataset + control blocks on LN0. Each FCDA resolves
  // through the IED's own DOI/DAI tree to its device source — attribute-level
  // via the named DAI, DO-level by collecting every non-immediate source
  // under the DO (the imm:100 deadband never surfaces).
  const relay = model.ieds.find((ied) => ied.name === 'RELAY_1');
  const [ldevice] = relay.accessPoints[0].ldevices;
  assert.equal(ldevice.logicalNodes, 3);
  assert.deepEqual(ldevice.datasets, [{
    name: 'GPDSet01',
    desc: null,
    points: [
      { fc: 'ST', path: 'CFG.GGIO1.Ind001.stVal', source: 'IN101', units: null },
      { fc: 'MX', path: 'CFG.METGGIO2.AnIn001.*', source: 'VBAT', units: null },
      { fc: 'MX', path: 'CFG.METGGIO2.AnIn001.instMag.f', source: 'VBAT', units: 'V' },
    ],
  }]);

  // GOOSE control with its SEL transmit privates.
  const [gpub] = ldevice.gooseControls;
  assert.equal(gpub.appId, 'Bay1');
  assert.equal(gpub.minTime, '4');
  assert.equal(gpub.maxTime, '1000');
  assert.equal(gpub.txAddress['MAC-Address'], '01-0C-CD-01-00-01');
  assert.equal(gpub.txAddress['VLAN-ID'], '001');

  // Report control with full trigger/option configuration.
  const [brep] = ldevice.reportControls;
  assert.equal(brep.buffered, true);
  assert.equal(brep.bufTime, '500');
  assert.deepEqual(brep.trgOps, { dchg: true, dupd: false, qchg: true, period: true });
  assert.equal(brep.intgPd, '60000');
  assert.deepEqual(brep.optFields, {
    seqNum: true, timeStamp: true, dataSet: false, reasonCode: true,
    dataRef: false, bufOvfl: false, entryID: false, configRef: false,
  });
  assert.equal(brep.maxClients, '2');

  // Subscriber side: one bound ref groups to a subscription, the unbound
  // template slot is only tallied. The bound ref carries its formatted
  // publisher-side source (control block -> data path).
  const rtu = model.ieds.find((ied) => ied.name === 'RTU_1');
  assert.deepEqual(rtu.subscriptions, [
    { publisher: 'RELAY_1', serviceType: 'GOOSE', control: 'CFG/GPub01', points: 1 },
  ]);
  const [extRef] = rtu.accessPoints[0].ldevices[0].extRefs;
  assert.equal(extRef.intAddr, 'SPS001.stVal');
  assert.equal(extRef.source, 'RELAY_1/CFG/LLN0/GPub01.CFG.GGIO1.Ind001.stVal');
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

  // Device pedigree from the SEL_IedInfo private.
  assert.equal(rtac.firmware, 'R154');
  assert.ok(rtac.modelNumbers.includes('SEL-3530'));

  // Point-level receive map: each bound ExtRef formatted publisher-side.
  const [firstRx] = rtac.accessPoints
    .flatMap((accessPoint) => accessPoint.ldevices)
    .flatMap((ldevice) => ldevice.extRefs);
  assert.equal(firstRx.intAddr, 'SPS001.stVal');
  assert.equal(firstRx.source, 'SEL_487B_1/CFG/LLN0/GPub01.ANN.VBGGIO1.Ind001.stVal');

  // The 487B's GOOSE dataset resolves through its own DOI/DAI tree to relay
  // word bits; quality attributes carry no address model and stay null.
  const relay487b = model.ieds.find((ied) => ied.name === 'SEL_487B_1');
  const ldCfg = relay487b.accessPoints[0].ldevices.find((ld) => ld.inst === 'CFG');
  const gpds = ldCfg.datasets.find((ds) => ds.name === 'GPDSet01');
  assert.deepEqual(gpds.points[0], {
    fc: 'ST', path: 'ANN.VBGGIO1.Ind001.stVal', source: 'VB001', units: null,
  });
  assert.equal(gpds.points[1].source, null);

  // GOOSE control block with its SEL transmit privates.
  const [gpub487b] = ldCfg.gooseControls;
  assert.equal(gpub487b.txAddress['MAC-Address'], '01-0C-CD-01-00-04');
  assert.equal(gpub487b.minTime, '4');
  assert.equal(gpub487b.maxTime, '1000');
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
