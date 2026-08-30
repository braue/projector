// Tools shell: run workspaces (creation, listing, path guards, removal) and
// the job registry every slow tool operation runs through.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const settled = (job) =>
  new Promise((resolve) => {
    const tick = () => (job.status === 'running' ? setTimeout(tick, 5) : resolve(job));
    tick();
  });

test('tools workspace: run lifecycle and path guards', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-tools-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();

    const { runId, dir } = await workspace.createRun('hmi');
    await writeFile(path.join(dir, 'report.csv'), 'a,b\n1,2\n');

    const files = await workspace.listFiles('hmi', runId);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'report.csv');
    assert.equal(files[0].size, 8);

    const absolute = await workspace.filePath('hmi', runId, 'report.csv');
    assert.equal((await workspace.readFile('hmi', runId, 'report.csv')).toString(), 'a,b\n1,2\n');
    assert.ok(absolute.startsWith(dir));

    // Guards: escapes and misses are refused with coded errors.
    await assert.rejects(() => workspace.runDir('hmi', 'nope'), /no such run/);
    await assert.rejects(() => workspace.runDir('../hmi', runId), /invalid tool id/);
    await assert.rejects(() => workspace.runDir('hmi', `../${runId}`), /invalid run id/);
    await assert.rejects(() => workspace.filePath('hmi', runId, '../../secret'), /invalid file path/);
    await assert.rejects(() => workspace.filePath('hmi', runId, 'missing.txt'), /no such file/);

    await workspace.removeRun('hmi', runId);
    await assert.rejects(() => workspace.listFiles('hmi', runId), /no such run/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('tools jobs: completion, failure, log and progress', async () => {
  const jobs = new JobRegistry();

  const ok = jobs.start('demo', async ({ log, progress }) => {
    log('starting');
    progress(0.5);
    log('halfway');
    return { count: 2 };
  });
  assert.equal(ok.status, 'running');
  await settled(ok);
  assert.equal(ok.status, 'done');
  assert.deepEqual(ok.result, { count: 2 });
  assert.deepEqual(ok.log, ['starting', 'halfway']);
  assert.equal(ok.progress, 0.5);
  assert.equal(jobs.get(ok.id), ok);

  const bad = jobs.start('boom', async () => {
    throw new Error('relay unreachable');
  });
  await settled(bad);
  assert.equal(bad.status, 'error');
  assert.equal(bad.error, 'relay unreachable');

  assert.throws(() => jobs.get('job-999'), /no such job/);
});

// --- HMI Tag Tester ----------------------------------------------------------

test('hmi: bad tags, duplicates, and the imported-list marker', async () => {
  const { analyzeHprj } = await import('../services/tools/hmiTester.js');

  // A .hprj is one giant line of elements; build it the same way. The
  // Description= BEFORE the TagAdapterDictionary marker must not count as
  // imported (the flag takes effect on the following line), and (Unassigned)
  // PointIDs are skipped entirely.
  const text = [
    '<Diagram DiagramTitle="Overview" ',
    '<Element PointID="BKR_52A" ',
    '<Element PointID="BKR_52A" ',            // same screen duplicate
    '<Element PointID="(Unassigned)" ',
    '<Element PointID="XFMR_TEMP" ',
    '<Diagram DiagramTitle="Feeder 1" ',
    '<Element PointID="BKR_52A" ',            // cross-screen use (3rd)
    '<Element PointID="GHOST_TAG" ',          // never imported
    '<Item Description="early noise" ',       // before the marker: not imported
    '<TagAdapterDictionary Name="Analog Inputs" ',
    '<Item Description="BKR_52A" ',
    '<Item Description="xfmr_temp" ',         // case-insensitive match
    '<Other NotATag="x" ',
  ].join('>') + '>';

  const report = analyzeHprj(text);
  assert.equal(report.totalTags, 5);
  assert.equal(report.importedCount, 2);
  assert.deepEqual(report.badTags, [{ tag: 'GHOST_TAG', diagram: 'Feeder 1' }]);
  assert.deepEqual(report.duplicateTags, [{ tag: 'BKR_52A', count: 3, sameScreen: true }]);
  // Used tags carry the diagram they sit on.
  assert.deepEqual(report.usedTags[3], { tag: 'BKR_52A', diagram: 'Feeder 1' });
});

test('tool settings: merge, remove, and empty default', async () => {
  const { ToolSettings } = await import('../services/tools/settings.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-tools-'));
  try {
    const settings = new ToolSettings({ dataDir: tmp });
    assert.deepEqual(await settings.get(), {});
    await settings.update({ exportFolder: 'C:\\Exports', keep: 1 });
    assert.deepEqual(await settings.get(), { exportFolder: 'C:\\Exports', keep: 1 });
    assert.deepEqual(await settings.update({ exportFolder: null }), { keep: 1 });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- RTAC Exporter -----------------------------------------------------------

test('rtac export: request validation before any bridge spawn', async () => {
  const { RtacExportService } = await import('../services/tools/rtacExport.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-tools-'));
  try {
    const { ToolsWorkspace } = await import('../services/tools/workspace.js');
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const service = new RtacExportService({ workspace, jobs: new JobRegistry() });
    await assert.rejects(() => service.startExport({ projects: [] }), /at least one project/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- project-file inputs ------------------------------------------------------

test('files service: read guards match the store rules', async () => {
  const { FilesService } = await import('../services/files.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-tools-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.upload('', [{ originalname: 'switch.xml', buffer: Buffer.from('<x/>') }]);
    assert.equal((await files.read('switch.xml')).toString(), '<x/>');
    await assert.rejects(() => files.read('missing.xml'), /no such file/);
    await assert.rejects(() => files.read('../outside'), /invalid file path/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
