// DAC SIM Converter: staging and validation before any bridge spawn. The
// conversion itself needs a real DAC export (and its Python runtime), so
// these cover everything up to the spawn: scheme validation, copying the
// picked exports, and the generated settings.json.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';
import { AcrtacService } from '../services/tools/acrtac.js';
import { DacsimService } from '../services/tools/dacsim.js';
import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';
import { rtacAnnotate } from './helpers/bundle.js';

test('dacsim: from-project staging copies picked DAC exports and writes settings.json', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacsim-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: path.join(tmp, 'tools-home') });
    await workspace.init();
    const dacsim = new DacsimService({ workspace, jobs: new JobRegistry() });

    // A project files store holding one DAC export (an .rtac directory
    // entry) and one plain file.
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.placeEntry('', 'Feeder 9.rtac', 'from AcRTAC', async (target) => {
      await mkdir(path.join(target, 'SEL_RTAC', 'DAC'), { recursive: true });
      await writeFile(path.join(target, 'SEL_RTAC', 'DAC', 'DeviceDeclarations.xml'), '<GVL/>');
    }, { directory: true });
    // An export NOT organized per the converter's DAC convention.
    await files.placeEntry('', 'loose.rtac', 'from AcRTAC', async (target) => {
      await mkdir(path.join(target, 'SEL_RTAC', 'User_Logic'), { recursive: true });
      await writeFile(path.join(target, 'SEL_RTAC', 'User_Logic', 'DeviceDeclarations.xml'), '<GVL/>');
    }, { directory: true });
    await files.upload('', [{ originalname: 'notes.txt', buffer: Buffer.from('x') }], 'n');

    const base = {
      masterIp: '192.168.254.11',
      schemes: [{
        schemeName: 'Feeder_9',
        dacPath: 'Feeder 9.rtac',
        dacIps: ['192.168.199.21'],
        remoteIp: '192.168.254.21',
      }],
    };

    // Guards: no schemes, an identifier-unsafe name, missing IPs, a pick
    // that is not a directory.
    await assert.rejects(() => dacsim.stageFromProject(files, { schemes: [] }), /at least one scheme/);
    // The scheme name lands in the master's declarations as an RTAC
    // variable name — spaces and dots crash the converter mid-build.
    await assert.rejects(
      () => dacsim.stageFromProject(files, {
        ...base,
        schemes: [{ ...base.schemes[0], schemeName: 'Covington North 13.2kv' }],
      }),
      /becomes an RTAC variable/,
    );
    await assert.rejects(
      () => dacsim.stageFromProject(files, { ...base, masterIp: '' }),
      /master IP is required/,
    );
    await assert.rejects(
      () => dacsim.stageFromProject(files, {
        ...base,
        schemes: [{ ...base.schemes[0], dacIps: [] }],
      }),
      /DAC IP is required/,
    );
    await assert.rejects(
      () => dacsim.stageFromProject(files, {
        ...base,
        schemes: [{ ...base.schemes[0], dacPath: 'notes.txt' }],
      }),
      /not a DAC export folder/,
    );
    // The converter's folder convention is checked up front, not mid-job.
    await assert.rejects(
      () => dacsim.stageFromProject(files, {
        ...base,
        schemes: [{ ...base.schemes[0], dacPath: 'loose.rtac' }],
      }),
      /not organized for the converter/,
    );

    // The good case: DAC bytes copied under the generated subFolder, and the
    // written settings.json round-trips through the same validator the ZIP
    // path uses.
    const bundle = await dacsim.stageFromProject(files, base);
    assert.deepEqual(bundle.schemes, [{
      schemeName: 'Feeder_9',
      dacFolder: 'DAC Feeder_9',
      remoteFolder: 'Feeder_9_REMOTE',
      logicFolder: 'SIM Master',
    }]);
    const staged = await workspace.listFiles('dacsim', bundle.run);
    assert.deepEqual(staged.map((file) => file.path), [
      'DAC Feeder_9/SEL_RTAC/DAC/DeviceDeclarations.xml',
      'settings.json',
    ]);
    const settings = JSON.parse(
      (await workspace.readFile('dacsim', bundle.run, 'settings.json')).toString(),
    );
    assert.equal(settings[0].subSimId, 'Sim1');
    assert.deepEqual(settings[0].dac.ipAddr, ['192.168.199.21']);
    assert.equal(settings[0].parameters.defaultLoad, 1);
    assert.equal(settings[0].dacPath, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('dacsim: save lands a run\'s simulator projects as versioned entries', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacsim-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: path.join(tmp, 'tools-home') });
    await workspace.init();
    const dacsim = new DacsimService({ workspace, jobs: new JobRegistry() });
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    // A finished run: settings.json plus the converter's outputs — and the
    // staged DAC input, which must NOT be saved.
    const { runId, dir } = await workspace.createRun('dacsim');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify([{
      schemeName: 'Feeder_9',
      dac: { subFolder: 'DAC Feeder_9' },
      remote: { subFolder: 'Feeder_9_REMOTE' },
      logic: { subFolder: 'SIM Master' },
    }]));
    for (const name of ['Feeder_9_REMOTE', 'SIM Master', 'DAC Feeder_9']) {
      await mkdir(path.join(dir, name, 'SEL_RTAC'), { recursive: true });
      await writeFile(path.join(dir, name, 'SEL_RTAC', 'Devices.xml'), '<GVL/>');
    }

    const { placed } = await dacsim.save(files, runId);
    assert.deepEqual(placed, [
      'DAC SIM Converter/Feeder_9_REMOTE.rtac',
      'DAC SIM Converter/SIM Master.rtac',
    ]);
    const folder = (await files.tree(rtacAnnotate))
      .find((node) => node.name === 'DAC SIM Converter');
    assert.deepEqual(folder.children.map((node) => node.name),
      ['Feeder_9_REMOTE.rtac', 'SIM Master.rtac']);

    // Saving the same run again stacks versions rather than erroring.
    await dacsim.save(files, runId);
    const again = (await files.tree(rtacAnnotate))
      .find((node) => node.name === 'DAC SIM Converter');
    assert.equal(again.children[0].versions.length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('acrtac import: request validation before any bridge spawn', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-acrtacimp-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.placeEntry('', 'Feeder 9.rtac', 'from AcRTAC', async (target) => {
      await mkdir(path.join(target, 'SEL_RTAC'), { recursive: true });
      await writeFile(path.join(target, 'SEL_RTAC', 'Devices.xml'), '<GVL/>');
    }, { directory: true });
    await files.upload('', [{ originalname: 'notes.txt', buffer: Buffer.from('x') }], 'n');

    const acrtac = new AcrtacService({ jobs: new JobRegistry() });
    const base = { path: 'Feeder 9.rtac', name: 'Feeder 9', deviceType: '3555', firmware: 'R151' };

    await assert.rejects(() => acrtac.import(files, { ...base, name: ' ' }), /name is required/);
    await assert.rejects(() => acrtac.import(files, { ...base, deviceType: '' }), /device type is required/);
    await assert.rejects(() => acrtac.import(files, { ...base, firmware: '' }), /firmware is required/);
    await assert.rejects(() => acrtac.import(files, { ...base, path: 'nope.rtac' }), /no such entry/);
    await assert.rejects(
      () => acrtac.import(files, { ...base, path: 'notes.txt' }),
      /not an RTAC export folder/,
    );
    // Open in AcRTAC validates before spawning anything, too.
    assert.throws(() => acrtac.open({ name: '  ' }), /name is required/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('acrtac import: an archived version imports by its .versions/ path', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-acrtacimp-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    const pull = (note) => files.placeEntry('', 'Feeder 9.rtac', note, async (target) => {
      await mkdir(path.join(target, 'SEL_RTAC'), { recursive: true });
      await writeFile(path.join(target, 'SEL_RTAC', 'Devices.xml'), '<GVL/>');
    }, { directory: true });
    await pull('first pull');
    await pull('repull');

    const entry = (await files.tree(rtacAnnotate)).find((node) => node.name === 'Feeder 9.rtac');
    const acrtac = new AcrtacService({ jobs: new JobRegistry() });
    const archived = await acrtac.import(files, {
      path: entry.versions[0].path,
      name: 'Feeder 9',
      deviceType: '3555',
      firmware: 'R151',
    });
    assert.ok(archived.job);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
