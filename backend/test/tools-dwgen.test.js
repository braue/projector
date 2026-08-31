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

// A genuine SEL-487E-4 unit (Station Phasor Measurement Unit) that used to
// decode with five unrecognized positions and pick the WRONG firmware layer:
// the 487E metadata's positions and layer sources were rebuilt against the
// SEL configurator's authoritative decode of this exact part number.
test('dwgen: a real 487E-4 MOT decodes fully and selects the PMU layers', { skip: !corpusReady }, async () => {
  const { decodeWithMetadata } = await import('../lib/drawings/decodePartNumber.js');
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveDrawings, resolveEnabledLayers } = await import('../lib/drawings/createImages.js');

  const pn = '0487E4X611XXC5X43624XXX';
  assert.equal(await detectModel(pn, SEL_DEVICES_DIR), '487E');
  const metadata = await loadDeviceMetadata('487E');

  const decoded = decodeWithMetadata(metadata, pn);
  assert.deepEqual(decoded.positions.filter((p) => !p.matched), []);
  const byPosition = new Map(decoded.positions.map((p) => [p.position, p]));
  assert.match(byPosition.get(6).description, /Station Phasor Measurement Unit/);
  assert.match(byPosition.get(18).description, /6U/);

  // Chassis digit 6 selects the one-slot drawing, and the layer walk lands on
  // the PMU firmware layer (positions 6+11), not a hardcoded Standard.
  assert.deepEqual(resolveDrawings(metadata, '487E', pn), { front: 'i7081.K.pdf', rear: 'i7081.K.pdf' });
  const names = [...resolveEnabledLayers(metadata, 'i7081.K.pdf', pn).names];
  assert.ok(names.some((n) => n.includes('4-X__Station Phasor Measurement Unit')));
  assert.ok(names.some((n) => n.startsWith('2.1__X__')), 'connector layer resolves from position 7');
  assert.ok(names.some((n) => n.startsWith('3.4__5__')), 'ethernet layer resolves from position 14');

  // A genuine legacy (firmware 0) unit: same 23-character length, different
  // field layout — position 6 alone is the firmware and 11 is the secondary
  // voltage. Decoded by the when-conditioned legacy submodel table, and the
  // firmware layer group resolves to "no label layer" without a warning.
  const legacyPn = '0487E0X41111XXB4H74444X';
  const legacy = decodeWithMetadata(metadata, legacyPn);
  assert.match(legacy.submodel, /Legacy/);
  assert.deepEqual(legacy.positions.filter((p) => !p.matched), []);
  const legacyByPosition = new Map(legacy.positions.map((p) => [p.position, p]));
  assert.match(legacyByPosition.get(6).description, /Volts-Per-Hertz/);
  assert.match(legacyByPosition.get(12).description, /Mirrored Bits/);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    resolveEnabledLayers(metadata, 'i7082.K.pdf', legacyPn);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
});

// The fleet's most common SEL-651R (799 sightings in the QuickSet dumps).
// Its communications interface 'A' and installed-accessories 'DC' codes were
// absent from the decode table until the metadata audit re-grounded them
// against the SEL configurator's decode of this exact part number; 'A' also
// has no layer in the drawing's GROUP_3 catalog (the built-in port draws
// nothing), which used to surface as a spurious unresolved-group warning.
test('dwgen: the most common fleet 651R MOT decodes fully with no layer warnings', { skip: !corpusReady }, async () => {
  const { decodeWithMetadata } = await import('../lib/drawings/decodePartNumber.js');
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveDrawings, resolveEnabledLayers } = await import('../lib/drawings/createImages.js');

  const pn = '0651R221XGAXAA1113DCXX';
  assert.equal(await detectModel(pn, SEL_DEVICES_DIR), '651R');
  const metadata = await loadDeviceMetadata('651R');

  const decoded = decodeWithMetadata(metadata, pn);
  assert.deepEqual(decoded.positions.filter((p) => !p.matched), []);
  const byPosition = new Map(decoded.positions.map((p) => [p.position, p]));
  assert.equal(byPosition.get(14).description, '(1) 10/100BASE-T');
  assert.match(byPosition.get(19).description, /Accessory Shelf and AC Transfer Switch/);

  assert.deepEqual(resolveDrawings(metadata, '651R', pn), { front: 'i7171.e.pdf', rear: 'i7171.e.pdf' });

  // Comms 'A' resolves to an empty layer list — silently, not as a warning.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let names;
  try {
    names = [...resolveEnabledLayers(metadata, 'i7171.e.pdf', pn).names];
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.ok(names.some((n) => n.startsWith('1.2__2__')), 'control-cable layer resolves from position 7');
  assert.ok(names.some((n) => n.startsWith('4.1__1__')), 'battery/power layer resolves from position 16');
  assert.ok(!names.some((n) => /^3\.[1-9]__/.test(n)), 'no comms-module layer is drawn for the built-in port');
});

