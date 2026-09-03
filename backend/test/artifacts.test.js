// The artifacts layer over the files tree: kind detection, profile refs,
// inspect over live and ARCHIVED versions, the RTAC folder intake, and the
// bounded model cache.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { asUpload, makeBundle } from './helpers/bundle.js';
import { makeRdb } from './helpers/makeRdb.js';
import { MINI_SCL } from './helpers/miniScl.js';
import { MINI_SW } from './helpers/miniSw.js';

const RDB_V1 = makeRdb([{
  name: 'FEEDER_1',
  relayType: 'SEL-751A',
  sections: [{ key: 'G', desc: 'Global', settings: { TID: 'ONE' } }],
}]);
const RDB_V2 = makeRdb([{
  name: 'FEEDER_1',
  relayType: 'SEL-751A',
  sections: [{ key: 'G', desc: 'Global', settings: { TID: 'TWO' } }],
}]);

test('kinds annotate the tree; profiles/tree/item resolve by path ref', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const { files, artifacts } = await makeBundle(tmp);
    await files.createFolder('', 'Station A');
    await files.upload('Station A', [
      asUpload('unit.rdb', RDB_V1),
      asUpload('mini.scd', MINI_SCL),
      asUpload('switch.xml', MINI_SW),
      asUpload('readme.txt', 'hello'),
    ], 'initial');

    const tree = await files.tree((name, isDir) => artifacts.kindOf(name, isDir));
    const station = tree[0];
    const kinds = new Map(station.children.map((node) => [node.name, node.kind]));
    assert.equal(kinds.get('unit.rdb'), 'rdb');
    assert.equal(kinds.get('mini.scd'), 'scd');
    assert.equal(kinds.get('switch.xml'), 'sw');
    assert.equal(kinds.get('readme.txt'), null);

    const profiles = await artifacts.profiles('Station A/unit.rdb');
    assert.deepEqual(profiles.map((p) => p.ref), ['Station A/unit.rdb::FEEDER_1']);

    const inspect = await artifacts.tree('Station A/unit.rdb::FEEDER_1');
    assert.equal(inspect.name, 'FEEDER_1');
    const item = await artifacts.item('Station A/unit.rdb::FEEDER_1', 'G');
    assert.equal(item.settings.TID, 'ONE');

    // SCD profiles are its IEDs; SW carries exactly one profile.
    const ieds = await artifacts.profiles('Station A/mini.scd');
    assert.deepEqual(ieds.map((p) => p.name).sort(), ['RELAY_1', 'RTU_1']);
    const sw = await artifacts.profiles('Station A/switch.xml');
    assert.equal(sw.length, 1);

    await assert.rejects(() => artifacts.tree('Station A/readme.txt'), /not a settings artifact/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('an archived version inspects by its .versions path; a new version re-parses', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const { files, artifacts } = await makeBundle(tmp);
    await files.upload('', [asUpload('unit.rdb', RDB_V1)], 'first');
    assert.equal((await artifacts.item('unit.rdb::FEEDER_1', 'G')).settings.TID, 'ONE');

    await files.upload('', [asUpload('unit.rdb', RDB_V2)], 'second');
    // The live path now parses the NEW bytes (the cache was invalidated).
    assert.equal((await artifacts.item('unit.rdb::FEEDER_1', 'G')).settings.TID, 'TWO');

    // The archived version is an artifact of its own, at its real path.
    const [node] = await files.tree();
    const [previous] = node.versions;
    assert.equal(previous.note, 'first');
    const oldItem = await artifacts.item(`${previous.path}::FEEDER_1`, 'G');
    assert.equal(oldItem.settings.TID, 'ONE');

    // Old vs new — the version accordion's one-click compare works on paths.
    const oldSide = await artifacts.comparable(`${previous.path}::FEEDER_1`);
    const newSide = await artifacts.comparable('unit.rdb::FEEDER_1');
    assert.equal(oldSide.kind, newSide.kind);
    assert.notEqual(oldSide.entries[0].signature, newSide.entries[0].signature);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rtac folder upload lands as <name>.rtac, versions on re-upload, parses lazily', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const { files, artifacts } = await makeBundle(tmp);
    const xml = (name) => `<?xml version="1.0"?><SettingPage><Name>${name}</Name></SettingPage>`;

    const first = await artifacts.uploadFolder('', [
      { path: 'Export1/SEL_RTAC/Devices.xml', buffer: Buffer.from(xml('one')) },
      { path: 'Export1/ExportSource.xml', buffer: Buffer.from(xml('src')) },
    ], 'as commissioned');
    assert.deepEqual(first.added.map((a) => a.path), ['Export1.rtac']);

    let tree = await files.tree((name, isDir) => artifacts.kindOf(name, isDir));
    assert.equal(tree.length, 1);
    assert.equal(tree[0].type, 'file'); // an artifact leaf, not a browsable folder
    assert.equal(tree[0].kind, 'rtac');
    assert.equal(tree[0].note, 'as commissioned');

    // Same folder again → a new version stacks; the old one keeps its note.
    await artifacts.uploadFolder('', [
      { path: 'Export1/SEL_RTAC/Devices.xml', buffer: Buffer.from(xml('two')) },
    ], 'rev 2');
    tree = await files.tree((name, isDir) => artifacts.kindOf(name, isDir));
    assert.equal(tree[0].note, 'rev 2');
    assert.equal(tree[0].versions.length, 1);
    assert.equal(tree[0].versions[0].note, 'as commissioned');

    const inspect = await artifacts.tree('Export1.rtac');
    assert.equal(inspect.name, 'Export1');
    assert.ok(inspect.tree.length >= 1);

    // Notes are mandatory on every intake path.
    await assert.rejects(() => artifacts.uploadFolder('', [
      { path: 'X/a.xml', buffer: Buffer.from(xml('x')) },
    ]), /version note/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('concurrent reads of one artifact share a single parse', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const { files, artifacts } = await makeBundle(tmp);
    await files.upload('', [asUpload('unit.rdb', RDB_V1)], 'initial');

    // Count actual parses under the racing reads (tree fetch vs compare
    // adapter is the real-world pair; a big RTAC export parses for a minute
    // and doubling that is exactly the memory spike the cache prevents).
    const kind = artifacts.kinds.rdb;
    const parse = kind.parse.bind(kind);
    let parses = 0;
    kind.parse = (buffer, name) => {
      parses += 1;
      return parse(buffer, name);
    };

    await Promise.all([
      artifacts.entry('unit.rdb'),
      artifacts.entry('unit.rdb'),
      artifacts.tree('unit.rdb::FEEDER_1'),
    ]);
    assert.equal(parses, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('the model cache is bounded and re-keyed by content', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const { files, artifacts } = await makeBundle(tmp);
    // 13 light artifacts — one more than the light cap — parsed in order.
    const names = Array.from({ length: 13 }, (_, i) => `unit-${String(i).padStart(2, '0')}.rdb`);
    await files.upload('', names.map((name) => asUpload(name, RDB_V1)), 'initial');
    for (const name of names) await artifacts.entry(name);

    // The first one was evicted; touching it parses again and still answers.
    const item = await artifacts.item(`${names[0]}::FEEDER_1`, 'G');
    assert.equal(item.settings.TID, 'ONE');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rtac export: a doomed versionOf rename fails before the export runs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-artifacts-'));
  try {
    const xml = (name) => `<?xml version="1.0"?><SettingPage><Name>${name}</Name></SettingPage>`;
    const exportCalls = [];
    const catalog = {
      names: ['Feeder 9'],
      error: null,
      // A fake database export: land one XML in the staging directory.
      client: {
        exportXml: async ({ name, directory }) => {
          exportCalls.push(name);
          await mkdir(path.join(directory, 'SEL_RTAC'), { recursive: true });
          await writeFile(path.join(directory, 'SEL_RTAC', 'Devices.xml'), xml('fresh'));
        },
      },
    };
    const { files, artifacts } = await makeBundle(tmp, { catalog });
    await artifacts.uploadFolder('', [
      { path: 'Old Name/SEL_RTAC/Devices.xml', buffer: Buffer.from(xml('old')) },
      { path: 'Feeder 9/SEL_RTAC/Devices.xml', buffer: Buffer.from(xml('clash')) },
    ], 'seed');

    // The download would rename Old Name.rtac onto the already-existing
    // Feeder 9.rtac — refused up front, before exportXml ever runs.
    await assert.rejects(
      () => artifacts.startExport('', 'Feeder 9', 'n', 'Old Name.rtac'),
      /already exists: Feeder 9\.rtac/,
    );
    // A versionOf target that is not there fails up front too.
    await assert.rejects(
      () => artifacts.startExport('', 'Feeder 9', 'n', 'ghost.rtac'),
      /no such entry/,
    );
    assert.equal(exportCalls.length, 0);

    // The happy versionOf path records which database the entry mirrors.
    await files.removeEntry('Feeder 9.rtac');
    await artifacts.startExport('', 'Feeder 9', 'pull', 'Old Name.rtac');
    // Fire-and-forget: wait for the pending export to settle.
    for (let i = 0; i < 100 && artifacts.exportStatus().length; i += 1) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    }
    assert.deepEqual(artifacts.exportStatus(), []);
    assert.equal(exportCalls.length, 1);
    const tree = await files.tree((name, isDir) => artifacts.kindOf(name, isDir));
    assert.deepEqual(tree.map((node) => node.name), ['Feeder 9.rtac']);
    assert.equal(tree[0].database, 'Feeder 9');
    assert.equal(tree[0].versions.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
