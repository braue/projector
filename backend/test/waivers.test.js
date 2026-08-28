// Conflict waivers: acknowledging a red wire records a judgment about the
// SPECIFIC disagreeing values. The waiver must hold across re-reads, vanish
// the moment the disagreement changes shape, and never apply to anything
// that is not a conflict.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CanvasService } from '../services/canvas.js';

// An RTAC-ish client dialing 10.0.0.40:20000 DNP…
const CLIENT_PROFILE = {
  name: 'RTAC_MAIN',
  source: { type: 'rtac', ref: 'RTAC_MAIN' },
  interfaces: [{ kind: 'ethernet', name: 'ETH1', ip: '10.0.0.10', mask: '255.255.255.0' }],
  endpoints: [{
    id: 'client1',
    role: 'client',
    protocol: 'DNP3',
    transport: 'tcp',
    remoteAddress: '10.0.0.40',
    remotePort: 20000,
  }],
};

// …and a relay that owns the address but listens on a DIFFERENT port.
const relayListeningOn = (port) => ({
  name: 'FEEDER_1',
  source: { type: 'rdb', ref: 'demo::FEEDER_1' },
  interfaces: [{ kind: 'ethernet', name: 'Port 1', ip: '10.0.0.40', mask: '255.255.255.0' }],
  endpoints: [{
    id: 'server1',
    role: 'server',
    protocol: 'DNP3',
    transport: 'tcp',
    localPort: port,
  }],
});

async function canvasWith(tmp, relayPort) {
  // The relay's port is mutable through this handle, standing in for a
  // re-uploaded RDB with a changed setting.
  const state = { relayPort };
  const service = new CanvasService({
    file: path.join(tmp, 'canvas.json'),
    resolvers: {
      rtac: async () => CLIENT_PROFILE,
      rdb: async () => relayListeningOn(state.relayPort),
    },
  });
  await service.init();
  await service.addDevice({ source: CLIENT_PROFILE.source });
  await service.addDevice({ source: { type: 'rdb', ref: 'demo::FEEDER_1' } });
  return { service, state };
}

const conflictLink = (graph) => graph.links.find((link) => link.tier === 'conflict');

test('acknowledging a conflict waives it until the disagreement changes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-waiver-'));
  try {
    const { service, state } = await canvasWith(tmp, 20001);

    let graph = await service.graph();
    const link = conflictLink(graph);
    assert.ok(link, 'port mismatch should be a conflict');
    assert.equal(graph.summary.conflicts, 1);
    assert.equal(graph.summary.waived, 0);

    const waiver = await service.addWaiver({ linkId: link.id, reason: 'port 20001 is the site standard' });
    assert.ok(waiver.id);

    // Waived: still a conflict tier (the settings still disagree), but marked
    // and out of the to-do count.
    graph = await service.graph();
    assert.equal(conflictLink(graph).waived.reason, 'port 20001 is the site standard');
    assert.equal(graph.summary.conflicts, 0);
    assert.equal(graph.summary.waived, 1);

    // The relay's port changes: the values the waiver judged are gone, so the
    // conflict surfaces again.
    state.relayPort = 20002;
    graph = await service.graph();
    assert.equal(conflictLink(graph).waived, undefined);
    assert.equal(graph.summary.conflicts, 1);
    assert.equal(graph.summary.waived, 0);

    // The old values return: the stored waiver covers them again.
    state.relayPort = 20001;
    graph = await service.graph();
    assert.equal(conflictLink(graph).waived.id, waiver.id);
    assert.equal(graph.summary.conflicts, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('removing a waiver reopens the conflict', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-waiver-'));
  try {
    const { service } = await canvasWith(tmp, 20001);
    const link = conflictLink(await service.graph());
    const waiver = await service.addWaiver({ linkId: link.id, reason: 'known, accepted' });

    await service.removeWaiver(waiver.id);
    const graph = await service.graph();
    assert.equal(conflictLink(graph).waived, undefined);
    assert.equal(graph.summary.conflicts, 1);

    await assert.rejects(service.removeWaiver(waiver.id), /unknown waiver/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('only conflicts can be acknowledged, and a reason is required', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-waiver-'));
  try {
    const { service, state } = await canvasWith(tmp, 20001);
    const graph = await service.graph();
    const link = conflictLink(graph);

    await assert.rejects(service.addWaiver({ linkId: link.id, reason: '   ' }), /reason is required/);
    await assert.rejects(service.addWaiver({ linkId: 'nope', reason: 'x' }), /unknown link/);

    // Fix the port so the link is no longer a conflict: no waiver to give.
    state.relayPort = 20000;
    const fixed = (await service.graph()).links.find((candidate) => candidate.id === link.id);
    assert.notEqual(fixed.tier, 'conflict');
    await assert.rejects(service.addWaiver({ linkId: link.id, reason: 'x' }), /only a conflict/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('re-acknowledging replaces the stale waiver for that link', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-waiver-'));
  try {
    const { service, state } = await canvasWith(tmp, 20001);
    const link = conflictLink(await service.graph());
    await service.addWaiver({ linkId: link.id, reason: 'first look' });

    state.relayPort = 20002; // waiver goes stale
    const second = await service.addWaiver({ linkId: link.id, reason: 'checked again — still fine' });

    const graph = await service.graph();
    assert.equal(conflictLink(graph).waived.id, second.id);
    assert.equal(conflictLink(graph).waived.reason, 'checked again — still fine');

    // One waiver per link: going back to the FIRST port no longer waives,
    // because the first waiver was replaced.
    state.relayPort = 20001;
    assert.equal(conflictLink(await service.graph()).waived, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
