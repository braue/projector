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
import { AcrtacImportService } from '../services/tools/acrtacImport.js';
import { DacsimService } from '../services/tools/dacsim.js';
import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

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
        schemeName: 'Feeder 9',
        dacPath: 'Feeder 9.rtac',
        dacIps: ['192.168.199.21'],
        remoteIp: '192.168.254.21',
      }],
    };

    // Guards: no schemes, missing IPs, a pick that is not a directory.
    await assert.rejects(() => dacsim.stageFromProject(files, { schemes: [] }), /at least one scheme/);
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
      schemeName: 'Feeder 9',
      dacFolder: 'DAC Feeder 9',
      remoteFolder: 'Feeder 9_REMOTE',
      logicFolder: 'SIM Master',
    }]);
    const staged = await workspace.listFiles('dacsim', bundle.run);
    assert.deepEqual(staged.map((file) => file.path), [
      'DAC Feeder 9/SEL_RTAC/DAC/DeviceDeclarations.xml',
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

    const importer = new AcrtacImportService({ jobs: new JobRegistry() });
    const base = { path: 'Feeder 9.rtac', name: 'Feeder 9', deviceType: '3555', firmware: 'R151' };

    await assert.rejects(() => importer.start(files, { ...base, name: ' ' }), /name is required/);
    await assert.rejects(() => importer.start(files, { ...base, deviceType: '' }), /device type is required/);
    await assert.rejects(() => importer.start(files, { ...base, firmware: '' }), /firmware is required/);
    await assert.rejects(() => importer.start(files, { ...base, path: 'nope.rtac' }), /no such entry/);
    await assert.rejects(
      () => importer.start(files, { ...base, path: 'notes.txt' }),
      /not an RTAC export folder/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
