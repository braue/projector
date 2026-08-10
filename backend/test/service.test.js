// RTAC catalog + per-project export service: the catalog must absorb a
// listprojects failure (previously exported projects stay browsable), expose
// the error, and recover on refresh once the database is back.

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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'purview-rtac-test-'));
  try {
    // "Beta" was exported into this project in a previous run.
    await mkdir(path.join(dataDir, 'Beta'), { recursive: true });

    const catalog = new RtacCatalog({ client: flakyClient() });
    const service = new RtacService({ catalog, dataDir });
    await service.init();
    await catalog.refresh(); // the failure lands in catalog.error, never throws

    let list = service.list();
    assert.match(list.error, /database unreachable/);
    // The on-disk export is still there and browsable.
    assert.deepEqual(list.projects, [{ name: 'Beta', status: 'ready' }]);

    // Database comes back; retry merges the real list, keeping Beta ready.
    catalog.client.failing = false;
    await catalog.refresh();
    list = service.list();
    assert.equal(list.error, null);
    assert.deepEqual(list.projects, [
      { name: 'Alpha', status: 'available' },
      { name: 'Beta', status: 'ready' },
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a ready project whose export vanished from disk resets to available', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'purview-rtac-test-'));
  try {
    await mkdir(path.join(dataDir, 'Beta'), { recursive: true });
    const catalog = new RtacCatalog({ client: flakyClient() });
    catalog.client.failing = false;
    await catalog.refresh();
    const service = new RtacService({ catalog, dataDir });
    await service.init();

    await rm(path.join(dataDir, 'Beta'), { recursive: true });

    await assert.rejects(() => service.tree('Beta'), /missing on disk/);
    const { projects } = service.list();
    assert.equal(projects.find((p) => p.name === 'Beta').status, 'available');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
