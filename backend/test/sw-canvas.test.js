// SW on the canvas: service round-trip, switch -> DeviceProfile extraction,
// and manual ethernet connections — the linker's port validation plus the
// full workspace draw/remove flow.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractSwProfile } from '../lib/comm/extract/sw.js';
import { linkProfiles } from '../lib/comm/linker.js';
import { SwService } from '../services/sw.js';
import { WorkspaceService } from '../services/workspaces.js';
import { MINI_SW } from './helpers/miniSw.js';

async function serviceWithMini(tmp) {
  const service = new SwService({ dataDir: tmp });
  await service.init();
  await service.upload('station_a.xml', Buffer.from(MINI_SW));
  return service;
}

// A minimal end device for the far side of a drawn connection.
const RELAY_PROFILE = {
  name: 'FEEDER_1',
  manufacturer: 'SEL',
  model: 'SEL-751',
  source: { type: 'rdb', ref: 'demo::FEEDER_1' },
  interfaces: [{ kind: 'ethernet', name: 'Port 1', ip: '10.0.0.40', mask: '255.255.255.0' }],
  endpoints: [],
};

test('sw service: upload, list, inspect shapes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-sw-'));
  try {
    const service = await serviceWithMini(tmp);

    const [file] = service.list();
    assert.equal(file.id, 'station_a');
    assert.deepEqual(file.profiles, [{
      name: 'SW-STATION-A',
      ref: 'station_a::SW-STATION-A',
      deviceType: 'SEL-2730M',
    }]);

    const tree = service.tree('station_a::SW-STATION-A');
    assert.equal(tree.deviceLabel, 'SEL-2730M');
    assert.deepEqual(tree.tree.map((item) => item.path), ['overview', 'network', 'ports', 'vlans']);

    const overview = service.item('station_a::SW-STATION-A', 'overview');
    assert.equal(overview.settings.Hostname, 'SW-STATION-A');
    assert.equal(overview.settings.Ports, '3 of 4 enabled');

    // Ports carry their VLAN membership, computed from the VLAN table.
    const ports = service.item('station_a::SW-STATION-A', 'ports');
    assert.equal(ports.pages[0].rows[0].Port, 'eth1');
    assert.equal(ports.pages[0].rows[0].VLANs, '20 (tagged), 30 (tagged)');
    assert.equal(ports.pages[0].rows[3].VLANs, '20 (untagged)');
    assert.match(ports.settings.eth3, /disabled/);

    const vlans = service.item('station_a::SW-STATION-A', 'vlans');
    assert.equal(vlans.pointCount, 3);
    assert.equal(vlans.pages[0].rows[1].VID, '20');
    assert.equal(vlans.pages[0].rows[1]['Tagged ports'], '1, 2');

    assert.throws(() => service.profile('station_a::NOPE'), /unknown sw profile/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('sw extractor: switch kind, management interfaces + endpoints, port inventory', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-sw-'));
  try {
    const service = await serviceWithMini(tmp);
    const profile = extractSwProfile(service.profile('station_a::SW-STATION-A'), 'station_a::SW-STATION-A');

    assert.equal(profile.name, 'SW-STATION-A');
    assert.equal(profile.model, 'SEL-2730M');
    assert.equal(profile.kind, 'switch');
    assert.deepEqual(profile.interfaces, [
      { kind: 'ethernet', name: 'Mgmt', ip: '10.0.0.30', mask: '255.255.255.0', gateway: '10.0.0.1' },
    ]);

    // Management services become server endpoints so IP dialing can link.
    assert.equal(profile.endpoints.length, 1);
    assert.equal(profile.endpoints[0].protocol, 'HTTPS');
    assert.equal(profile.endpoints[0].localPort, 443);

    // The port inventory the connect dialog and linker read. A port with no
    // untagged assignment stays on the default VLAN untagged (PVID 1).
    assert.equal(profile.ports.length, 4);
    assert.deepEqual(profile.ports[0], {
      id: 'eth1', name: 'To RTAC', enabled: true, speed: '1G full',
      taggedVlans: [20, 30], untaggedVlans: [1],
    });
    assert.deepEqual(profile.ports[3].untaggedVlans, [20]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('linker: drawn ethernet connections validate against the port inventory', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-sw-'));
  try {
    const service = await serviceWithMini(tmp);
    const switchProfile = extractSwProfile(service.profile('station_a::SW-STATION-A'), 'station_a::SW-STATION-A');
    const devices = [
      { id: 'sw', profile: switchProfile },
      { id: 'relay', profile: RELAY_PROFILE },
    ];

    // A clean run into an enabled port: manual tier, port detail on the line.
    const clean = linkProfiles(devices, [
      { id: 'm1', type: 'ethernet', aDeviceId: 'relay', aPort: 'Port 1', bDeviceId: 'sw', bPort: 'eth1' },
    ]);
    const drawn = clean.links.find((link) => link.manualId === 'm1');
    assert.equal(drawn.tier, 'manual');
    assert.equal(drawn.transport, 'ethernet');
    assert.equal(drawn.b.label, 'SW-STATION-A · eth1');
    assert.ok(drawn.b.lines.some((line) => line.includes('To RTAC')));
    assert.ok(drawn.b.lines.some((line) => line.includes('tagged 20, 30')));
    // The relay states no port inventory — its label is taken verbatim.
    assert.equal(drawn.a.label, 'FEEDER_1 · Port 1');
    assert.deepEqual(drawn.warnings, []);

    // Plugging into a port the switch has disabled is a conflict.
    const disabled = linkProfiles(devices, [
      { id: 'm2', type: 'ethernet', aDeviceId: 'relay', bDeviceId: 'sw', bPort: 'eth3' },
    ]);
    const bad = disabled.links.find((link) => link.manualId === 'm2');
    assert.equal(bad.tier, 'conflict');
    assert.match(bad.warnings[0].text, /eth3 is disabled/);

    // A port the switch's settings never mention is flagged, not fatal.
    const unknown = linkProfiles(devices, [
      { id: 'm3', type: 'ethernet', aDeviceId: 'relay', bDeviceId: 'sw', bPort: 'eth99' },
    ]);
    const odd = unknown.links.find((link) => link.manualId === 'm3');
    assert.equal(odd.tier, 'manual');
    assert.match(odd.warnings[0].text, /states no port named eth99/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('workspace flow: draw a connection, see it in the graph, remove it', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-sw-'));
  try {
    const sw = await serviceWithMini(tmp);
    const workspaces = new WorkspaceService({
      dataDir: tmp,
      resolvers: {
        sw: async (ref) => extractSwProfile(sw.profile(ref), ref),
        rdb: async () => RELAY_PROFILE,
      },
    });
    await workspaces.init();

    const swDevice = await workspaces.addDevice('Default', {
      source: { type: 'sw', ref: 'station_a::SW-STATION-A' },
    });
    const relayDevice = await workspaces.addDevice('Default', {
      source: { type: 'rdb', ref: 'demo::FEEDER_1' },
    });

    const manual = await workspaces.addManualLink('Default', {
      type: 'ethernet',
      aDeviceId: relayDevice.id,
      bDeviceId: swDevice.id,
      bPort: 'eth1',
    });

    const graph = await workspaces.graph('Default');
    // The switch node carries its kind and port inventory for the canvas.
    const swNode = graph.devices.find((device) => device.id === swDevice.id);
    assert.equal(swNode.kind, 'switch');
    assert.equal(swNode.ports.length, 4);
    assert.equal(swNode.ports[0].id, 'eth1');

    const drawn = graph.links.find((link) => link.manualId === manual.id);
    assert.equal(drawn.tier, 'manual');
    assert.equal(drawn.sourceDeviceId, relayDevice.id);
    assert.equal(drawn.targetDeviceId, swDevice.id);
    assert.equal(graph.summary.manual, 1);

    // Self-connections and unknown devices are rejected.
    await assert.rejects(
      () => workspaces.addManualLink('Default', { aDeviceId: swDevice.id, bDeviceId: swDevice.id }),
      /cannot connect to itself/,
    );
    await assert.rejects(
      () => workspaces.addManualLink('Default', { aDeviceId: swDevice.id, bDeviceId: 'nope' }),
      /unknown device/,
    );

    await workspaces.removeManualLink('Default', manual.id);
    const after = await workspaces.graph('Default');
    assert.equal(after.links.length, 0);
    await assert.rejects(
      () => workspaces.removeManualLink('Default', manual.id),
      /unknown manual link/,
    );

    // Removing a device cascades its drawn connections.
    const again = await workspaces.addManualLink('Default', {
      type: 'ethernet', aDeviceId: relayDevice.id, bDeviceId: swDevice.id, bPort: 'eth2',
    });
    await workspaces.removeDevice('Default', relayDevice.id);
    const cascaded = await workspaces.graph('Default');
    assert.ok(!cascaded.links.some((link) => link.manualId === again.id));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
