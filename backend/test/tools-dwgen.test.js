// DWGEN: model detection, generation against the real drawing corpus
// (the SEL-751A fixture Volture's image tests use), and the AutoCAD bundle.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SEL_DEVICES_DIR } from '../lib/drawings/deviceMetadata.js';
import { DwgenService, detectModel, layerFragment } from '../services/tools/dwgen.js';
import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const PART_NUMBER = '751A51ABA0X71850230';
const corpusReady = existsSync(path.join(SEL_DEVICES_DIR, '751A', 'metadata.json'));

test('dwgen: layer fragments prefer the option prefix', () => {
  assert.equal(layerFragment('3.10__K__(2) 100Base FX MM LC.'), '3.10__K__');
  assert.equal(layerFragment('5.00_DWG'), '5.00_DWG');
});

test('dwgen: model detection and full generation', { skip: !corpusReady }, async () => {
  assert.equal(await detectModel(PART_NUMBER, SEL_DEVICES_DIR), '751A');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dwgen-'));
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const service = new DwgenService({ workspace, jobs: new JobRegistry() });

    await assert.rejects(() => service.generate({ partNumber: '' }), /part number required/);
    await assert.rejects(
      () => service.generate({ partNumber: 'ZZZZ99' }),
      /could not identify the model/,
    );

    const result = await service.generate({ partNumber: PART_NUMBER });
    assert.equal(result.model, '751A');
    assert.ok(result.decoded.positions.length > 0);
    assert.ok(result.decoded.positions.some((p) => p.matched));
    assert.ok(result.layers.length > 0);

    // A configured PDF and a per-drawing AutoCAD bundle land in the run. The
    // 751A master drawing (i7008.E) has a local .dwg, so it is bundled as the
    // source — the DWG pass is ready offline, no fetch.
    const paths = result.reports.map((r) => r.path);
    assert.ok(paths.some((p) => p.endsWith('.pdf')));
    assert.ok(paths.includes('autocad/i7008.E.lsp'));
    assert.ok(paths.includes('autocad/i7008.E.scr'));
    assert.ok(paths.includes('autocad/i7008.E.dwg'), 'local DWG source is bundled');
    const lsp = (await workspace.readFile('dwgen', result.run, 'autocad/i7008.E.lsp')).toString();
    assert.ok(lsp.includes('enabledFragments'));
    const scr = (await workspace.readFile('dwgen', result.run, 'autocad/i7008.E.scr')).toString();
    assert.ok(scr.includes('OPEN "i7008.E.dwg"') && scr.includes('i7008.E.configured.dwg'));
    // The bundled DWG is the real corpus file (AutoCAD magic).
    const dwg = await workspace.readFile('dwgen', result.run, 'autocad/i7008.E.dwg');
    assert.ok(dwg.toString('latin1', 0, 2) === 'AC');

    // The filtered PDF really carries the layer switch (BaseState OFF).
    const pdf = await workspace.readFile('dwgen', result.run, paths.find((p) => p.endsWith('.pdf')));
    assert.ok(pdf.length > 10000);
    assert.ok(pdf.toString('latin1').includes('/BaseState /OFF'));

    assert.deepEqual(result.previews, ['preview/front.png', 'preview/rear.png']);
    await workspace.filePath('dwgen', result.run, 'preview/front.png');

    // The bundled drawing is offered for the on-demand DWG pass.
    assert.deepEqual(result.dwgs, [{ stem: 'i7008.E', pdf: 'i7008.E.pdf' }]);
    assert.equal(typeof result.autocad, 'boolean');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('dwgen: openDwg runs the layer pass via AutoCAD', { skip: !corpusReady || process.platform === 'win32' }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dwgen-acad-'));
  // A stand-in acad.exe: derives the stem from the .scr argument and writes
  // <stem>.configured.dwg into the cwd, exactly what the SAVEAS would do.
  const fakeAcad = path.join(tmp, 'acad');
  await writeFile(fakeAcad, '#!/bin/sh\nstem="${3%.open.scr}"\ncp "$stem.dwg" "$stem.configured.dwg"\n', { mode: 0o755 });
  process.env.PROJECTOR_AUTOCAD = fakeAcad;
  try {
    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const service = new DwgenService({ workspace, jobs: new JobRegistry() });
    const result = await service.generate({ partNumber: PART_NUMBER });
    assert.equal(result.autocad, true);

    await assert.rejects(() => service.openDwg({ run: result.run, stem: '../evil' }), /invalid drawing stem/);
    await assert.rejects(() => service.openDwg({ run: result.run, stem: 'i9999' }), /no such file/);

    // Generate writes both script shapes; the .open.scr saves the configured
    // copy but leaves AutoCAD open (no QUIT).
    const scr = (await workspace.readFile('dwgen', result.run, 'autocad/i7008.E.open.scr')).toString();
    assert.ok(scr.includes('i7008.E.configured.dwg') && !scr.includes('QUIT'));

    const opened = await service.openDwg({ run: result.run, stem: 'i7008.E' });
    assert.equal(opened.ok, true);
    assert.equal(opened.configured, 'autocad/i7008.E.configured.dwg');
    // The launch is fire-and-forget; poll briefly for the fake pass's output.
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await workspace.filePath('dwgen', result.run, 'autocad/i7008.E.configured.dwg');
        break;
      } catch {
        assert.ok(Date.now() < deadline, 'configured DWG never appeared');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const dwg = await workspace.readFile('dwgen', result.run, 'autocad/i7008.E.configured.dwg');
    assert.ok(dwg.toString('latin1', 0, 2) === 'AC');
  } finally {
    delete process.env.PROJECTOR_AUTOCAD;
    await rm(tmp, { recursive: true, force: true });
  }
});
