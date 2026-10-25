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
          return { bench: [{ id: '3555-1', kind: 'rtac', networkIp: '10.0.0.1', port: '3' }],
            switch: { ip: request.switchIp, ports: [3], vlans: [], error: null }, devices: [] };
        }
        active += 1;
        assert.equal(active, 1, 'moves overlap');
        calls.push(request);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { port: request.port, from: 1, to: request.vid, changed: true,
          vlans: [{ vid: request.vid, name: 'x', untagged: [3], tagged: [] }] };
      },
    });
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', device: '3555-1', vid: 14 }), /not on the test network/);
    await svc.scan('10.42.44.12');
    const [a, b] = await Promise.all([
      svc.move({ switchIp: '10.42.44.12', device: '3555-1', vid: 14 }),
      svc.move({ switchIp: '10.42.44.12', device: '3555-1', vid: 16 }),
    ]);
    assert.deepEqual(calls.map((c) => [c.port, c.vid]), [[3, 14], [3, 16]]);
    assert.equal(a.to, 14);
    assert.equal(b.scan.switch.vlans[0].vid, 16);
    assert.equal(svc.state().scan.switch.vlans[0].vid, 16);
    await assert.rejects(svc.move({ switchIp: '10.42.44.12', device: '3555-1', vid: 5000 }), /1-4094/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
