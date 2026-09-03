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
      await mkdir(path.join(target, 'SEL_RTAC'), { recursive: true });
      await writeFile(path.join(target, 'SEL_RTAC', 'Devices.xml'), '<Devices/>');
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

    // Convert refuses an unknown run before spawning anything.
    await assert.rejects(() => dacsim.startConvert('nope'), /no such run/);

    // The good case: DAC bytes copied under the generated subFolder, and the
    // written settings.json round-trips through the same validator the ZIP
    // path uses.
    const bundle = await dacsim.stageFromProject(files, base);
    assert.deepEqual(bundle.schemes, [{
      schemeName: 'Feeder 9',
      dacFolder: 'DAC Feeder 9',
      remoteFolder: 'SIM Feeder 9',
      logicFolder: 'SIM Master',
    }]);
    const staged = await workspace.listFiles('dacsim', bundle.run);
    assert.deepEqual(staged.map((file) => file.path), [
      'DAC Feeder 9/SEL_RTAC/Devices.xml',
      'settings.json',
    ]);
    const settings = JSON.parse(
      (await workspace.readFile('dacsim', bundle.run, 'settings.json')).toString(),
    );
    assert.equal(settings[0].subSimId, 'Sim1');
    assert.deepEqual(settings[0].dac.ipAddr, ['192.168.199.21']);
    assert.equal(settings[0].parameters.defaultLoad, 10);
    assert.equal(settings[0].dacPath, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