// The SEL-421 takes two ordering formats: 21 characters (421-4/-5) and 25
// (421-7), with the same field at different positions. One flat decode table
// used to misread every 21-character MOT (Mounting read as Ethernet), and the
// old drawings' connector group read the power-supply digit — a 24-48 Vdc
// unit got the Connectorized Relay layer. Both rebuilt against the
// configurator via part_number.submodels in the metadata audit.
test('dwgen: 421 decodes each submodel length with its own table', { skip: !corpusReady }, async () => {
  const { decodeWithMetadata } = await import('../lib/drawings/decodePartNumber.js');
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveDrawings, resolveEnabledLayers } = await import('../lib/drawings/createImages.js');
  const metadata = await loadDeviceMetadata('421');

  // 21-character 421-4: the submodel table applies.
  const pn21 = '04214211XXXX1H20XXXXX';
  const short = decodeWithMetadata(metadata, pn21);
  assert.match(short.submodel, /21-character/);
  const shortByPosition = new Map(short.positions.map((p) => [p.position, p]));
  assert.equal(shortByPosition.get(14).description, 'Horizontal Rack Mount');
  assert.match(shortByPosition.get(15).description, /4U/);

  assert.deepEqual(resolveDrawings(metadata, '421', pn21), { front: 'i7001d.pdf', rear: 'i7001d.pdf' });
  const names = [...resolveEnabledLayers(metadata, 'i7001d.pdf', pn21).names];
  assert.ok(names.some((n) => n.includes('Screw Terminal Block')), 'connector layer comes from position 7');
  assert.ok(!names.some((n) => n.includes('Connectorized')), 'power-supply 2 at position 6 no longer selects Connectorized');
  assert.ok(names.some((n) => n.includes('Empty IO Board Position')), 'empty board B resolves from position 16');

  // 25-character 421-7: the top-level table still applies unchanged.
  const long = decodeWithMetadata(metadata, '0421711X3200XD6H621240XXX');
  assert.equal(long.submodel, null);
  const longByPosition = new Map(long.positions.map((p) => [p.position, p]));
  assert.equal(longByPosition.get(16).description, 'Horizontal Rack Mount');
});

// The 2730M managed switch had no drawing metadata at all until its master
// configuration drawing (i7198f) was located by hand in the CDN — its layer
// catalog's digit template confirms the WI-9662 decode positions exactly.
test('dwgen: a fully-optioned 2730M selects every i7198f layer group', { skip: !corpusReady }, async () => {
  const { decodeWithMetadata } = await import('../lib/drawings/decodePartNumber.js');
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveDrawings, resolveEnabledLayers } = await import('../lib/drawings/createImages.js');
  const metadata = await loadDeviceMetadata('2730M');

  const pn = '2730M0ARCA1112CCCC0';
  const decoded = decodeWithMetadata(metadata, pn);
  assert.deepEqual(decoded.positions.filter((p) => !p.matched), []);

  assert.deepEqual(resolveDrawings(metadata, '2730M', pn), { front: 'i7198f.pdf', rear: 'i7198f.pdf' });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let names;
  try {
    names = [...resolveEnabledLayers(metadata, 'i7198f.pdf', pn).names];
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.ok(names.some((n) => n.startsWith('1.01__R__')), 'rack mounting from position 8');
  assert.ok(names.some((n) => n.startsWith('2.01__C__')), 'PSU A 24-48 Vdc from position 9');
  assert.ok(names.some((n) => n.startsWith('3.03__A__')), 'PSU B 125-250 V from position 10');
  assert.ok(names.some((n) => n.startsWith('4.02__1112__')), 'ports combo from positions 11-14');
  assert.ok(names.some((n) => n.startsWith('5.02__CCCC__')), 'SFP bank from positions 15-18');
});

