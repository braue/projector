// Project-list failure handling: the service must start (and keep serving
// previously exported projects) when listprojects fails, expose the error,
// and recover on refreshList once the database is back.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectService } from '../services/projects.js';

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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rtac-explorer-test-'));
  try {
    // "Beta" was exported in a previous run.
    await mkdir(path.join(dataDir, 'exports', 'Beta'), { recursive: true });

    const client = flakyClient();
    const service = new ProjectService({ client, dataDir });
    await service.init(); // must not throw

    let list = service.list();
    assert.match(list.error, /database unreachable/);
    // The on-disk export is still there and browsable.
    assert.deepEqual(list.projects, [{ name: 'Beta', status: 'ready' }]);

    // Database comes back; retry merges the real list, keeping Beta ready.
    client.failing = false;
    await service.refreshList();
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rtac-explorer-test-'));
  try {
    await mkdir(path.join(dataDir, 'exports', 'Beta'), { recursive: true });
    const client = flakyClient();
    client.failing = false;
    const service = new ProjectService({ client, dataDir });
    await service.init();

    await rm(path.join(dataDir, 'exports', 'Beta'), { recursive: true });

    await assert.rejects(() => service.tree('Beta'), /missing on disk/);
    const { projects } = service.list();
    assert.equal(projects.find((p) => p.name === 'Beta').status, 'available');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
