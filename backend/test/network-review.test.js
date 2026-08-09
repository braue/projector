// The linker's whole-network review behaviors: IP route sanity (off-subnet
// with no gateway), layer-2 reachability for same-subnet traffic through the
// drawn fabric, workspace-wide diagnostics (duplicate IPs, GOOSE wire
// identifier collisions), and manual serial pairing (which resolves the
// "far end unknown" ghost).

import assert from 'node:assert/strict';
import test from 'node:test';

import { linkProfiles } from '../lib/comm/linker.js';

// Profile factories — the linker only sees DeviceProfiles, so these stay
// hand-rolled and minimal.
function client({ name = 'CLIENT', ip = '10.0.0.10', mask = '255.255.255.0', gateway = null, dials, port = 20000 }) {
  return {
    name,
    manufacturer: 'SEL',
    model: 'RTAC',
    source: { type: 'rtac', ref: name },
    interfaces: [{ kind: 'ethernet', name: 'Eth01', ip, mask, gateway }],
    endpoints: [{
      id: 'c1',
      name: 'poll',
      role: 'client',
      protocol: 'DNP',
      transport: 'tcp',
      remoteAddress: dials,
      remotePort: port,
      localPort: null,
      serial: null,
      addressing: {},
      lines: [`Connects to ${dials} port ${port}`],
    }],
  };
}

function server({ name = 'RELAY', ip = '10.0.0.40', mask = '255.255.255.0', port = 20000 }) {
  return {
    name,
    manufacturer: 'SEL',
    model: 'SEL-751',
    source: { type: 'rdb', ref: `demo::${name}` },
    interfaces: [{ kind: 'ethernet', name: 'Port 1', ip, mask, gateway: null }],
    endpoints: [{
      id: 's1',
      name: 'DNP server',
      role: 'server',
      protocol: 'DNP',
      transport: 'tcp',
      remoteAddress: null,
      remotePort: null,
      localPort: port,
      serial: null,
      addressing: {},
      lines: [`Listens on port ${port}`],
    }],
  };
}

// A two-port switch: eth1 carries VLAN 10 only, eth2 carries VLAN 20 only,
// eth3 carries both.
const SWITCH = {
  name: 'SW-1',
  manufacturer: 'SEL',
  model: 'SEL-2730M',
  kind: 'switch',
  source: { type: 'sw', ref: 'sw::SW-1' },
  interfaces: [],
  endpoints: [],
  ports: [
    { id: 'eth1', number: 1, name: null, enabled: true, speed: null, taggedVlans: [], untaggedVlans: [10] },
    { id: 'eth2', number: 2, name: null, enabled: true, speed: null, taggedVlans: [], untaggedVlans: [20] },
    { id: 'eth3', number: 3, name: null, enabled: true, speed: null, taggedVlans: [10, 20], untaggedVlans: [] },
  ],
};

test('dialing off-subnet with no gateway warns; a stated gateway satisfies it', () => {
  // 10.0.0.10/24 dialing 192.168.5.2 — different network, no gateway.
  const routeless = linkProfiles([
    { id: 'c', profile: client({ dials: '192.168.5.2' }) },
  ]);
  assert.match(routeless.links[0].warnings.map((w) => w.text).join(' | '),
    /dials 192\.168\.5\.2 outside its stated subnets and states no gateway/);

  // Same dial with a gateway: routable, no route warning.
  const routed = linkProfiles([
    { id: 'c', profile: client({ dials: '192.168.5.2', gateway: '10.0.0.1' }) },
  ]);
  assert.ok(!routed.links[0].warnings.some((w) => w.text.includes('no route')));

  // On-subnet dial never warns, gateway or not.
  const onLink = linkProfiles([
    { id: 'c', profile: client({ dials: '10.0.0.40' }) },
    { id: 's', profile: server({}) },
  ]);
  const link = onLink.links.find((l) => l.targetDeviceId === 's');
  assert.equal(link.tier, 'confirmed');
  assert.deepEqual(link.warnings, []);
});

test('same-subnet ends drawn into switch ports that share no VLAN conflict', () => {
  const devices = [
    { id: 'c', profile: client({ dials: '10.0.0.40' }) },
    { id: 's', profile: server({}) },
    { id: 'sw', profile: SWITCH },
  ];

  // eth1 (VLAN 10) vs eth2 (VLAN 20): no shared VLAN — no L2 path.
  const split = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'c', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 's', bDeviceId: 'sw', bPort: 'eth2' },
  ]);
  const broken = split.links.find((l) => l.targetDeviceId === 's');
  assert.equal(broken.tier, 'conflict');
  assert.match(broken.warnings[0].text, /share no VLAN — same-subnet traffic cannot pass/);

  // eth1 (VLAN 10) vs eth3 (10 + 20): shared VLAN — clean.
  const joined = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'c', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 's', bDeviceId: 'sw', bPort: 'eth3' },
  ]);
  const clean = joined.links.find((l) => l.targetDeviceId === 's');
  assert.equal(clean.tier, 'confirmed');
  assert.deepEqual(clean.warnings, []);
});

