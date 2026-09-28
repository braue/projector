// The job registry's events, the SSE stream, the project folder watcher and
// the shared AcRTAC catalog — the pieces that let the window follow the
// backend without polling.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { EventHub } from '../lib/events.js';
import { eventRoutes } from '../routes/jobs.js';
import { JobRegistry } from '../services/jobs.js';
import { ProjectsService } from '../services/projects.js';
import { RtacCatalog } from '../services/rtacCatalog.js';

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder() {
  const seen = [];
  return { seen, publish: (type, data) => seen.push([type, structuredClone(data)]) };
}

test('jobs: publish start, waiting, settle; remove only finished ones', async () => {
  const events = recorder();
  const jobs = new JobRegistry({ events });
  let release;
  const job = jobs.start('demo', async (handle) => {
    handle.waiting('behind another session');
    await new Promise((resolve) => { release = resolve; });
    handle.running();
    handle.log('working');
    return { big: 'result' };
  }, { meta: { type: 'demo' } });
  await tick();
  assert.throws(() => jobs.remove(job.id), /still running/);
  assert.equal(jobs.active({ type: 'demo' }).length, 1);
  release();
  await tick(200);

  const states = events.seen.filter(([type]) => type === 'job').map(([, j]) => [j.status, j.waiting]);
  assert.deepEqual(states[0], ['running', null]);
  assert.ok(states.some(([, waiting]) => waiting === 'behind another session'));
  assert.deepEqual(states.at(-1), ['done', null]);
  // the stream never carries the result — whoever started the job GETs it
  assert.ok(events.seen.every(([type, j]) => type !== 'job' || !('result' in j)));
  assert.deepEqual(jobs.get(job.id).result, { big: 'result' });
  assert.equal(jobs.active({ type: 'demo' }).length, 0);

  jobs.remove(job.id);
  assert.deepEqual(events.seen.at(-1), ['job-removed', { id: job.id }]);
  assert.throws(() => jobs.get(job.id), /no such job/);
});

test('jobs: a failed job with a retry starts again and the failure goes', async () => {
  const jobs = new JobRegistry();
  let attempts = 0;
  const run = () => jobs.start('flaky', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('locked');
    return 'ok';
  }, { retry: async () => run().id });
  const plain = jobs.start('no retry', async () => { throw new Error('nope'); });
  const first = run();
  await tick(20);
  assert.equal(first.retryable, true);
  assert.equal(plain.retryable, false);
  await assert.rejects(() => jobs.retry(plain.id), /cannot be retried/);

  const again = await jobs.retry(first.id);
  assert.throws(() => jobs.get(first.id), /no such job/);
  await tick(20);
  assert.equal(jobs.get(again).status, 'done');
});

test('events: a new client gets the job snapshot, then live events', async () => {
  const events = new EventHub();
  const jobs = new JobRegistry({ events });
  jobs.start('earlier', async () => 'ok');
  await tick();
  const app = express();
  app.use('/api/events', eventRoutes(events, jobs));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/events`);
    const reader = res.body.getReader();
    let text = '';
    const read = async (until) => {
      while (!until.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await read(/event: jobs\ndata: .*"earlier"/);
    events.publish('tree', { project: 'A' });
    await read(/event: tree\ndata: {"project":"A"}/);
    await reader.cancel();
  } finally {
    events.closeAll();
    server.close();
  }
});

test('projects: a change in a project folder publishes one tree event', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-watch-'));
  const events = recorder();
  const projects = new ProjectsService({ dataDir, catalog: null, jobs: new JobRegistry(), events });
  try {
    await projects.init();
    await projects.create('Bench');
    const { files } = await projects.bundle('Bench');
    events.seen.length = 0;
    // a burst of writes, from outside the app, settles into one event
    for (let i = 0; i < 5; i += 1) await writeFile(path.join(files.root, `note-${i}.txt`), 'x');
    await tick(600);
    assert.deepEqual(events.seen, [['tree', { project: 'Bench' }]]);
    await projects.remove('Bench');
    assert.equal(projects.watchers.size, 0);
  } finally {
    projects.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('catalog: reads once, shares a read in flight, keeps the list on failure', async () => {
  let calls = 0;
  let fail = false;
  const catalog = new RtacCatalog({
    client: {
      listProjects: async () => {
        calls += 1;
        await tick(20);
        if (fail) throw new Error('database locked');
        return ['A', 'B'];
      },
    },
  });
  const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
  assert.deepEqual(a, { projects: ['A', 'B'], error: null });
  assert.deepEqual(b, a);
  await catalog.list();
  assert.equal(calls, 1);
  fail = true;
  await catalog.refresh();
  assert.deepEqual(await catalog.list(), { projects: ['A', 'B'], error: 'database locked' });
});
