// Project archiving: a marker beside files/ that files the project under the
// switcher's Archive section and survives a rename.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectsService } from '../services/projects.js';

test('projects: archive, rename keeps it archived, unarchive', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-projects-'));
  try {
    const seen = [];
    const projects = new ProjectsService({ dataDir, catalog: null, events: { publish: (type) => seen.push(type) } });
    await projects.init();
    await projects.create('Alpha');
    await projects.create('Bravo');

    assert.deepEqual(await projects.listWithArchive(), { projects: ['Alpha', 'Bravo'], archived: [] });

    seen.length = 0;
    await projects.setArchived('Alpha', true);
    assert.deepEqual(seen, ['projects']);
    assert.deepEqual(await projects.listWithArchive(), { projects: ['Alpha', 'Bravo'], archived: ['Alpha'] });

    await projects.rename('Alpha', 'Alpha Old');
    assert.deepEqual((await projects.listWithArchive()).archived, ['Alpha Old']);
    // Archived projects still open.
    await projects.bundle('Alpha Old');

    await projects.setArchived('Alpha Old', false);
    await projects.setArchived('Alpha Old', false); // idempotent
    assert.deepEqual((await projects.listWithArchive()).archived, []);

    await assert.rejects(projects.setArchived('Nope', true), { status: 404 });
    projects.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
