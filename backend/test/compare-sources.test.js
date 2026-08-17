// Generic compare across source types: RDB relay profiles and SCD IEDs run
// through the same CompareService the RTAC path uses (whose adapter is a thin
// wrapper over the parse cache, exercised by the sample-based tests).

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompareService } from '../services/compare.js';
import { RdbService } from '../services/rdb.js';
import { ScdService } from '../services/scd.js';
import { makeRdb } from './helpers/makeRdb.js';
import { MINI_SCL } from './helpers/miniScl.js';

async function fixture(tmp) {
  const rdb = new RdbService({ dataDir: tmp });
  await rdb.init();
  await rdb.upload('pair.rdb', makeRdb([
    {
      name: 'OLD_UNIT',
      relayType: 'SEL-451',
      sections: [
        { key: 'P5', desc: 'Port 5', settings: { IPADDR: '10.0.0.5', SUBNETM: '255.255.255.0' } },
        { key: 'G', desc: 'Global', settings: { TID: 'UNIT' } },
      ],
    },
    {
      name: 'NEW_UNIT',
      relayType: 'SEL-451',
      sections: [
        { key: 'P5', desc: 'Port 5', settings: { IPADDR: '10.0.0.9', SUBNETM: '255.255.255.0' } },
        { key: 'M1', desc: 'Modbus', settings: { MODADR: '3' } },
      ],
    },
  ]));

  const scd = new ScdService({ dataDir: tmp });
  await scd.init();
  await scd.upload('mini.scd', Buffer.from(MINI_SCL));

  return new CompareService({
    adapters: {
      rdb: (ref) => rdb.comparable(ref),
      scd: (ref) => scd.comparable(ref),
    },
  });
}