test('diagnostics: duplicate IPs and GOOSE wire collisions across the workspace', () => {
  const goosePublisher = (name, { mac, appId }) => ({
    name,
    manufacturer: 'SEL',
    model: 'SEL-487B',
    source: { type: 'scd', ref: `f::${name}` },
    identity: { namespace: 'scd:f', name },
    interfaces: [],
    endpoints: [{
      id: 'goose:CFG/GPub01',
      name: 'GPub01',
      role: 'server',
      protocol: 'GOOSE',
      transport: 'ethernet',
      addressing: {},
      goose: { mac, appId, vlanId: null, vlan: null },
      lines: [],
    }],
  });

  const { diagnostics } = linkProfiles([
    { id: 'a', profile: client({ name: 'RTAC_A', ip: '10.0.0.5' }) },
    { id: 'b', profile: server({ name: 'RELAY_B', ip: '10.0.0.5' }) }, // same IP
    { id: 'p1', profile: goosePublisher('IED_1', { mac: '01-0C-CD-01-00-01', appId: '1001' }) },
    { id: 'p2', profile: goosePublisher('IED_2', { mac: '01-0C-CD-01-00-01', appId: '1001' }) },
  ]);

  const texts = diagnostics.map((d) => d.text).join(' | ');
  assert.match(texts, /IP 10\.0\.0\.5 is set on RTAC_A \(Eth01\) and RELAY_B \(Port 1\)/);
  assert.match(texts, /GOOSE APPID 1001 is used by IED_1 GPub01 and IED_2 GPub01/);
  assert.match(texts, /GOOSE multicast MAC 01-0C-CD-01-00-01 is used by/);

  // The same IED carried twice (standalone + attached) shares an identity —
  // colliding with itself is not a finding.
  const doubled = linkProfiles([
    { id: 'p1', profile: goosePublisher('IED_1', { mac: '01-0C-CD-01-00-01', appId: '1001' }) },
    { id: 'p1-again', profile: goosePublisher('IED_1', { mac: '01-0C-CD-01-00-01', appId: '1001' }) },
  ]);
  assert.deepEqual(doubled.diagnostics, []);
});

test('a manual serial pair resolves the declared ghost and validates baud', () => {
  const serialDevice = (name, endpointId, baud, role = 'client') => ({
    name,
    manufacturer: 'SEL',
    model: 'RTAC',
    source: { type: 'rtac', ref: name },
    interfaces: [],
    endpoints: [{
      id: endpointId,
      name: `${name} serial`,
      role,
      protocol: 'SEL',
      transport: 'serial',
      serial: { port: 'COM1', baud },
      addressing: {},
      lines: [`Serial port COM1 · ${baud} baud`],
    }],
  });
  const devices = [
    { id: 'a', profile: serialDevice('RTAC_1', 'ser1', '9600') },
    { id: 'b', profile: serialDevice('RELAY_9', 'ser2', '9600') },
  ];

  // Unpaired: the client line dangles as a declared ghost.
  const unpaired = linkProfiles(devices);
  assert.ok(unpaired.links.some((l) => l.tier === 'declared' && l.transport === 'serial'));

  // Paired: the ghost is gone, replaced by the manual link.
  const paired = linkProfiles(devices, [
    { id: 'sp1', type: 'serial', aDeviceId: 'a', aEndpointId: 'ser1', bDeviceId: 'b', bEndpointId: 'ser2' },
  ]);
  assert.ok(!paired.links.some((l) => l.tier === 'declared' && l.transport === 'serial'));
  const manual = paired.links.find((l) => l.manualId === 'sp1');
  assert.equal(manual.tier, 'manual');

  // A baud mismatch on the drawn pair is a conflict.
  const mismatched = linkProfiles([
    { id: 'a', profile: serialDevice('RTAC_1', 'ser1', '9600') },
    { id: 'b', profile: serialDevice('RELAY_9', 'ser2', '19200') },
  ], [
    { id: 'sp1', type: 'serial', aDeviceId: 'a', aEndpointId: 'ser1', bDeviceId: 'b', bEndpointId: 'ser2' },
  ]);
  const bad = mismatched.links.find((l) => l.manualId === 'sp1');
  assert.equal(bad.tier, 'conflict');
  assert.match(bad.warnings[0].text, /Baud mismatch/);
});
