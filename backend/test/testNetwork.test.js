// The test network service: the bench table's rules, the legacy VLAN Deploy
// table carried over, and scans (the bridge swapped for a function).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TestNetworkService, validateDevices } from '../services/testNetwork.js';

test('test network: bench rows are cleaned, RTACs need an address, nothing repeats', () => {
  assert.deepEqual(validateDevices([
    { id: ' 3555-1 ', networkIp: '10.42.44.34', port: '03' },
    { id: 'Pi', kind: 'other', networkIp: '', port: '24' },
  ]), [
    { id: '3555-1', kind: 'rtac', networkIp: '10.42.44.34', port: '3' },
    { id: 'Pi', kind: 'other', networkIp: '', port: '24' },
  ]);
  assert.throws(() => validateDevices([{ id: 'a', port: '3' }]), /a network IP is required/);
  assert.throws(() => validateDevices([{ id: 'a', networkIp: '10.0.0.300', port: '3' }]), /not an IPv4/);
  assert.throws(() => validateDevices([
    { id: 'a', networkIp: '10.0.0.1', port: '3' }, { id: 'b', networkIp: '10.0.0.2', port: '3' },
  ]), /share the switch port 3/);
  // two non-RTACs without addresses are not a duplicate
  assert.equal(validateDevices([
    { id: 'a', kind: 'other', port: '1' }, { id: 'b', kind: 'other', port: '2' },
  ]).length, 2);
});

test('test network: legacy table carried over; one scan shared; event after', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'testnet-'));
  try {
    await mkdir(path.join(dir, 'tools', 'vlan-deploy'), { recursive: true });
    await writeFile(path.join(dir, 'tools', 'vlan-deploy', 'devices.json'),
      JSON.stringify([{ id: '3555-1', networkIp: '10.42.44.34', port: '3' }]));
    const published = [];
    let calls = 0;
    const svc = new TestNetworkService({
      dataDir: dir,
      jobs: null,
      events: { publish: (type) => published.push(type) },
      bridge: async (request) => {
        calls += 1;
        return { switch: { ip: request.switchIp, ports: [], vlans: [], error: null }, devices: [] };
      },
    });
    await svc.init();
    assert.deepEqual(await svc.devices(), [{ kind: 'rtac', id: '3555-1', networkIp: '10.42.44.34', port: '3' }]);
    const [a, b] = await Promise.all([svc.scan('10.42.44.12'), svc.scan('10.42.44.12')]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(a.bench[0].id, '3555-1');
    assert.deepEqual(published, ['test-network']);
    assert.equal(svc.state().scan, a);
    assert.throws(() => svc.scan('switch'), /not an IPv4/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('test network: a move goes by the scanned bench, one at a time, and patches the VLANs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'testnet-'));
  try {
    const calls = [];
    let active = 0;
    const svc = new TestNetworkService({
      dataDir: dir,
      jobs: null,
      bridge: async (request) => {
        if (request.command !== 'move') {
          return { bench: [{ id: '3555-1', kind: 'rtac', networkIp: '10.0.0.1', port: '3' },
            { id: '3532-3', kind: 'rtac', networkIp: '10.0.0.2', port: '4' }],
            switch: { ip: request.switchIp, ports: [3], vlans: [], error: null }, devices: [] };
        }
        active += 1;
        assert.equal(active, 1, 'moves overlap');
        calls.push(request);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { ports: request.ports, from: {}, to: request.vid, changed: true,
          vlans: [{ vid: request.vid, name: 'x', untagged: [3], tagged: [] }] };
      },
    });
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', devices: ['3555-1'], vid: 14 }), /not on the test network/);
    await svc.scan('10.42.44.12');
    const [a, b] = await Promise.all([
      svc.move({ switchIp: '10.42.44.12', devices: ['3555-1', '3532-3'], vid: 14 }),
      svc.move({ switchIp: '10.42.44.12', devices: ['3555-1'], vid: 16 }),
    ]);
    // several devices are one bridge call (one switch save); moves never overlap
    assert.deepEqual(calls.map((c) => [c.ports, c.vid]), [[[3, 4], 14], [[3], 16]]);
    assert.equal(a.to, 14);
    assert.equal(b.scan.switch.vlans[0].vid, 16);
    assert.equal(svc.state().scan.switch.vlans[0].vid, 16);
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', devices: ['3555-1'], vid: 5000 }), /1-4094/);
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', devices: [], vid: 14 }), /at least one device/);
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', devices: ['3555-1', 'nope'], vid: 14 }), /nope is not on/);
    await assert.rejects(svc.setEth02({ device: '3555-1', ip: '172.16.14' }), /not an IPv4/);
    await assert.rejects(svc.setEth02({ device: 'nope', ip: '172.16.14.10' }), /not on the test network/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('test network: Read reads the RTAC into the database, refreshes the list, then opens it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'testnet-'));
  try {
    const calls = [];
    let refreshed = 0;
    let job = null;
    const svc = new TestNetworkService({
      dataDir: dir,
      jobs: {
        start(label, fn, options) {
          job = { label, meta: options?.meta, done: fn({ log: () => {} }) };
          return { id: 'j1' };
        },
      },
      catalog: { refresh: () => { refreshed += 1; } },
      acrtac: async (script, request, options) => {
        calls.push({ script, request, settleOnExit: options?.settleOnExit ?? false });
        return script === 'acrtac_bridge.py' ? { name: 'Gulfport_DAC_1' } : {};
      },
    });
    await svc.init();
    await svc.saveDevices([
      { id: '3350-1', networkIp: '10.42.44.25', port: '7' },
      { id: 'Pi', kind: 'other', port: '24' },
    ]);
    assert.deepEqual(await svc.read({ device: '3350-1' }), { job: 'j1' });
    assert.deepEqual(job.meta, { type: 'test-read', device: '3350-1' });
    assert.deepEqual(await job.done, { name: 'Gulfport_DAC_1' });
    assert.deepEqual(calls, [
      { script: 'acrtac_bridge.py', request: { command: 'read', host: '10.42.44.25' }, settleOnExit: false },
      { script: 'acrtac_open.py', request: { name: 'Gulfport_DAC_1' }, settleOnExit: true },
    ]);
    assert.equal(refreshed, 1);
    await assert.rejects(svc.read({ device: 'Pi' }), /not an RTAC/);
    await assert.rejects(svc.read({ device: 'nope' }), /not in the bench device table/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
