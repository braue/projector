// VLAN path validation: a GOOSE publication rides one VLAN (SCL states it as
// three hex digits — "014" is VLAN 20), and the drawn fabric must carry that
// VLAN on every hop or the declared link physically cannot work. The mini
// SCL publishes on VLAN 20; the mini switch tags 20 on ports 1-2, carries it
// untagged on port 4, and not at all on port 3.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractScdProfile } from '../lib/comm/extract/scd.js';
import { extractSwProfile } from '../lib/comm/extract/sw.js';
import { linkProfiles } from '../lib/comm/linker.js';
import { ScdService } from '../services/scd.js';
import { SwService } from '../services/sw.js';
import { MINI_SCL } from './helpers/miniScl.js';
import { MINI_SW } from './helpers/miniSw.js';

// One fixture set: RELAY_1 publishes GOOSE on VLAN 20, RTU_1 subscribes,
// SW-STATION-A is the fabric between them.
async function fixture(tmp) {
  const scd = new ScdService({ dataDir: tmp });
  await scd.init();
  await scd.upload('mini.scd', Buffer.from(MINI_SCL));
  const sw = new SwService({ dataDir: tmp });
  await sw.init();
  await sw.upload('station_a.xml', Buffer.from(MINI_SW));

  const relay = extractScdProfile(scd.profile('mini::RELAY_1'), 'mini::RELAY_1');
  const rtu = extractScdProfile(scd.profile('mini::RTU_1'), 'mini::RTU_1');
  const switchProfile = extractSwProfile(sw.profile('station_a::SW-STATION-A'), 'station_a::SW-STATION-A');
  return { relay, rtu, switchProfile };
}

const gooseLink = (result) => result.links.find((link) => link.protocol === 'GOOSE' && link.targetDeviceId);

test('a GOOSE link through ports that carry its VLAN stays confirmed', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-vlan-'));
  try {
    const { relay, rtu, switchProfile } = await fixture(tmp);
    const devices = [
      { id: 'relay', profile: relay },
      { id: 'rtu', profile: rtu },
      { id: 'sw', profile: switchProfile },
    ];

    // Publisher into eth1 (VLAN 20 tagged), subscriber into eth4 (untagged).
    const result = linkProfiles(devices, [
      { id: 'm1', type: 'ethernet', aDeviceId: 'relay', bDeviceId: 'sw', bPort: 'eth1' },
      { id: 'm2', type: 'ethernet', aDeviceId: 'rtu', bDeviceId: 'sw', bPort: 'eth4' },
    ]);
    const goose = gooseLink(result);
    assert.equal(goose.tier, 'confirmed');
    assert.deepEqual(goose.warnings, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a switch port that drops the publication VLAN turns the GOOSE link into a conflict', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-vlan-'));
  try {
    const { relay, rtu, switchProfile } = await fixture(tmp);
    const devices = [
      { id: 'relay', profile: relay },
      { id: 'rtu', profile: rtu },
      { id: 'sw', profile: switchProfile },
    ];

    // Publisher into eth3: only VLAN 30 rides that port.
    const result = linkProfiles(devices, [
      { id: 'm1', type: 'ethernet', aDeviceId: 'relay', bDeviceId: 'sw', bPort: 'eth3' },
      { id: 'm2', type: 'ethernet', aDeviceId: 'rtu', bDeviceId: 'sw', bPort: 'eth4' },
    ]);
    const goose = gooseLink(result);
    assert.equal(goose.tier, 'conflict');
    assert.match(goose.summary, /drawn network path drops its VLAN/);
    const vlanErrors = goose.warnings.filter((warning) => warning.kind === 'error');
    assert.equal(vlanErrors.length, 1);
    assert.match(
      vlanErrors[0].text,
      /GOOSE rides VLAN 20 \(VLAN-ID 014\) but SW-STATION-A port eth3 \(RELAY_1's connection\) does not carry it/,
    );

    // The subscriber's side fails independently too.
    const subscriberSide = linkProfiles(devices, [
      { id: 'm1', type: 'ethernet', aDeviceId: 'rtu', bDeviceId: 'sw', bPort: 'eth3' },
    ]);
    assert.match(gooseLink(subscriberSide).warnings[0].text, /RTU_1's connection/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('no drawn fabric means no VLAN judgment — the declared link stands', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-vlan-'));
  try {
    const { relay, rtu } = await fixture(tmp);
    const result = linkProfiles([
      { id: 'relay', profile: relay },
      { id: 'rtu', profile: rtu },
    ]);
    const goose = gooseLink(result);
    assert.equal(goose.tier, 'confirmed');
    assert.deepEqual(goose.warnings, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('trunk paths are walked across the drawn fabric, multi-hop included', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-vlan-'));
  try {
    const { relay, rtu, switchProfile } = await fixture(tmp);
    const switchB = { ...switchProfile, name: 'SW-B' };
    const switchC = { ...switchProfile, name: 'SW-C' };
    const devices = [
      { id: 'relay', profile: relay },
      { id: 'rtu', profile: rtu },
      { id: 'swA', profile: switchProfile },
      { id: 'swB', profile: switchB },
      { id: 'swC', profile: switchC },
    ];
    // Publisher hangs off SW-A, subscriber off SW-C — two trunk hops apart.
    const accessLinks = [
      { id: 'm1', type: 'ethernet', aDeviceId: 'relay', bDeviceId: 'swA', bPort: 'eth1' },
      { id: 'm2', type: 'ethernet', aDeviceId: 'rtu', bDeviceId: 'swC', bPort: 'eth4' },
    ];

    // A—B—C on eth1/eth2 trunks: VLAN 20 tagged on every hop port — clean.
    const clean = linkProfiles(devices, [
      ...accessLinks,
      { id: 't1', type: 'ethernet', aDeviceId: 'swA', aPort: 'eth2', bDeviceId: 'swB', bPort: 'eth1' },
      { id: 't2', type: 'ethernet', aDeviceId: 'swB', aPort: 'eth2', bDeviceId: 'swC', bPort: 'eth2' },
    ]);
    assert.equal(gooseLink(clean).tier, 'confirmed');
    assert.deepEqual(gooseLink(clean).warnings, []);

    // Middle hop lands on SW-B's eth3 (VLAN 30 only): no path carries 20.
    const broken = linkProfiles(devices, [
      ...accessLinks,
      { id: 't1', type: 'ethernet', aDeviceId: 'swA', aPort: 'eth2', bDeviceId: 'swB', bPort: 'eth3' },
      { id: 't2', type: 'ethernet', aDeviceId: 'swB', aPort: 'eth2', bDeviceId: 'swC', bPort: 'eth2' },
    ]);
    const goose = gooseLink(broken);
    assert.equal(goose.tier, 'conflict');
    assert.equal(goose.warnings.length, 1);
    assert.match(goose.warnings[0].text, /no drawn trunk path between SW-STATION-A and SW-C carries it/);

    // Switches drawn but no trunk between the two islands: not judged.
    const undrawn = linkProfiles(devices, accessLinks);
    assert.equal(gooseLink(undrawn).tier, 'confirmed');
    assert.deepEqual(gooseLink(undrawn).warnings, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