// A real fleet SEL-451-5 (21-character format). It used to fall through to
// the 3U drawing because the drawing rules pinned the I/O board digits at
// "empty", and its front overlay read the mainboard-voltage digit, so every
// 24 Vdc unit got the Bay Control overlay. Rules are now mounting+chassis
// position conditions and the layer sources follow the configurator-verified
// 21-character submodel table.
test('dwgen: a real 451-5 fleet MOT selects the 5U drawing with standard overlay', { skip: !corpusReady }, async () => {
  const { decodeWithMetadata } = await import('../lib/drawings/decodePartNumber.js');
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveDrawings, resolveEnabledLayers } = await import('../lib/drawings/createImages.js');
  const metadata = await loadDeviceMetadata('451');

  const pn = '045152111B0X1H74141XX';
  const decoded = decodeWithMetadata(metadata, pn);
  assert.match(decoded.submodel, /451-5/);
  assert.deepEqual(decoded.positions.filter((p) => !p.matched), []);

  // Mounting H + chassis 7 (5U with LED front panel) → i7312, not the 3U i7014c.
  assert.deepEqual(resolveDrawings(metadata, '451', pn), { front: 'i7312.A.pdf', rear: 'i7312.A.pdf' });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let names;
  try {
    names = [...resolveEnabledLayers(metadata, 'i7312.A.pdf', pn).names];
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.ok(names.some((n) => n.includes('Screw-Terminal Block with Euro Connector')), 'connector+voltage composite reads positions 7 and 9 (this unit has LEA inputs)');
  assert.ok(names.some((n) => /__0__Ports 5C/.test(n)), 'Ethernet card layer reads position 11');
  assert.ok(names.some((n) => n.endsWith('__X__Standard')), 'standard front overlay from position 21');
  assert.ok(!names.some((n) => n.includes('Bay Control')), 'mainboard voltage 1 no longer selects the Bay Control overlay');
});

// The 751's combined RTD-slot layer group used to read only slot E, so ANY
// 751 with a populated slot E got an RTD overlay layer regardless of what
// slot D held. Rebuilt as a slot-D+slot-E composite (the 751A pattern) in the
// metadata audit; both directions are pinned here.
test('dwgen: 751 RTD combined layers require slot D to actually be the RTD card', { skip: !corpusReady }, async () => {
  const { loadDeviceMetadata } = await import('../lib/drawings/deviceMetadata.js');
  const { resolveEnabledLayers } = await import('../lib/drawings/createImages.js');
  const metadata = await loadDeviceMetadata('751');

  // RTD unit (slot D '9X', slot E '70') — the combined layer is drawn, and
  // slot D resolves silently to no standalone layer.
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let rtd;
  let plain;
  try {
    rtd = [...resolveEnabledLayers(metadata, 'i7182.C.pdf', '751501A1A9X70850230').names];
    // Fleet unit with an empty slot D ('0X') and populated slot E ('0X'…'L')
    plain = [...resolveEnabledLayers(metadata, 'i7182.C.pdf', '751002B1B0X0XL11220').names];
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, []);
  assert.ok(rtd.some((n) => n.startsWith('6.15__9- 70__')), 'RTD + slot E 70 combined layer is enabled');
  assert.ok(!plain.some((n) => /^6\.\d+__9- /.test(n)), 'no RTD combined layer without the RTD card');
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
