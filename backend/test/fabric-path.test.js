// Riding the drawn fabric: a logical link between two devices is a statement
// about the two of them, but its frames travel the cables the user drew. When
// a drawn path exists, the linker resolves the link onto it (`path`, an
// ordered list of segment ids) so the canvas can run the wire through the
// switch instead of cutting a chord across it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { linkProfiles } from '../lib/comm/linker.js';

const ethernet = (ip) => [{ kind: 'ethernet', name: 'eth0', ip, mask: '255.255.255.0' }];

const client = (name, ip, remote) => ({
  name,
  source: { type: 'rtac', ref: name },
  interfaces: ethernet(ip),
  endpoints: [{
    id: 'c1', name: 'DNP', role: 'client', protocol: 'DNP', transport: 'tcp',
    remoteAddress: remote, remotePort: '20000', addressing: {}, lines: [],
  }],
});

const server = (name, ip) => ({
  name,
  source: { type: 'rdb', ref: name },
  interfaces: ethernet(ip),
  endpoints: [{
    id: 's1', name: 'DNP', role: 'server', protocol: 'DNP', transport: 'tcp',
    localPort: '20000', addressing: {}, lines: [],
  }],
});

const switchProfile = (name, portCount = 4) => ({
  name,
  kind: 'switch',
  source: { type: 'sw', ref: name },
  interfaces: [],
  endpoints: [],
  ports: Array.from({ length: portCount }, (_, i) => ({
    id: `eth${i + 1}`, enabled: true, taggedVlans: [], untaggedVlans: [1],
  })),
});

const logical = (result) => result.links.find((link) => !link.manualId && link.targetDeviceId);

test('a logical link through one switch rides both drawn cables', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'sw', profile: switchProfile('SW_1') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', aPort: 'eth1', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'sw', aPort: 'eth2', bDeviceId: 'relay', bPort: 'eth0' },
  ]);

  const link = logical(result);
  assert.equal(link.tier, 'confirmed');
  assert.deepEqual(link.path, ['m1', 'm2']);
});

test('multi-hop: the path walks every switch between the two ends', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'swa', profile: switchProfile('SW_A') },
    { id: 'swb', profile: switchProfile('SW_B') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'm3', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  assert.deepEqual(logical(result).path, ['m1', 'm2', 'm3']);
});

test('the shortest run wins when the fabric offers two', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'swa', profile: switchProfile('SW_A') },
    { id: 'swb', profile: switchProfile('SW_B') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    // The long way round: rtac -> swa -> swb -> relay.
    { id: 'long1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 'long2', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'long3', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
    // ...and one switch both ends also hang off.
    { id: 'short1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swb', bPort: 'eth3' },
  ]);

  assert.deepEqual(logical(result).path, ['short1', 'long3']);
});

test('a directly drawn cable is itself the path — no chord beside it', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'relay' },
  ]);

  assert.deepEqual(logical(result).path, ['m1']);
});

test('no drawn fabric means no path — the link stays direct', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  assert.equal(logical(linkProfiles(devices, [])).path, undefined);
});

test('an end device is a destination, never a corridor', () => {
  // relay_b sits between the RTAC and relay_a by cable, but it is not a
  // switch: frames do not transit it, so there is no path to ride.
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'relay_b', profile: server('FEEDER_2', '10.0.0.6') },
    { id: 'relay_a', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'relay_b' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'relay_b', bDeviceId: 'relay_a' },
  ]);

  assert.equal(logical(result).path, undefined);
});

test('a cable that reaches nowhere near the far end leaves the link direct', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'sw', profile: switchProfile('SW_1') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  // Only the RTAC is cabled; the relay hangs off nothing.
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'sw', bPort: 'eth1' },
  ]);

  assert.equal(logical(result).path, undefined);
});

test('manual links never ride themselves', () => {
  const devices = [
    { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
    { id: 'sw', profile: switchProfile('SW_1') },
    { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'sw', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  for (const link of result.links.filter((candidate) => candidate.manualId)) {
    assert.equal(link.path, undefined, `${link.manualId} should carry no path of its own`);
  }
});
