// The everywhere search: one string across every project's sources and
// notes, grouped by project. The question it answers is "which job used this
// value" — so a project with no hits stays out of the answer, and one broken
// source is reported beside the results, never allowed to sink them.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GlobalSearch } from '../services/globalSearch.js';
import { ProjectsService } from '../services/projects.js';
import { makeRdb } from './helpers/makeRdb.js';

// The RTAC side needs only the catalog's names; no database in these tests.
const NO_CATALOG = { names: [], error: null };

async function twoProjects(tmp) {
  const projects = new ProjectsService({ dataDir: tmp, catalog: NO_CATALOG });
  await projects.init();
  await projects.create('Substation 12');
  await projects.create('Substation 40');

  const sub12 = await projects.bundle('Substation 12');
  await sub12.rdb.upload('feeders.rdb', makeRdb([
    {
      name: 'FEEDER_1',
      relayType: 'SEL-751',
      sections: [{ key: 'P1', desc: 'Port 1', settings: { IPADDR: '10.30.4.7', TID: 'FEEDER_ONE' } }],
    },
  ]));

  const sub40 = await projects.bundle('Substation 40');
  const note = await sub40.notes.create('punch list');
  await sub40.notes.setText(note.id, '[ ] verify DNP map\n[ ] relay at 10.30.4.9 still unreachable');

  return { projects, search: new GlobalSearch({ projects }) };
}

test('finds hits across projects, grouped, and skips projects with none', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-global-'));
  try {
    const { search } = await twoProjects(tmp);

    const found = await search.search('10.30.4');
    assert.deepEqual(found.errors, []);
    assert.deepEqual(found.projects.map((project) => project.name), ['Substation 12', 'Substation 40']);

    const [sub12, sub40] = found.projects;
    assert.equal(sub12.sources.length, 1);
    assert.equal(sub12.sources[0].type, 'rdb');
    assert.equal(sub12.sources[0].ref, 'feeders::FEEDER_1');
    assert.ok(sub12.sources[0].totalMatches >= 1);
    assert.deepEqual(sub12.notes, []);

    assert.deepEqual(sub40.sources, []);
    assert.equal(sub40.notes.length, 1);
    assert.equal(sub40.notes[0].name, 'punch list');
    assert.match(sub40.notes[0].matches.at(-1).text, /10\.30\.4\.9/);
    assert.match(sub40.notes[0].matches.at(-1).location, /line 2/);

    // A term nobody uses returns no projects at all.
    const nothing = await search.search('zz-not-anywhere');
    assert.deepEqual(nothing.projects, []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a note name match counts, and results respect the per-item cap', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-global-'));
  try {
    const { projects, search } = await twoProjects(tmp);
    const sub40 = await projects.bundle('Substation 40');
    const note = await sub40.notes.create('DNP outstanding items');
    await sub40.notes.setText(note.id, Array.from({ length: 10 }, (_, i) => `DNP item ${i + 1}`).join('\n'));

    const found = await search.search('dnp');
    const hits = found.projects.find((project) => project.name === 'Substation 40').notes;
    const capped = hits.find((hit) => hit.name === 'DNP outstanding items');
    // Name + 10 lines matched; only the cap's worth of matches travels.
    assert.equal(capped.totalMatches, 11);
    assert.equal(capped.truncated, true);
    assert.ok(capped.matches.length < 11);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
