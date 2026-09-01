// Identity renames (RTAC exports, uploads) and their canvas-ref rewrites,
// plus the notes store.

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { REF_SEPARATOR, replaceRefFile } from '../lib/refs.js';
import { CanvasService } from '../services/canvas.js';
import { NotesService } from '../services/notes.js';
import { RdbService } from '../services/rdb.js';
import { RtacCatalog } from '../services/rtacCatalog.js';
import { RtacService } from '../services/rtac.js';
import { makeRdb } from './helpers/makeRdb.js';

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'projector-rename-'));

test('upload rename moves the id and the canvas ref follows', async () => {
  const tmp = await tmpDir();
  try {
    const rdb = new RdbService({ dataDir: tmp });
    await rdb.init();
    await rdb.upload('old name.rdb', makeRdb([
      { name: 'FEEDER_1', relayType: 'SEL-451', sections: [{ key: 'G', desc: 'Global', settings: { TID: 'X' } }] },
    ]));

    const canvas = new CanvasService({
      file: path.join(tmp, 'canvas.json'),
      resolvers: { rdb: async () => ({ name: 'FEEDER_1', model: 'SEL-451', interfaces: [], endpoints: [] }) },
      augment: async () => ({}),
    });
    await canvas.init();
    await canvas.addDevice({ source: { type: 'rdb', ref: `old_name${REF_SEPARATOR}FEEDER_1` } });

    // Wired the way the project bundle wires it.
    rdb.onRenamed = (fromId, toId) =>
      canvas.renameRefs('rdb', (ref) => replaceRefFile(ref, fromId, toId));

    const renamed = await rdb.rename('old_name', 'Station North');
    assert.equal(renamed.previousId, 'old_name');
    assert.equal(renamed.id, 'Station_North');
    assert.equal(renamed.fileName, 'Station North');
    assert.equal(renamed.profiles[0].ref, `Station_North${REF_SEPARATOR}FEEDER_1`);
    // The store serves the new id only.
    assert.ok(rdb.store.get('Station_North'));
    assert.equal(rdb.store.get('old_name'), undefined);

    // The hook already rewrote the placement.
    const graph = await canvas.graph();
    assert.equal(graph.devices[0].source.ref, `Station_North${REF_SEPARATOR}FEEDER_1`);

    await assert.rejects(() => rdb.rename('gone', 'x'), /unknown rdb file/);
    await assert.rejects(() => rdb.rename('Station_North', '   '), /name required/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rtac export rename moves the display name, never the id', async () => {
  const tmp = await tmpDir();
  try {
    await mkdir(path.join(tmp, 'Alpha'));
    await writeFile(path.join(tmp, 'Alpha', 'Feeder.xml'),
      '<?xml version="1.0"?><RTACModule><ExportSource><Schema>1</Schema></ExportSource><Device><Name>F</Name><Protocol>DNPClient</Protocol></Device></RTACModule>');
    const service = new RtacService({ catalog: new RtacCatalog({ client: {} }), dataDir: tmp });
    await service.init();

    // The id is the folder AND the canvas ref, so a rename must not touch it:
    // only what the sidebar reads changes.
    const renamed = await service.rename('Alpha', 'Beta');
    assert.deepEqual(
      { name: renamed.name, displayName: renamed.displayName },
      { name: 'Alpha', displayName: 'Beta' },
    );
    assert.deepEqual(service.list().projects.map((p) => [p.name, p.displayName]), [['Alpha', 'Beta']]);

    // Reads still address the id — a placement made before the rename works.
    const tree = await service.tree('Alpha');
    assert.equal(tree.tree.length, 1);
    // And the folder is where it always was.
    await access(path.join(tmp, 'Alpha'));

    // The new display name survives a restart, from the index.
    const restarted = new RtacService({ catalog: new RtacCatalog({ client: {} }), dataDir: tmp });
    await restarted.init();
    assert.deepEqual(restarted.list().projects.map((p) => [p.name, p.displayName]), [['Alpha', 'Beta']]);

    await assert.rejects(() => service.rename('Beta', 'X'), /not in this project/);
    await assert.rejects(() => service.rename('Alpha', ''), /name required/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a model-blind file reads edited when only its raw config changes', async () => {
  const tmp = await tmpDir();
  try {
    const controller = (cycle) => `<?xml version="1.0"?><RTACModule><MainController><ExportSource><Schema>1</Schema></ExportSource><MainTask><CycleTime>${cycle}</CycleTime></MainTask></MainController></RTACModule>`;
    for (const [folder, cycle] of [['Old', '100'], ['New', '20'], ['Same', '100']]) {
      await mkdir(path.join(tmp, folder));
      await writeFile(path.join(tmp, folder, 'Main Controller.xml'), controller(cycle));
    }
    const service = new RtacService({ catalog: new RtacCatalog({ client: {} }), dataDir: tmp });
    await service.init();

    const signature = async (name) =>
      (await service.comparable(name)).entries[0].signature;
    // The parser models nothing from Main Controller, so the raw fallback
    // must carry the difference — and identical bytes must still agree.
    assert.notEqual(await signature('Old'), await signature('New'));
    assert.equal(await signature('Old'), await signature('Same'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('notes: create, rename, text round-trip, delete', async () => {
  const tmp = await tmpDir();
  try {
    const notes = new NotesService({ file: path.join(tmp, 'notes.json') });
    assert.deepEqual(await notes.list(), []);

    const created = await notes.create('Commissioning');
    assert.equal(created.name, 'Commissioning');
    assert.equal(created.text, '');

    await notes.rename(created.id, 'Site acceptance');
    const body = 'Observations\n[x] Verify relay settings\n\t[ ] Check DNP map\n- breaker slow to close\n1. Energize bus';
    const updated = await notes.setText(created.id, body);
    assert.equal(updated.name, 'Site acceptance');
    assert.equal(updated.text, body);
    await assert.rejects(() => notes.setText(created.id, 42), /text must be a string/);

    // Persisted: a fresh service reads the same file.
    const reread = new NotesService({ file: path.join(tmp, 'notes.json') });
    assert.equal((await reread.list())[0].text, body);

    // Concurrent mutations serialize — neither write is lost to the other's
    // read-modify-write.
    const parallel = await notes.create('Parallel');
    await Promise.all([
      notes.setText(parallel.id, 'kept'),
      notes.rename(parallel.id, 'Parallel renamed'),
    ]);
    const after = (await notes.list()).find((note) => note.id === parallel.id);
    assert.equal(after.name, 'Parallel renamed');
    assert.equal(after.text, 'kept');
    await notes.remove(parallel.id);

    await notes.remove(created.id);
    assert.deepEqual(await notes.list(), []);
    await assert.rejects(() => notes.rename(created.id, 'x'), /unknown note/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
