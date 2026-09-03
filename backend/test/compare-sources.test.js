// Generic compare across artifact kinds: RDB relay profiles and SCD IEDs run
// through the same CompareService the RTAC path uses, loading over the
// artifacts cache. Refs are tree paths ("pair.rdb::OLD_UNIT").

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CompareService } from '../services/compare.js';
import { asUpload, makeBundle } from './helpers/bundle.js';
import { makeRdb } from './helpers/makeRdb.js';
import { MINI_SCL } from './helpers/miniScl.js';

async function fixture(tmp) {
  const { files, load } = await makeBundle(tmp);
  await files.upload('', [asUpload('pair.rdb', makeRdb([
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
  ]))], 'initial');
  await files.upload('', [asUpload('mini.scd', MINI_SCL)], 'initial');
  return new CompareService({ load });
}

test('rdb profile vs rdb profile: section union with statuses, settings diff', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const compare = await fixture(tmp);
    const a = 'pair.rdb::OLD_UNIT';
    const b = 'pair.rdb::NEW_UNIT';

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
    const { files, load } = await makeBundle(tmp);
    // Same section, same settings, opposite key order in the file.
    await files.upload('', [asUpload('order.rdb', makeRdb([
      { name: 'A_UNIT', relayType: 'SEL-451', sections: [{ key: 'G', desc: 'Global', settings: { TID: 'X', SID: 'Y' } }] },
      { name: 'B_UNIT', relayType: 'SEL-451', sections: [{ key: 'G', desc: 'Global', settings: { SID: 'Y', TID: 'X' } }] },
    ]))], 'initial');
    const compare = new CompareService({ load });

    const result = await compare.compare('order.rdb::A_UNIT', 'order.rdb::B_UNIT');
    assert.deepEqual(result.summary, { added: 0, removed: 0, edited: 0, unchanged: 1 });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('signatures cover page rows: a Report-ID-only edit reads edited', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const { files, load } = await makeBundle(tmp);
    // rptID lives only in the Reports page rows — the settings summary
    // deliberately abbreviates it away.
    await files.upload('', [asUpload('a.scd', MINI_SCL)], 'initial');
    await files.upload('', [asUpload('b.scd', MINI_SCL.replace('rptID="BRep01"', 'rptID="BRep01_v2"'))], 'initial');
    const compare = new CompareService({ load });

    const result = await compare.compare('a.scd::RELAY_1', 'b.scd::RELAY_1');
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('reports'), 'edited');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a receive-map edit diffs as the point table, not summary settings', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const { files, load } = await makeBundle(tmp);
    // Rebinding an ExtRef to another control block moves it between summary
    // groups — without the derived flag that read as a removed + added pair
    // of "N points bound" settings on top of the real row change.
    await files.upload('', [asUpload('a.scd', MINI_SCL)], 'initial');
    await files.upload('', [asUpload('b.scd', MINI_SCL.replace('srcCBName="GPub01"', 'srcCBName="GPub02"'))], 'initial');
    const compare = new CompareService({ load });

    const a = 'a.scd::RTU_1';
    const b = 'b.scd::RTU_1';
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
    const { files, load } = await makeBundle(tmp);
    // b.scd edits one section inside RELAY_1 and renames the other IED, so
    // the three folders cover every rollup: mixed, wholly removed, wholly
    // added.
    await files.upload('', [asUpload('a.scd', MINI_SCL)], 'initial');
    await files.upload('', [asUpload('b.scd', MINI_SCL
      .replace('rptID="BRep01"', 'rptID="BRep01_v2"')
      .replace('<IED name="RTU_1"', '<IED name="RTU_2"'))], 'initial');
    const compare = new CompareService({ load });

    const result = await compare.compare('a.scd', 'b.scd');

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

    const item = await compare.compareItem('a.scd', 'b.scd', 'RELAY_1/reports');
    assert.equal(item.status, 'edited');
    const changed = item.diff.pages[0].changes.find((row) => row.kind === 'changed');
    assert.equal(changed.updated['Report ID'], 'BRep01_v2');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('scd ied vs scd ied compares inspect items; mixed kinds are rejected', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-compare-'));
  try {
    const compare = await fixture(tmp);
    const relay = 'mini.scd::RELAY_1';
    const rtu = 'mini.scd::RTU_1';

    const result = await compare.compare(relay, rtu);
    const byPath = new Map(result.tree.map((node) => [node.path, node.status]));
    assert.equal(byPath.get('network'), 'edited'); // RELAY_1 has addresses, RTU_1 none
    assert.equal(byPath.get('subscriptions'), 'added'); // only RTU_1 receives
    assert.equal(byPath.get('tx'), 'removed'); // only RELAY_1 publishes
    assert.equal(byPath.get('reports'), 'removed');
    assert.equal(byPath.get('ds:S1:CFG:GPDSet01'), 'removed');
    assert.equal(byPath.get('structure'), 'edited'); // different logical devices

    await assert.rejects(
      () => compare.compare(relay, 'pair.rdb::OLD_UNIT'),
      /same kind/,
    );
    await assert.rejects(
      () => compare.compare('x.nope', 'y.nope'),
      /not a settings artifact/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
