// Identity renames (RTAC exports, uploads) and their canvas-ref rewrites,
// plus the notes store.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'purview-rename-'));

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

test('rtac export rename moves the folder and keeps state', async () => {
  const tmp = await tmpDir();
  try {
    await mkdir(path.join(tmp, 'Alpha'));
    await writeFile(path.join(tmp, 'Alpha', 'Feeder.xml'),
      '<?xml version="1.0"?><RTACModule><ExportSource><Schema>1</Schema></ExportSource><Device><Name>F</Name><Protocol>DNPClient</Protocol></Device></RTACModule>');
    const service = new RtacService({ catalog: new RtacCatalog({ client: {} }), dataDir: tmp });
    await service.init();

    assert.deepEqual(await service.rename('Alpha', 'Beta'), { name: 'Beta' });
    assert.deepEqual(service.list().projects.map((p) => p.name), ['Beta']);
    const tree = await service.tree('Beta');
    assert.equal(tree.tree.length, 1);

    await assert.rejects(() => service.rename('Alpha', 'X'), /not in this project/);
    await assert.rejects(() => service.rename('Beta', ''), /name required/);
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

test('notes: create, rename, items round-trip with kinds, delete', async () => {
  const tmp = await tmpDir();
  try {
    const notes = new NotesService({ file: path.join(tmp, 'notes.json') });
    assert.deepEqual(await notes.list(), []);

    const created = await notes.create('Commissioning');
    assert.equal(created.name, 'Commissioning');

    await notes.rename(created.id, 'Site acceptance');
    const updated = await notes.setItems(created.id, [
      { text: 'Observations', kind: 'text', level: 0 },
      { text: 'Verify relay settings', kind: 'check', checked: true, level: 0 },
      { text: 'Check DNP map', kind: 'check', checked: false, level: 1 },
      { text: 'breaker slow to close', kind: 'bullet', level: 1 },
      { text: 'Energize bus', kind: 'number', level: 0 },
      { text: 42, kind: 'nope', checked: 'yes', level: 9 }, // hostile shapes sanitize
    ]);
    assert.equal(updated.name, 'Site acceptance');
    assert.deepEqual(
      updated.items.map(({ text, kind, checked, level }) => ({ text, kind, checked, level })),
      [
        { text: 'Observations', kind: 'text', checked: false, level: 0 },
        { text: 'Verify relay settings', kind: 'check', checked: true, level: 0 },
        { text: 'Check DNP map', kind: 'check', checked: false, level: 1 },
        { text: 'breaker slow to close', kind: 'bullet', checked: false, level: 1 },
        { text: 'Energize bus', kind: 'number', checked: false, level: 0 },
        { text: '42', kind: 'text', checked: true, level: 0 },
      ],
    );
    assert.ok(updated.items.every((item) => typeof item.id === 'string' && item.id));

    // Persisted: a fresh service reads the same file.
    const reread = new NotesService({ file: path.join(tmp, 'notes.json') });
    assert.equal((await reread.list())[0].items.length, 6);

    // Concurrent mutations serialize — neither write is lost to the other's
    // read-modify-write.
    const parallel = await notes.create('Parallel');
    await Promise.all([
      notes.setItems(parallel.id, [{ text: 'kept', kind: 'text', level: 0 }]),
      notes.rename(parallel.id, 'Parallel renamed'),
    ]);
    const after = (await notes.list()).find((note) => note.id === parallel.id);
    assert.equal(after.name, 'Parallel renamed');
    assert.equal(after.items[0].text, 'kept');
    await notes.remove(parallel.id);

    await notes.remove(created.id);
    assert.deepEqual(await notes.list(), []);
    await assert.rejects(() => notes.rename(created.id, 'x'), /unknown note/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
