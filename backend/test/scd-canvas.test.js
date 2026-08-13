// SCD on the canvas: service round-trip, IED -> DeviceProfile extraction,
// augmentation of a device placed from another artifact, and the linker's
// declared-GOOSE pass — including the full workspace attach flow.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { attachmentWarning, augmentProfile, extractScdProfile } from '../lib/comm/extract/scd.js';
import { linkProfiles } from '../lib/comm/linker.js';
import { ScdService } from '../services/scd.js';
import { CanvasService } from '../services/canvas.js';
import { MINI_SCL } from './helpers/miniScl.js';

async function serviceWithMini(tmp) {
  const service = new ScdService({ dataDir: tmp });
  await service.init();
  await service.upload('mini.scd', Buffer.from(MINI_SCL));
  return service;
}

test('scd service: upload, list, inspect shapes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-scd-'));
  try {
    const service = await serviceWithMini(tmp);

    const [file] = service.list();
    assert.equal(file.id, 'mini');
    assert.deepEqual(file.profiles.map((p) => p.ref), ['mini::RELAY_1', 'mini::RTU_1']);
    assert.equal(file.profiles[0].deviceType, 'TEST');

    const tree = service.tree('mini::RELAY_1');
    assert.equal(tree.deviceLabel, 'TEST');
    assert.deepEqual(
      tree.tree.map((item) => item.path),
      ['network', 'tx', 'reports', 'ds:S1:CFG:GPDSet01', 'structure'],
    );

    const network = service.item('mini::RELAY_1', 'network');
    assert.equal(network.settings['S1 · IP'], '10.0.0.5');
    assert.equal(network.pages[0].rows[0].IP, '10.0.0.5');

    // The GOOSE wire address rides the transmit table, merged from the
    // Communication section onto its control block.
    const tx = service.item('mini::RELAY_1', 'tx');
    assert.match(tx.settings['GOOSE GPub01'], /MAC 01-0C-CD-01-00-01/);
    assert.equal(tx.pages[0].rows[0].MAC, '01-0C-CD-01-00-01');
    assert.equal(tx.pages[0].rows[0]['Min time (ms)'], '4');

    // Datasets resolve member-by-member to device sources.
    const ds = service.item('mini::RELAY_1', 'ds:S1:CFG:GPDSet01');
    assert.equal(ds.pointCount, 3);
    assert.equal(ds.pages[0].rows[0]['61850 path'], 'CFG.GGIO1.Ind001.stVal');
    assert.equal(ds.pages[0].rows[0].Source, 'IN101');

    const subs = service.item('mini::RTU_1', 'subscriptions');
    assert.match(subs.settings['RELAY_1 · CFG/GPub01'], /GOOSE · 1 point/);
    assert.deepEqual(subs.pages[0].rows[0], {
      'Internal address': 'SPS001.stVal',
      Source: 'RELAY_1/CFG/LLN0/GPub01.CFG.GGIO1.Ind001.stVal',
      Service: 'GOOSE',
    });

    assert.throws(() => service.profile('mini::NOPE'), /unknown scd profile/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('scd extractor: interfaces, GOOSE publications, subscription fragment', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-scd-'));
  try {
    const service = await serviceWithMini(tmp);

    const relay = extractScdProfile(service.profile('mini::RELAY_1'), 'mini::RELAY_1');
    assert.equal(relay.name, 'RELAY_1');
    assert.deepEqual(relay.interfaces, [
      { kind: 'ethernet', name: 'S1', ip: '10.0.0.5', mask: '255.255.255.0', gateway: null },
    ]);
    assert.equal(relay.endpoints.length, 1);
    assert.equal(relay.endpoints[0].protocol, 'GOOSE');
    // VLAN-ID decodes from SCL's three-hex-digit form: "014" is VLAN 20.
    assert.deepEqual(relay.endpoints[0].goose, {
      mac: '01-0C-CD-01-00-01', appId: '1001', vlanId: '014', vlan: 20,
    });
    assert.deepEqual(relay.identity, { namespace: 'scd:mini', name: 'RELAY_1' });

    const rtu = extractScdProfile(service.profile('mini::RTU_1'), 'mini::RTU_1');
    assert.deepEqual(rtu.subscriptions, [
      {
        publisher: 'RELAY_1',
        serviceType: 'GOOSE',
        control: 'CFG/GPub01',
        publisherEndpointId: 'goose:CFG/GPub01',
        points: 1,
      },
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('linker: same-SCD subscription confirms; missing publisher ghosts', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-scd-'));
  try {
    const service = await serviceWithMini(tmp);
    const relay = extractScdProfile(service.profile('mini::RELAY_1'), 'mini::RELAY_1');
    const rtu = extractScdProfile(service.profile('mini::RTU_1'), 'mini::RTU_1');

    const both = linkProfiles([
      { id: 'rtu', profile: rtu },
      { id: 'relay', profile: relay },
    ]);
    const goose = both.links.find((link) => link.protocol === 'GOOSE');
    assert.equal(goose.tier, 'confirmed');
    assert.equal(goose.sourceDeviceId, 'rtu');
    assert.equal(goose.targetDeviceId, 'relay');
    assert.match(goose.b.lines.join(' | '), /Multicast 01-0C-CD-01-00-01/);

    const alone = linkProfiles([{ id: 'rtu', profile: rtu }]);
    const ghosted = alone.links.find((link) => link.protocol === 'GOOSE');
    assert.equal(ghosted.tier, 'declared');
    assert.ok(ghosted.targetGhostId);
    assert.equal(alone.ghosts[0].label, 'RELAY_1');

    // The same IED carried twice (standalone + attached elsewhere): matched
    // against the first, surfaced instead of silently picked.
    const doubled = linkProfiles([
      { id: 'rtu', profile: rtu },
      { id: 'relay', profile: relay },
      { id: 'relay-again', profile: relay },
    ]);
    const ambiguous = doubled.links.find((link) => link.protocol === 'GOOSE');
    assert.equal(ambiguous.targetDeviceId, 'relay');
    assert.match(ambiguous.warnings[0].text, /RELAY_1 is carried by 2 canvas devices/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('attachmentWarning: fires only on comparable, disagreeing models', () => {
  const base = (model) => ({ model });
  const scd = (model) => ({ model });

  // Same family, different suffix precision — fine.
  assert.equal(attachmentWarning(base('SEL-751A'), scd('SEL_751')), null);
  // Genuinely different devices — warn.
  assert.match(attachmentWarning(base('SEL-735'), scd('SEL_487B')), /may not match/);
  assert.match(attachmentWarning(base('SEL-3555'), scd('SEL_RTAC_5032')), /may not match/);
  // Either side without a digit-bearing model states nothing comparable.
  assert.equal(attachmentWarning(base('RTAC'), scd('SEL_487B')), null);
  assert.equal(attachmentWarning(base(null), scd('SEL_487B')), null);
  assert.equal(attachmentWarning(base('SEL-735'), scd('IED')), null);
});

test('canvas attach flow: augmented device links to a standalone scd node', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-scd-'));
  try {
    const scd = await serviceWithMini(tmp);

    // The "RTU" was placed from another artifact (an RTAC export, say) that
    // states a serial-free, interface-free profile of its own.
    const baseProfile = {
      name: 'STATION_RTU',
      manufacturer: 'SEL',
      model: 'SEL-3555',
      source: { type: 'rtac', ref: 'STATION_RTU' },
      interfaces: [],
      endpoints: [],
    };
    const canvas = new CanvasService({
      file: path.join(tmp, 'canvas.json'),
      resolvers: {
        rtac: async () => baseProfile,
        scd: async (ref) => extractScdProfile(scd.profile(ref), ref),
      },
      // Same composition the project registry does.
      augment: async (profile, ref) => {
        const scdProfile = extractScdProfile(scd.profile(ref), ref);
        return {
          profile: augmentProfile(profile, scdProfile),
          warning: attachmentWarning(profile, scdProfile),
        };
      },
    });
    await canvas.init();

    const rtuDevice = await canvas.addDevice({
      source: { type: 'rtac', ref: 'STATION_RTU' },
    });
    await canvas.addDevice({ source: { type: 'scd', ref: 'mini::RELAY_1' } });
    await canvas.attachScd(rtuDevice.id, 'mini::RTU_1');

    const graph = await canvas.graph();
    const rtuNode = graph.devices.find((device) => device.id === rtuDevice.id);
    assert.deepEqual(rtuNode.scd, { ref: 'mini::RTU_1' });
    assert.equal(rtuNode.name, 'STATION_RTU'); // base identity survives augmentation

    const goose = graph.links.find((link) => link.protocol === 'GOOSE');
    assert.equal(goose.tier, 'confirmed');
    assert.equal(goose.sourceDeviceId, rtuDevice.id);
    assert.equal(graph.summary.confirmed, 1);

    // Detach: the link degrades to a ghost-less canvas (no scd fragment left).
    await canvas.detachScd(rtuDevice.id);
    const after = await canvas.graph();
    assert.ok(!after.links.some((link) => link.protocol === 'GOOSE'));
    assert.equal(after.devices.find((device) => device.id === rtuDevice.id).scd, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
