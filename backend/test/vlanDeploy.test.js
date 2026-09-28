// RTAC VLAN Deploy: the service's fill-in checks, device resolution, and the
// bench device table. What the values mean (addresses, masks, duplicates) is
// the bridge's validate(), covered with the rest of the Python half by
// test/sel_web_test.py.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VlanDeployService, validateDeploy, validateDevices } from '../services/tools/vlanDeploy.js';

const bench = [
  { id: '3555-1', networkIp: '10.42.44.34', port: '3' },
  { id: '3532-3', networkIp: '10.42.44.35', port: '4' },
];
const row = (over = {}) => ({ device: '3555-1', vlanIp: '172.16.100.200', project: 'Station A', ...over });
const form = (over = {}) => ({ switchIp: '10.42.44.12', vlan: 14, piPort: 24, rtacs: [row()], ...over });

test('vlan deploy: devices resolve from the table, fields trimmed to strings', () => {
  assert.deepEqual(validateDeploy(form({ rtacs: [row({ vlanIp: ' 172.16.100.200 ' })] }), bench), {
    switchIp: '10.42.44.12',
    vlan: '14',
    piPort: '24',
    parallel: true,
    rtacs: [{ label: '3555-1', networkIp: '10.42.44.34', port: '3', vlanIp: '172.16.100.200', project: 'Station A' }],
  });
});

test('vlan deploy: missing fields and unknown devices are 400s that name them', () => {
  const bad = [
    [form({ switchIp: ' ' }), /Switch IP is required/],
    [form({ vlan: undefined }), /VLAN ID is required/],
    [form({ piPort: '' }), /Raspberry Pi port is required/],
    [form({ rtacs: [] }), /at least one RTAC/],
    [form({ rtacs: [row(), row({ device: '3532-3', vlanIp: '' })] }), /3532-3 VLAN IP is required/],
    [form({ rtacs: [row({ project: ' ' })] }), /3555-1 project is required/],
    [form({ rtacs: [row({ device: '' })] }), /RTAC 1 device is required/],
    [form({ rtacs: [row({ device: '9999-9' })] }), /9999-9 is not in the bench device table/],
  ];
  for (const [payload, message] of bad) {
    assert.throws(() => validateDeploy(payload, bench), (err) => err.status === 400 && message.test(err.message),
      JSON.stringify(payload));
  }
});

test('vlan deploy: the device table refuses bad and repeated rows', () => {
  assert.deepEqual(validateDevices([{ id: ' 3555-1 ', networkIp: '10.42.44.34', port: '03' }]),
    [{ id: '3555-1', networkIp: '10.42.44.34', port: '3' }]);
  const bad = [
    [[{ id: '', networkIp: '10.0.0.1', port: '1' }], /row 1 identifier/],
    [[{ id: 'a', networkIp: '10.0.0', port: '1' }], /a network IP/],
    [[{ id: 'a', networkIp: '10.0.0.1', port: '0' }], /a switch port/],
    [[...bench, { ...bench[0], networkIp: '10.0.0.9', port: '9' }], /identifier 3555-1/],
    [[...bench, { id: 'x', networkIp: '10.0.0.9', port: '4' }], /switch port 4/],
  ];
  for (const [rows, message] of bad) {
    assert.throws(() => validateDevices(rows), (err) => err.status === 400 && message.test(err.message));
  }
});

test('vlan deploy: the device table persists in the data dir', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vlandeploy-'));
  try {
    const service = new VlanDeployService({ jobs: null, dataDir });
    assert.deepEqual(await service.devices(), []);
    await service.saveDevices(bench);
    assert.deepEqual(await new VlanDeployService({ jobs: null, dataDir }).devices(), bench);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
