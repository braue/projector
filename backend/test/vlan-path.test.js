// Universal layer-2 checking.
//
// VLAN membership used to be judged only for GOOSE — the one thing that
// states its own VLAN — and only across trunks reachable from the publisher.
// Any ordinary DNP or Modbus link riding the same fabric went unchecked. It
// is the same physical question either way: is there a VLAN that survives
// every hop between these two? These cases are all plain TCP links.

import assert from 'node:assert/strict';
import test from 'node:test';

import { linkProfiles } from '../lib/comm/linker.js';
import { checkFor, problems } from './helpers/checks.js';

const iface = (ip) => [{ kind: 'ethernet', name: 'eth0', ip, mask: '255.255.255.0' }];

const client = (name, ip, remote) => ({
  name,
  source: { type: 'rtac', ref: name },
  interfaces: iface(ip),
  endpoints: [{
    id: 'c1', name: 'DNP', role: 'client', protocol: 'DNP', transport: 'tcp',
    remoteAddress: remote, remotePort: '20000', addressing: {}, lines: [],
  }],
});

const server = (name, ip) => ({
  name,
  source: { type: 'rdb', ref: name },
  interfaces: iface(ip),
  endpoints: [{
    id: 's1', name: 'DNP', role: 'server', protocol: 'DNP', transport: 'tcp',
    localPort: '20000', addressing: {}, lines: [],
  }],
});

/** A switch whose ports are described by { id: [vlans] }; [] = states none. */
const switchOf = (name, ports) => ({
  name,
  kind: 'switch',
  source: { type: 'sw', ref: name },
  interfaces: [],
  endpoints: [],
  ports: Object.entries(ports).map(([id, vlans]) => ({
    id, enabled: true, taggedVlans: vlans, untaggedVlans: [],
  })),
});

const pair = () => [
  { id: 'rtac', profile: client('RTAC_1', '10.0.0.1', '10.0.0.5') },
  { id: 'relay', profile: server('FEEDER_1', '10.0.0.5') },
];

const l2 = (result) =>
  checkFor(result.links.find((link) => !link.manualId && link.targetDeviceId), 'Layer-2 path');

test('a plain TCP link across two trunks is checked hop by hop', () => {
  const devices = [
    ...pair(),
    { id: 'swa', profile: switchOf('SW_A', { eth1: [10], eth2: [10, 20] }) },
    { id: 'swb', profile: switchOf('SW_B', { eth1: [10, 20], eth2: [10] }) },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 't1', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  assert.equal(l2(result).status, 'pass');
  assert.match(l2(result).detail, /VLAN 10 carries end to end/);
});

test('a trunk that drops the only common VLAN breaks the link and names the port', () => {
  const devices = [
    ...pair(),
    { id: 'swa', profile: switchOf('SW_A', { eth1: [10], eth2: [10] }) },
    // The trunk lands on a port that carries only VLAN 30.
    { id: 'swb', profile: switchOf('SW_B', { eth1: [30], eth2: [10] }) },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 't1', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  const check = l2(result);
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /SW_B port eth1 does not carry VLAN 10 — frames stop here/);
  // A failing check is what makes a link a conflict.
  const link = result.links.find((entry) => !entry.manualId && entry.targetDeviceId);
  assert.equal(link.tier, 'conflict');
});

test('redundant fabric: if any drawn path carries the VLAN, the traffic gets through', () => {
  const devices = [
    ...pair(),
    // The short way is through SW_X, whose two ports share no VLAN with each
    // other — a frame arriving on one cannot leave by the other.
    { id: 'swx', profile: switchOf('SW_X', { eth1: [98], eth2: [99] }) },
    { id: 'swa', profile: switchOf('SW_A', { eth1: [10], eth2: [10] }) },
    { id: 'swb', profile: switchOf('SW_B', { eth1: [10], eth2: [10] }) },
  ];
  const result = linkProfiles(devices, [
    // One hop, but blocked.
    { id: 'x1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swx', bPort: 'eth1' },
    { id: 'x2', type: 'ethernet', aDeviceId: 'swx', aPort: 'eth2', bDeviceId: 'relay' },
    // Two hops, and clean.
    { id: 'a1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 'ab', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'b1', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  assert.equal(l2(result).status, 'pass');
  assert.match(l2(result).detail, /VLAN 10 carries end to end/);
});

test('a switch that states no VLAN membership leaves the check unknown, never failed', () => {
  const devices = [
    ...pair(),
    { id: 'sw', profile: switchOf('SW_1', { eth1: [], eth2: [] }) },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'sw', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  assert.equal(l2(result).status, 'unknown');
  assert.match(l2(result).detail, /states its VLAN membership/);
});

test('a partly silent path reports what it could not check rather than passing', () => {
  const devices = [
    ...pair(),
    { id: 'swa', profile: switchOf('SW_A', { eth1: [10], eth2: [10] }) },
    { id: 'swb', profile: switchOf('SW_B', { eth1: [], eth2: [] }) },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'swa', bPort: 'eth1' },
    { id: 't1', type: 'ethernet', aDeviceId: 'swa', aPort: 'eth2', bDeviceId: 'swb', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'swb', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  const check = l2(result);
  assert.equal(check.status, 'unknown');
  assert.match(check.detail, /2 ports state no VLAN membership/);
});

test('routed traffic is not judged at layer 2 — a gateway may change VLAN', () => {
  const devices = [
    // 10.0.0.1/24 dialing 192.168.5.9: off-subnet, so a router is involved.
    { id: 'rtac', profile: {
      ...client('RTAC_1', '10.0.0.1', '192.168.5.9'),
      interfaces: [{ kind: 'ethernet', name: 'eth0', ip: '10.0.0.1', mask: '255.255.255.0', gateway: '10.0.0.254' }],
    } },
    { id: 'relay', profile: server('FEEDER_1', '192.168.5.9') },
    { id: 'sw', profile: switchOf('SW_1', { eth1: [10], eth2: [20] }) },
  ];
  const result = linkProfiles(devices, [
    { id: 'm1', type: 'ethernet', aDeviceId: 'rtac', bDeviceId: 'sw', bPort: 'eth1' },
    { id: 'm2', type: 'ethernet', aDeviceId: 'sw', aPort: 'eth2', bDeviceId: 'relay' },
  ]);

  // Ports share no VLAN, but these two are not layer-2 neighbours anyway.
  const link = result.links.find((entry) => !entry.manualId && entry.targetDeviceId);
  assert.equal(checkFor(link, 'Layer-2 path'), undefined);
  assert.deepEqual(problems(link), []);
  assert.equal(link.tier, 'confirmed');
});

test('every link carries a checklist, whether or not anything is wrong', () => {
  const result = linkProfiles(pair(), []);
  const link = result.links.find((entry) => entry.targetDeviceId);
  assert.ok(link.checks.length >= 3);
  assert.ok(link.checks.every((entry) => entry.label && entry.detail));
  assert.ok(link.checks.every(
    (entry) => ['pass', 'fail', 'warn', 'unknown'].includes(entry.status),
  ));
});
