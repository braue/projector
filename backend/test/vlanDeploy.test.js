// RTAC VLAN Deploy: the service's fill-in checks. What the values mean
// (addresses, masks, duplicates) is the bridge's validate(), covered with the
// rest of the Python half by test/sel_web_test.py.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDeploy } from '../services/tools/vlanDeploy.js';

const row = (over = {}) => ({
  networkIp: '10.42.44.34', vlanIp: '172.16.100.200/24', port: 3, project: 'Station A', ...over,
});
const form = (over = {}) => ({ switchIp: '10.42.44.12', vlan: 14, rtacs: [row()], ...over });

test('vlan deploy: a filled form passes through as trimmed strings', () => {
  assert.deepEqual(validateDeploy(form({ rtacs: [row({ networkIp: ' 10.42.44.34 ' })] })), {
    switchIp: '10.42.44.12',
    vlan: '14',
    rtacs: [{ networkIp: '10.42.44.34', vlanIp: '172.16.100.200/24', port: '3', project: 'Station A' }],
  });
});

test('vlan deploy: missing fields are 400s that name the field', () => {
  const bad = [
    [form({ switchIp: ' ' }), /Switch IP is required/],
    [form({ vlan: undefined }), /VLAN ID is required/],
    [form({ rtacs: [] }), /at least one RTAC/],
    [form({ rtacs: [row(), row({ vlanIp: '' })] }), /RTAC 2 VLAN IP is required/],
    [form({ rtacs: [row({ project: ' ' })] }), /RTAC 1 project is required/],
  ];
  for (const [payload, message] of bad) {
    assert.throws(() => validateDeploy(payload), (err) => err.status === 400 && message.test(err.message),
      JSON.stringify(payload));
  }
});
