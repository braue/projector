// QuickSet parsers and service: inventory + extraction over a synthetic
// configs tree, and the ZIP-upload source path.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { zipSync, strToU8 } from 'fflate';

import { JobRegistry } from '../services/tools/jobs.js';
import { QuicksetService } from '../services/tools/quickset/index.js';
import {
  collectDeviceInfo,
  collectSettings,
  extractCfgInfo,
  parseSettingLine,
  pivotSettings,
} from '../services/tools/quickset/parsers.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const CFG = 'RELAYTYPE,"SEL-351S"\nFID,"SEL-351S-R510-V0-Z002001-D20010129"\nP1,"Protection Group 1"\n';
const SET_P1 = 'OUT101,"52A"\nOUT102,"TRIP"\n; comment\nNOISE\n';
const SET_G = 'OUT101,"ALARM"\n';

async function makeTree(base) {
  const device = path.join(base, 'North_Sub', 'FDR-1');
  await mkdir(path.join(device, 'Misc'), { recursive: true });
  await writeFile(path.join(device, 'Misc', 'Cfg.txt'), CFG);
  await writeFile(path.join(device, 'set_P1.txt'), SET_P1);
  await writeFile(path.join(device, 'set_G.txt'), SET_G);
  // A Misc .txt must not be scanned as a settings group.
  await writeFile(path.join(device, 'Misc', 'notes.txt'), 'OUT101,"SHOULD NOT APPEAR"\n');
}

test('quickset parsers: line forms, cfg info, inventory, extraction, pivot', async () => {
  assert.deepEqual(parseSettingLine('OUT101,"52A"'), ['OUT101', '52A']);
  assert.deepEqual(parseSettingLine('OUT101=52A'), ['OUT101', '52A']);
  assert.equal(parseSettingLine('# comment'), null);
  assert.equal(parseSettingLine('no delimiter'), null);

  const info = extractCfgInfo(CFG);
  assert.deepEqual(info, { relayType: 'SEL-351S', firmware: 'R510' });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-qs-'));
  try {
    await makeTree(tmp);
    const inventory = await collectDeviceInfo(tmp);
    assert.deepEqual(inventory, [
      { location: 'North_Sub', device: 'FDR-1', relayType: 'SEL-351S', firmware: 'R510' },
    ]);

    const { rows, filesChecked } = await collectSettings(tmp, ['OUT101', 'OUT102']);
    assert.equal(filesChecked, 2); // Misc/notes.txt excluded
    assert.equal(rows.length, 3);
    const p1 = rows.find((r) => r.file === 'set_P1.txt' && r.setting === 'OUT101');
    assert.equal(p1.value, '52A');
    assert.equal(p1.group, 'Protection Group 1');
    // Unmapped group code falls back to the code itself.
    assert.equal(rows.find((r) => r.file === 'set_G.txt').group, 'G');

    const pivot = pivotSettings(rows, ['OUT101', 'OUT102']);
    assert.deepEqual(pivot.columns.slice(-2), ['OUT101', 'OUT102']);
    assert.equal(pivot.rows.length, 2); // one row per file
    const pivotP1 = pivot.rows.find((r) => r.file === 'set_P1.txt');
    assert.equal(pivotP1.OUT101, '52A');
    assert.equal(pivotP1.OUT102, 'TRIP');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('quickset service: ZIP upload source, inventory and extract endpoints', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-qs-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const service = new QuicksetService({ workspace, jobs: new JobRegistry() });

    // A ZIP wrapping the tree in one top folder — the wrapper is stripped.
    const zip = zipSync({
      'exported_configs/North_Sub/FDR-1/Misc/Cfg.txt': strToU8(CFG),
      'exported_configs/North_Sub/FDR-1/set_P1.txt': strToU8(SET_P1),
    });
    const { run } = await service.uploadConfigs({ originalname: 'configs.zip', buffer: Buffer.from(zip) });

    const inventory = await service.inventory(run);
    assert.equal(inventory.rows.length, 1);
    assert.equal(inventory.rows[0].relayType, 'SEL-351S');
    assert.equal(inventory.reports[0].path, 'relay inventory.csv');

    const extract = await service.extract(run, ['OUT101']);
    assert.equal(extract.hits, 1);
    assert.equal(extract.rows[0].OUT101, '52A');

    // Reports are downloadable through the workspace like any run file.
    const csv = (await workspace.readFile('quickset', run, 'settings extract.csv')).toString();
    assert.ok(csv.includes('OUT101'));

    await assert.rejects(() => service.extract(run, []), /no setting names/);
    await assert.rejects(
      () => service.uploadConfigs({ originalname: 'x.zip', buffer: Buffer.from('junk') }),
      /not a readable ZIP/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
