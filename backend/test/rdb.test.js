// RDB pipeline: a synthetic-but-real CFB database round-trips through the
// parser, the extractor turns its sections into interfaces/endpoints, and the
// linker matches it against an RTAC-shaped client — the ghost-snapping story.

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRdbProfile } from '../lib/comm/extract/rdb.js';
import { failures } from './helpers/checks.js';
import { linkProfiles } from '../lib/comm/linker.js';
import { parseRdb } from '../lib/parsers/rdb/index.js';
import { makeRdb } from './helpers/makeRdb.js';

const DEMO_PROFILES = [
  {
    name: 'FEEDER_1',
    relayType: 'SEL-751A',
    partNo: '751A51ABA0X71850230',
    sections: [
      {
        key: 'P5', desc: 'Port 5',
        settings: { IPADDR: '123.123.123.123', SUBNETM: '255.255.255.0' },
      },
      { key: 'D1', desc: 'DNP', settings: { DNPADR: '2', DNPTPRT: '20000' } },
      { key: 'P3', desc: 'Port 3', settings: { SPEED: '19200', PROTO: 'SEL', BITS: '8', PARITY: 'N', STOPBIT: '1' } },
      { key: 'G', desc: 'Global', settings: { TID: 'FEEDER RELAY 1' } },
    ],
  },
];

test('parseRdb round-trips a CFB database', () => {
  const { profiles } = parseRdb(makeRdb(DEMO_PROFILES));
  assert.equal(profiles.length, 1);
  const [profile] = profiles;
  assert.equal(profile.name, 'FEEDER_1');
  assert.equal(profile.info.RELAYTYPE, 'SEL-751A');
  assert.equal(profile.sections.length, 4);
  const p5 = profile.sections.find((s) => s.key === 'P5');
  assert.equal(p5.desc, 'Port 5');
  assert.equal(p5.settings.IPADDR, '123.123.123.123');
});

test('extractRdbProfile: interfaces, servers, serial from the rule table', () => {
  const { profiles } = parseRdb(makeRdb(DEMO_PROFILES));
  const profile = extractRdbProfile(profiles[0], 'demo::FEEDER_1');

  assert.equal(profile.model, 'SEL-751A');
  assert.equal(profile.partNumber, '751A51ABA0X71850230');
  assert.deepEqual(profile.interfaces, [
    { kind: 'ethernet', name: 'Port 5', ip: '123.123.123.123', mask: '255.255.255.0', gateway: null },
  ]);

  const dnp = profile.endpoints.find((e) => e.protocol === 'DNP' && e.transport === 'tcp');
  assert.equal(dnp.role, 'server');
  assert.equal(dnp.localPort, '20000');
  assert.equal(dnp.addressing.selfDnp, '2');

  const serial = profile.endpoints.find((e) => e.transport === 'serial');
  assert.equal(serial.protocol, 'SEL');
  assert.equal(serial.serial.baud, '19200');
});

test('linker: RTAC client vs RDB relay — confirmed, and conflict on a second client', () => {
  const { profiles } = parseRdb(makeRdb(DEMO_PROFILES));
  const relay = extractRdbProfile(profiles[0], 'demo::FEEDER_1');

  // Shaped like the sample export's two DNP clients: both dial the same IP,
  // one on the relay's port with the right address, one on another port
  // expecting a different address.
  const rtac = {
    name: 'RTAC', model: 'SEL-3555', source: { type: 'rtac', ref: 'RTAC' }, interfaces: [],
    endpoints: [
      { id: 'ok', name: 'Other_3', role: 'client', protocol: 'DNP', transport: 'tcp',
        remoteAddress: '123.123.123.123', remotePort: '20000',
        addressing: { selfDnp: '0', peerDnp: '2' }, lines: [] },
      { id: 'bad', name: 'SEL_787L_1', role: 'client', protocol: 'DNP', transport: 'tcp',
        remoteAddress: '123.123.123.123', remotePort: '20006',
        addressing: { selfDnp: '0', peerDnp: '1' }, lines: [] },
    ],
  };

  const { links, ghosts } = linkProfiles([
    { id: 'rtac', profile: rtac },
    { id: 'relay', profile: relay },
  ]);

  const ok = links.find((l) => l.id === 'rtac:ok');
  assert.equal(ok.tier, 'confirmed');
  assert.equal(ok.targetDeviceId, 'relay');

  const bad = links.find((l) => l.id === 'rtac:bad');
  assert.equal(bad.tier, 'conflict');
  assert.deepEqual(failures(bad).map((entry) => entry.label), ['TCP port', 'DNP addressing']);

  // Both clients resolved to the relay — no ghost for that address.
  assert.equal(ghosts.length, 0);
});
