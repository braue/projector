// DAC SIM Converter: bundle staging and validation before any bridge spawn.
// The conversion itself needs a real DAC export (and its Python runtime), so
// these cover everything up to the spawn: ZIP handling, settings.json
// validation, run staging, and the starter template.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { zipSync } from 'fflate';

import { DacsimService } from '../services/tools/dacsim.js';
import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const SCHEME = {
  schemeName: 'DAC1',
  subSimId: 'Sim1',
  dac: { subFolder: 'DAC 1', ipAddr: ['192.168.199.21'] },
  remote: { subFolder: 'SIM 1', ipAddr: '192.168.254.21' },
  logic: { subFolder: 'SIM Master', ipAddr: '192.168.254.11' },
  nameConversions: [],
  parameters: { defaultLoad: 10 },
};

const zipOf = (entries) => ({
  buffer: Buffer.from(zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, text]) => [name, new TextEncoder().encode(text)]),
  ))),
});

test('dacsim: bundle staging validates before any bridge spawn', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacsim-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const dacsim = new DacsimService({ workspace, jobs: new JobRegistry() });

    // Guards: junk, empty, missing or malformed settings.json.
    await assert.rejects(() => dacsim.uploadBundle({ buffer: Buffer.from('junk') }), /not a readable ZIP/);
    await assert.rejects(() => dacsim.uploadBundle(zipOf({ 'DAC 1/a.xml': '<x/>' })), /settings\.json/);
    await assert.rejects(
      () => dacsim.uploadBundle(zipOf({ 'settings.json': '{broken' })),
      /not valid JSON/,
    );
    await assert.rejects(
      () => dacsim.uploadBundle(zipOf({ 'settings.json': '[]' })),
      /non-empty list/,
    );
    await assert.rejects(
      () => dacsim.uploadBundle(zipOf({ 'settings.json': JSON.stringify([{ schemeName: 'X' }]) })),
      /scheme 1 needs/,
    );

    // A good bundle stages into a run, wrapping top folder stripped.
    const bundle = await dacsim.uploadBundle(zipOf({
      'export/settings.json': JSON.stringify([SCHEME]),
      'export/DAC 1/SEL_RTAC/Devices.xml': '<Devices/>',
    }));
    assert.deepEqual(bundle.schemes, [{
      schemeName: 'DAC1',
      dacFolder: 'DAC 1',
      remoteFolder: 'SIM 1',
      logicFolder: 'SIM Master',
    }]);
    const staged = await workspace.listFiles('dacsim', bundle.run);
    assert.deepEqual(staged.map((file) => file.path), ['DAC 1/SEL_RTAC/Devices.xml', 'settings.json']);

    // Convert refuses an unknown run before spawning anything.
    await assert.rejects(() => dacsim.startConvert('nope'), /no such run/);

    // The starter template is real settings JSON the validator accepts.
    const template = JSON.parse(await dacsim.settingsTemplate());
    assert.ok(Array.isArray(template) && template.length >= 1);
    assert.ok(template[0].schemeName && template[0].dac?.subFolder);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
