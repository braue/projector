// Billable hours: per-cell writes into one machine-global file, carried
// across a project rename.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HoursService } from '../services/hours.js';
import { ProjectsService } from '../services/projects.js';

async function withTmp(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-hours-'));
  try {
    await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('hours: cells round-trip, survive a restart, and 0 clears', () => withTmp(async (tmp) => {
  const file = path.join(tmp, 'hours.json');
  const seen = [];
  const hours = new HoursService({ file, events: { publish: (type) => seen.push(type) } });

  assert.deepEqual(await hours.get(), { budgets: {}, days: {} });

  // Two writes at once must both land — the queue serializes read-modify-write.
  await Promise.all([
    hours.setDay('2026-10-19', 'Eunice', 3.5),
    hours.setDay('2026-10-19', 'Gulfport', 4),
    hours.setBudget('Eunice', 120),
  ]);
  const expected = {
    budgets: { Eunice: 120 },
    days: { '2026-10-19': { Eunice: 3.5, Gulfport: 4 } },
  };
  assert.deepEqual(await hours.get(), expected);
  assert.deepEqual(await new HoursService({ file }).get(), expected);
  assert.equal(seen.filter((t) => t === 'hours').length, 3);

  await hours.setDay('2026-10-19', 'Eunice', 0);
  await hours.setDay('2026-10-19', 'Gulfport', 0);
  await hours.setBudget('Eunice', 0);
  assert.deepEqual(await hours.get(), { budgets: {}, days: {} });

  // Float noise is rounded off.
  await hours.setDay('2026-10-20', 'Eunice', 0.1 + 0.2);
  assert.equal((await hours.get()).days['2026-10-20'].Eunice, 0.3);
}));

test('hours: bad input is refused, a hand-edited file is cleaned', () => withTmp(async (tmp) => {
  const file = path.join(tmp, 'hours.json');
  const hours = new HoursService({ file });

  assert.throws(() => hours.setDay('10/19/2026', 'Eunice', 2), /invalid date/);
  assert.throws(() => hours.setDay('2026-10-19', '  ', 2), /project required/);
  assert.throws(() => hours.setDay('2026-10-19', 'Eunice', 25), /invalid hours/);
  assert.throws(() => hours.setDay('2026-10-19', 'Eunice', -1), /invalid hours/);
  assert.throws(() => hours.setBudget('Eunice', 'lots'), /invalid hours/);

  await writeFile(file, JSON.stringify({
    budgets: { Eunice: 'x', Gulfport: 40 },
    days: { nope: { Eunice: 1 }, '2026-10-19': { Eunice: 2, Bad: -3 } },
  }));
  assert.deepEqual(await hours.get(), {
    budgets: { Gulfport: 40 },
    days: { '2026-10-19': { Eunice: 2 } },
  });

  // A corrupt file fails the read rather than reading as empty.
  await writeFile(file, '{ not json');
  await assert.rejects(hours.get(), /could not read the hours/);
}));

test('hours: a project rename carries its hours and budget', () => withTmp(async (tmp) => {
  const hours = new HoursService({ file: path.join(tmp, 'hours.json') });
  const projects = new ProjectsService({ dataDir: tmp, catalog: null, hours });
  await projects.init();
  await projects.create('Eunice');

  await hours.setDay('2026-10-19', 'Eunice', 2);
  await hours.setDay('2026-10-20', 'Eunice', 5);
  await hours.setBudget('Eunice', 80);

  await projects.rename('Eunice', 'Eunice 35kV');
  assert.deepEqual(await hours.get(), {
    budgets: { 'Eunice 35kV': 80 },
    days: { '2026-10-19': { 'Eunice 35kV': 2 }, '2026-10-20': { 'Eunice 35kV': 5 } },
  });
}));
