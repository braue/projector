// RTAC catalog + per-project export service: the sidebar list is only what
// the project holds; the database browser's available() merges the
// machine-global catalog with in-project flags and must absorb a
// listprojects failure (previously exported projects stay browsable) and
// recover on refresh. The no-database path uploads an exported XML folder.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RtacService } from '../services/rtac.js';
import { RtacCatalog } from '../services/rtacCatalog.js';

function flakyClient() {
  const client = {
    failing: true,
    async listProjects() {
      if (client.failing) throw new Error('database unreachable');
      return [{ name: 'Alpha' }, { name: 'Beta' }];
    },
    async exportXml() {
      throw new Error('not under test');
    },
  };
  return client;
}

test('list failure is non-fatal, served, and recoverable', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-rtac-test-'));
  try {
    // "Beta" was exported into this project in a previous run.
    await mkdir(path.join(dataDir, 'Beta'), { recursive: true });

    const catalog = new RtacCatalog({ client: flakyClient() });
    const service = new RtacService({ catalog, dataDir });
    await service.init();
    await catalog.refresh(); // the failure lands in catalog.error, never throws

    // The project's own list serves regardless of the database.
    assert.deepEqual(service.list(), { projects: [{ name: 'Beta', status: 'ready' }] });
    let available = service.available();
    assert.match(available.error, /database unreachable/);
    assert.deepEqual(available.projects, []);

    // Database comes back; the browser list merges with in-project flags.
    catalog.client.failing = false;
    await catalog.refresh();
    available = service.available();
    assert.equal(available.error, null);
    assert.deepEqual(available.projects, [
      { name: 'Alpha', inProject: false },
      { name: 'Beta', inProject: true },
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a ready export whose folder vanished from disk drops out of the project', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-rtac-test-'));
  try {
    await mkdir(path.join(dataDir, 'Beta'), { recursive: true });
    const catalog = new RtacCatalog({ client: flakyClient() });
    catalog.client.failing = false;
    await catalog.refresh();
    const service = new RtacService({ catalog, dataDir });
    await service.init();

    await rm(path.join(dataDir, 'Beta'), { recursive: true });

    await assert.rejects(() => service.tree('Beta'), /missing on disk/);
    assert.deepEqual(service.list().projects, []);
    assert.deepEqual(
      service.available().projects.find((p) => p.name === 'Beta'),
      { name: 'Beta', inProject: false },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an exported XML folder uploads into the project without the database', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-rtac-test-'));
  try {
    const catalog = new RtacCatalog({ client: flakyClient() });
    const service = new RtacService({ catalog, dataDir });
    await service.init();

    const xml = (name) => Buffer.from(`<?xml version="1.0"?><Root name="${name}" />`);
    const result = await service.uploadFolder([
      { path: 'StationA/SEL_RTAC/Devices.xml', buffer: xml('devices') },
      { path: 'StationA/Tag Processor.xml', buffer: xml('tags') },
      { path: 'StationA/readme.txt', buffer: Buffer.from('not xml — skipped') },
      { path: 'StationA/../evil.xml', buffer: xml('evil') }, // '..' stripped, lands inside
    ]);
    assert.deepEqual(result.added, [{ name: 'StationA', files: 3 }]);
    assert.deepEqual(service.list().projects, [{ name: 'StationA', status: 'ready' }]);

    // The parse pipeline reads the uploaded files like any export.
    const tree = await service.tree('StationA');
    assert.equal(tree.name, 'StationA');

    // Nothing but XML → a clear 400.
    await assert.rejects(
      () => service.uploadFolder([{ path: 'Empty/notes.txt', buffer: Buffer.from('x') }]),
      /no \.xml files found/,
    );

    // Removal takes it back out of the project.
    await service.remove('StationA');
    assert.deepEqual(service.list().projects, []);
    await assert.rejects(() => service.remove('StationA'), /not in this project/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
