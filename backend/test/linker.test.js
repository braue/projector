// The comm layer: RTAC profile extraction from the real sample export, and
// linker tiers with synthetic profiles (an RDB-shaped relay profile with
// interfaces, which is what phase 2 will produce).

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRtacProfile } from '../lib/comm/extract/rtac.js';
import { linkProfiles } from '../lib/comm/linker.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { loadSample, sampleExists } from './helpers/loadSample.js';

test('RTAC extractor yields endpoints from the sample export', { skip: !sampleExists }, async () => {
  const model = parseRtacProject(await loadSample());
  const profile = extractRtacProfile(model, 'Sample');

  assert.equal(profile.source.type, 'rtac');
  assert.match(profile.model, /^SEL-/);
  assert.ok(profile.endpoints.length >= 20, `expected many endpoints, got ${profile.endpoints.length}`);

  const roles = new Set(profile.endpoints.map((e) => e.role));
  assert.ok(roles.has('client') && roles.has('server'));

  const serial = profile.endpoints.filter((e) => e.transport === 'serial');
  assert.ok(serial.length > 0, 'sample has serial connections');
  assert.ok(serial.every((e) => e.serial?.port), 'serial endpoints carry their com port');

  // Every endpoint renders human-readable lines for the popup.
  assert.ok(profile.endpoints.every((e) => Array.isArray(e.lines)));
});

// --- synthetic profiles for tier tests --------------------------------------

const rtacProfile = {
  name: 'RTAC_MAIN',
  model: 'SEL-3555',
  source: { type: 'rtac', ref: 'RTAC_MAIN' },
  interfaces: [],
  endpoints: [
    {
      id: 'c1', name: 'FEEDER_DNP', role: 'client', protocol: 'DNP', transport: 'tcp',
      remoteAddress: '10.10.1.21', remotePort: '20000',
      addressing: { selfDnp: '0', peerDnp: '4' }, lines: ['dials 10.10.1.21 : 20000'],
    },
    {
      id: 'c2', name: 'BUSTIE_DNP', role: 'client', protocol: 'DNP', transport: 'tcp',
      remoteAddress: '10.10.1.22', remotePort: '20000',
      addressing: { selfDnp: '0', peerDnp: '4' }, lines: ['dials 10.10.1.22 : 20000'],
    },
    {
      id: 'c3', name: 'GHOST_MB', role: 'client', protocol: 'Modbus', transport: 'tcp',
      remoteAddress: '10.10.1.60', remotePort: '502', addressing: {}, lines: [],
    },
    {
      id: 's1', name: 'COM_SEL', role: 'client', protocol: 'SEL', transport: 'serial',
      serial: { port: 'Com_03', baud: '19200' }, addressing: {}, lines: ['Com_03 · 19200 baud'],
    },
  ],
};

const relay = (name, ip, { port = '20000', dnp = '4', protocol = 'DNP' } = {}) => ({
  name,
  model: 'SEL-451',
  source: { type: 'rdb', ref: `${name}.rdb` },
  interfaces: [{ kind: 'ethernet', name: 'Port 5', ip }],
  endpoints: [
    {
      id: 'srv', name: 'DNP server', role: 'server', protocol, transport: 'tcp',
      localPort: port, addressing: { selfDnp: dnp }, lines: [`listens : ${port}`],
    },
  ],
});

test('linker tiers: confirmed, conflict, declared + ghost dedupe', () => {
  const { links, ghosts } = linkProfiles([
    { id: 'rtac', profile: rtacProfile },
    { id: 'feeder', profile: relay('FEEDER_1', '10.10.1.21') },
    { id: 'bustie', profile: relay('BUS_TIE', '10.10.1.22', { port: '20001', dnp: '3' }) },
  ]);

  const byEndpoint = Object.fromEntries(links.map((link) => [link.id.split(':')[1], link]));

  assert.equal(byEndpoint.c1.tier, 'confirmed');
  assert.equal(byEndpoint.c1.targetDeviceId, 'feeder');
  assert.equal(byEndpoint.c1.warnings.length, 0);

  assert.equal(byEndpoint.c2.tier, 'conflict');
  assert.equal(byEndpoint.c2.targetDeviceId, 'bustie');
  const texts = byEndpoint.c2.warnings.map((w) => w.text).join(' | ');
  assert.match(texts, /Port mismatch/);
  assert.match(texts, /DNP address mismatch/);

  assert.equal(byEndpoint.c3.tier, 'declared');
  assert.ok(byEndpoint.c3.targetGhostId);
  assert.equal(byEndpoint.s1.tier, 'declared');

  // one ghost for the modbus address, one for the serial line
  assert.equal(ghosts.length, 2);
});

test('linker: probable when the IP owner states no matching server', () => {
  const silent = {
    ...relay('SILENT', '10.10.1.21'),
    endpoints: [],
  };
  const { links } = linkProfiles([
    { id: 'rtac', profile: rtacProfile },
    { id: 'silent', profile: silent },
  ]);
  const c1 = links.find((link) => link.id === 'rtac:c1');
  assert.equal(c1.tier, 'probable');
  assert.equal(c1.warnings[0].kind, 'warning');
});

test('manual serial links validate baud agreement', () => {
  const meter = {
    name: 'METER_3', model: 'SEL-735', source: { type: 'rdb', ref: 'm.rdb' }, interfaces: [],
    endpoints: [{ id: 'p3', name: 'Port 3', role: 'server', protocol: 'SEL', transport: 'serial', serial: { port: 'Port 3', baud: '9600' }, addressing: {}, lines: [] }],
  };
  const { links } = linkProfiles(
    [{ id: 'rtac', profile: rtacProfile }, { id: 'meter', profile: meter }],
    [{ id: 'm1', aDeviceId: 'rtac', aEndpointId: 's1', bDeviceId: 'meter', bEndpointId: 'p3' }],
  );
  const manual = links.find((link) => link.id === 'manual:m1');
  assert.equal(manual.tier, 'conflict');
  assert.match(manual.warnings[0].text, /Baud mismatch/);
});