test('rdb profile vs rdb profile: section union with statuses, settings diff', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const compare = await fixture(tmp);
    const a = { type: 'rdb', ref: 'pair::OLD_UNIT' };
    const b = { type: 'rdb', ref: 'pair::NEW_UNIT' };

    const result = await compare.compare(a, b);
    assert.deepEqual(result.summary, { added: 1, removed: 1, edited: 1, unchanged: 0 });
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('P5'), 'edited');
    assert.equal(byPath.get('M1'), 'added');
    assert.equal(byPath.get('G'), 'removed');

    const item = await compare.compareItem(a, b, 'P5');
    assert.equal(item.status, 'edited');
    const ip = item.diff.settings.find((row) => row.key === 'IPADDR');
    assert.deepEqual({ original: ip.original, updated: ip.updated }, { original: '10.0.0.5', updated: '10.0.0.9' });

    const removed = await compare.compareItem(a, b, 'G');
    assert.equal(removed.status, 'removed');
    assert.equal(removed.updated, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('reordered settings are not an edit: signatures are key-sorted', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const rdb = new RdbService({ dataDir: tmp });
    await rdb.init();
    // Same section, same settings, opposite key order in the file.
    await rdb.upload('order.rdb', makeRdb([
      { name: 'A_UNIT', relayType: 'SEL-451', sections: [{ key: 'G', desc: 'Global', settings: { TID: 'X', SID: 'Y' } }] },
      { name: 'B_UNIT', relayType: 'SEL-451', sections: [{ key: 'G', desc: 'Global', settings: { SID: 'Y', TID: 'X' } }] },
    ]));
    const compare = new CompareService({ adapters: { rdb: (ref) => rdb.comparable(ref) } });

    const result = await compare.compare(
      { type: 'rdb', ref: 'order::A_UNIT' },
      { type: 'rdb', ref: 'order::B_UNIT' },
    );
    assert.deepEqual(result.summary, { added: 0, removed: 0, edited: 0, unchanged: 1 });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('upload signatures cover page rows: a Report-ID-only edit reads edited', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const scd = new ScdService({ dataDir: tmp });
    await scd.init();
    // rptID lives only in the Reports page rows — the settings summary
    // deliberately abbreviates it away.
    await scd.upload('a.scd', Buffer.from(MINI_SCL));
    await scd.upload('b.scd', Buffer.from(MINI_SCL.replace('rptID="BRep01"', 'rptID="BRep01_v2"')));
    const compare = new CompareService({ adapters: { scd: (ref) => scd.comparable(ref) } });

    const result = await compare.compare(
      { type: 'scd', ref: 'a::RELAY_1' },
      { type: 'scd', ref: 'b::RELAY_1' },
    );
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('reports'), 'edited');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a receive-map edit diffs as the point table, not summary settings', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const scd = new ScdService({ dataDir: tmp });
    await scd.init();
    // Rebinding an ExtRef to another control block moves it between summary
    // groups — without the derived flag that read as a removed + added pair
    // of "N points bound" settings on top of the real row change.
    await scd.upload('a.scd', Buffer.from(MINI_SCL));
    await scd.upload('b.scd', Buffer.from(MINI_SCL.replace('srcCBName="GPub01"', 'srcCBName="GPub02"')));
    const compare = new CompareService({ adapters: { scd: (ref) => scd.comparable(ref) } });

    const a = { type: 'scd', ref: 'a::RTU_1' };
    const b = { type: 'scd', ref: 'b::RTU_1' };
    const result = await compare.compare(a, b);
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('subscriptions'), 'edited'); // still flags

    const item = await compare.compareItem(a, b, 'subscriptions');
    assert.equal(item.diff.settings.length, 0);
    const [page] = item.diff.pages;
    assert.equal(page.status, 'changed');
    const changed = page.changes.find((row) => row.kind === 'changed');
    assert.match(changed.updated.Source, /GPub02/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('whole scd vs whole scd: a folder per IED, status rolled up onto it', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const scd = new ScdService({ dataDir: tmp });
    await scd.init();
    // b.scd edits one section inside RELAY_1 and renames the other IED, so
    // the three folders cover every rollup: mixed, wholly removed, wholly
    // added.
    await scd.upload('a.scd', Buffer.from(MINI_SCL));
    await scd.upload('b.scd', Buffer.from(MINI_SCL
      .replace('rptID="BRep01"', 'rptID="BRep01_v2"')
      .replace('<IED name="RTU_1"', '<IED name="RTU_2"')));
    const compare = new CompareService({ adapters: { scd: (ref) => scd.comparable(ref) } });

    const a = { type: 'scd', ref: 'a' };
    const b = { type: 'scd', ref: 'b' };
    const result = await compare.compare(a, b);

    // The pane header names the FILES, not a profile inside one.
    assert.equal(result.original.name, 'a.scd');
    assert.equal(result.updated.name, 'b.scd');

    const folders = new Map(result.tree.map((node) => [node.name, node]));
    assert.deepEqual([...folders.keys()].sort(), ['RELAY_1', 'RTU_1', 'RTU_2']);
    assert.ok(result.tree.every((node) => node.type === 'folder'));
    assert.equal(folders.get('RELAY_1').status, 'edited'); // one section moved
    assert.equal(folders.get('RTU_1').status, 'removed');
    assert.equal(folders.get('RTU_2').status, 'added');

    // Items live under their IED and keep the same status they'd have alone.
    const relay = new Map(folders.get('RELAY_1').children.map((node) => [node.path, node.status]));
    assert.equal(relay.get('RELAY_1/reports'), 'edited');
    assert.equal(relay.get('RELAY_1/network'), 'unchanged');

    const item = await compare.compareItem(a, b, 'RELAY_1/reports');
    assert.equal(item.status, 'edited');
    const changed = item.diff.pages[0].changes.find((row) => row.kind === 'changed');
    assert.equal(changed.updated['Report ID'], 'BRep01_v2');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('scd ied vs scd ied compares inspect items; mixed types are rejected', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const compare = await fixture(tmp);
    const relay = { type: 'scd', ref: 'mini::RELAY_1' };
    const rtu = { type: 'scd', ref: 'mini::RTU_1' };

    const result = await compare.compare(relay, rtu);
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('network'), 'edited'); // RELAY_1 has addresses, RTU_1 none
    assert.equal(byPath.get('subscriptions'), 'added'); // only RTU_1 receives
    assert.equal(byPath.get('tx'), 'removed'); // only RELAY_1 publishes
    assert.equal(byPath.get('reports'), 'removed');
    assert.equal(byPath.get('ds:S1:CFG:GPDSet01'), 'removed');
    assert.equal(byPath.get('structure'), 'edited'); // different logical devices

    await assert.rejects(
      () => compare.compare(relay, { type: 'rdb', ref: 'pair::OLD_UNIT' }),
      /same type/,
    );
    await assert.rejects(
      () => compare.compare({ type: 'nope', ref: 'x' }, { type: 'nope', ref: 'y' }),
      /unsupported compare type/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
