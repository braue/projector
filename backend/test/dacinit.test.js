// CLECO DAC Inits: the ST generators (ported from the DAC Inits workbook and
// validated against a real CLECO project), the surgical POU CDATA append, and
// the end-to-end generate -> save round-trip that lands a new version.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';
import { JobRegistry } from '../services/tools/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';
import { DacInitService } from '../services/tools/dacinit.js';
import {
  breakerBlock, feederBlock, recloserBlock, transformerBlock,
} from '../services/tools/dacinit/generate.js';
import {
  appendImplementation, declarationHasDevice, deviceIndex, insertDeclarations,
  readDeclarations, readImplementation, replaceDevices, writeImplementation,
} from '../services/tools/dacinit/pou.js';

const PROJ = { recPrefix: 'SEL_651R2', scadaMap: 'DMS_MAP', fdrPrefix: 'FDR', bkrPrefix: 'BKR', voltage: '13.2kV' };
const norm = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').toLowerCase();
const settled = (job) => new Promise((resolve) => {
  const tick = () => (job.status === 'running' ? setTimeout(tick, 5) : resolve(job));
  tick();
});

const POU_XML = (name) => `<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <POU>
    <Name>${name}</Name>
    <POUKind>Program</POUKind>
    <Content>
      <Interface><![CDATA[PROGRAM ${name}
VAR
END_VAR
]]></Interface>
      <Implementation><![CDATA[]]></Implementation>
    </Content>
  </POU>
</RTACModule>`;

const GVL_XML = `<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>DeviceDeclarations</Name>
    <Content><![CDATA[VAR_GLOBAL
	DA_Controller : DA_Control;

	ScreenNum : INT := 0;
END_VAR
]]></Content>
  </GVL>
</RTACModule>`;

test('dacinit generators: reclosers, transformers, feeders, breakers', () => {
  // Switch recloser: the CLECO R119 shape (validated), 13.2kV.
  const rec = recloserBlock({
    number: '119', switch: true, normallyOpen: true, capacity: 100,
    sideAPtSet: 'Set2', sideBPtSet: 'Set1',
    sources: [{ feeder: '4094D', sg: 1 }, { feeder: '4019C', sg: 2 }, { feeder: '4019B', sg: 2 },
      { feeder: '4025A', sg: 2 }, { feeder: '4158B', sg: 2 }, { feeder: '4015B', sg: 2 }],
    numBi: 69, numAi: 18, numBo: 13, numAo: 0, numCnt: 0,
  }, PROJ);
  assert.match(rec, /R119\.Init\(/);
  assert.match(rec, /DeviceDefinition := Rec_SEL_651R_Downline_Sw,/);
  assert.match(rec, /NormallyOpen := TRUE,/);
  assert.match(rec, /R119\.DisplaySwitchMode := TRUE;/);
  assert.match(rec, /pFieldFirst_Bo := ADR\(SEL_651R2_119_DNP\.BO_00000_DAC_TRIP_CLOSE\),/);
  assert.match(rec, /SRC_A := F4094D\.ID,/);
  assert.match(rec, /SRC_C := F4019B\.ID,/);
  assert.match(rec, /NumBi := 69,/);

  // A zero source renders as SRC_x := 0 (not F0.ID).
  const recZero = recloserBlock({
    number: '5', switch: false, normallyOpen: false, capacity: 50, sideAPtSet: 'Set2', sideBPtSet: 'Set1',
    sources: [{ feeder: '100A', sg: 1 }], numBi: 1, numAi: 1, numBo: 1, numAo: 0, numCnt: 0,
  }, PROJ);
  assert.match(recZero, /SRC_B := 0,/);
  assert.match(recZero, /R5\.DisplaySwitchMode := FALSE;/);
  assert.match(recZero, /DeviceDefinition := Rec_SEL_651R_Downline,/);

  // Transformer capacity: (14e6 / 13200 / 1.73) * 1.2 = 735.7 -> 736.
  const xf = transformerBlock({ substation: 'Three Rivers', transformer: 'T1', ratedMva: 14, dnpClient: 'Three_Rivers_Sub' }, PROJ);
  assert.match(xf, /XFMR_Three_Rivers_T1\.Init\(/);
  assert.match(xf, /Name := 'Three_Rivers_T1_XFMR',/);
  assert.match(xf, /Capacity := 736,/);
  assert.match(xf, /pDeviceOffline := ADR\(Three_Rivers_Sub_DNP_POU\.Offline\),/);

  // Feeder + breaker share the same input row; downstream picks 651R vs 351R.
  const fdr = feederBlock({ number: '4015B', capacity: 400, dnpClient: 'Abita_Springs_Sub' }, PROJ);
  assert.match(fdr, /F4015B\.Init\(/);
  assert.match(fdr, /DeviceDefinition := Feeder_Std,/);
  assert.match(fdr, /pFirst_Bi := ADR\(DMS_MAP_DNP\.FDR_4015B_BI_00000_Armed\),/);

  const bkrDown = breakerBlock({ number: '4015B', downstream: true, normallyOpen: false, capacity: 400, dnpClient: 'Abita_Springs_Sub' }, PROJ);
  assert.match(bkrDown, /DeviceDefinition := Rec_SEL_651R_Sub,/);
  assert.match(bkrDown, /SideA_PT_Set := Set2,/);
  assert.match(bkrDown, /BKR_4015B_BI_00000_A_PHASE_STATUS/);

  const bkrNo = breakerBlock({ number: '4015C', downstream: false, normallyOpen: false, capacity: 500, dnpClient: 'Abita_Springs_Sub' }, PROJ);
  assert.match(bkrNo, /DeviceDefinition := Rec_SEL_351R_Sub,/);
  assert.match(bkrNo, /SideB_PT_Set := NO_PT,/);
  assert.match(bkrNo, /BKR_4015C_BI_00000_3_PHASE_STATUS/);
});

test('dacinit pou: append into CDATA, preserve the rest, detect existing devices', () => {
  const xml = POU_XML('Init_Reclosers');
  assert.equal(readImplementation(xml), '');
  const next = writeImplementation(xml,
    appendImplementation(readImplementation(xml), 'R048.Init(\n\tName := \'R048\');'));
  assert.match(readImplementation(next), /R048\.Init\(/);
  // Interface CDATA and the element scaffolding are untouched.
  assert.match(next, /<Interface><!\[CDATA\[PROGRAM Init_Reclosers/);
  assert.match(next, /<\/RTACModule>$/);
  assert.equal(next.match(/<!\[CDATA\[/g).length, 2);
  // The index keys devices case-insensitively, at statement starts.
  const devices = deviceIndex(readImplementation(next));
  assert.equal(devices.get('r048').length, 1);
  assert.equal(devices.has('r049'), false);

  // GVL declarations: insert before END_VAR, detect existing declarations.
  const decl = insertDeclarations(GVL_XML, '\t// batch\n\tR9998 : DA_REC;');
  assert.match(readDeclarations(decl), /R9998 : DA_REC;/);
  assert.match(readDeclarations(decl), /END_VAR\s*$/); // END_VAR stays last
  assert.equal(declarationHasDevice(readDeclarations(decl), 'R9998'), true);
  assert.equal(declarationHasDevice(readDeclarations(decl), 'DA_Controller'), true);
  assert.equal(declarationHasDevice(readDeclarations(decl), 'R9999'), false);
});

test('dacinit end-to-end: generate appends, save lands a new version, re-runs offer overwrite', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacinit-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    // Synthesize a minimal DAC .rtac in the store.
    const initDir = path.join(tmp, 'files', 'Test.rtac', 'SEL_RTAC', 'DAC', 'Initializations');
    await mkdir(initDir, { recursive: true });
    for (const [file, name] of [
      ['Init_Reclosers.xml', 'Init_Reclosers'], ['Init_Xfmr.xml', 'Init_Xfmr'],
      ['Init_Feeders.xml', 'Init_Feeders'], ['Init_Breakers.xml', 'Init_Breakers'],
    ]) {
      await writeFile(path.join(initDir, file), POU_XML(name));
    }
    const declFile = path.join(tmp, 'files', 'Test.rtac', 'SEL_RTAC', 'DAC', 'DeviceDeclarations.xml');
    await writeFile(declFile, GVL_XML);

    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const jobs = new JobRegistry();
    const dacinit = new DacInitService({ workspace, jobs });

    const payload = {
      path: 'Test.rtac',
      params: PROJ,
      reclosers: [{
        number: '119', switch: true, normallyOpen: true, capacity: 100, sideAPtSet: 'Set2', sideBPtSet: 'Set1',
        sources: [{ feeder: '4094D', sg: 1 }], numBi: 69, numAi: 18, numBo: 13, numAo: 0, numCnt: 0,
      }],
      transformers: [{ substation: 'Three Rivers', transformer: 'T1', ratedMva: 14, dnpClient: 'Three_Rivers_Sub' }],
      feedersBreakers: [{ number: '4015B', capacity: 400, normallyOpen: false, downstream: true, dnpClient: 'Abita_Springs_Sub' }],
    };

    // Two rows claiming one identifier would write the device twice — refused
    // before anything is generated.
    await assert.rejects(dacinit.generate(files, {
      ...payload,
      feedersBreakers: [...payload.feedersBreakers, { ...payload.feedersBreakers[0], capacity: 900 }],
    }), /same identifier: F4015B, B4015B/);

    const { job: jobId, run } = await dacinit.generate(files, payload);
    const job = await settled(jobs.get(jobId));
    assert.equal(job.status, 'done', job.error ?? '');
    assert.deepEqual(job.result.added.reclosers, ['R119']);
    assert.deepEqual(job.result.added.transformers, ['XFMR_Three_Rivers_T1']);
    assert.deepEqual(job.result.added.feeders, ['F4015B']);
    assert.deepEqual(job.result.added.breakers, ['B4015B']);
    assert.deepEqual([...job.result.declarations.added].sort(),
      ['B4015B', 'F4015B', 'R119', 'XFMR_Three_Rivers_T1']);
    assert.match(job.result.note, /Auto inits & declarations: add 1 recloser, 1 transformer, 1 feeder, 1 breaker/);

    // The run copy has the injected ST; the source is still untouched.
    const runRecl = await readFile(
      path.join(await workspace.runDir('dacinit', run), 'Test.rtac', 'SEL_RTAC', 'DAC', 'Initializations', 'Init_Reclosers.xml'), 'utf8');
    assert.match(runRecl, /R119\.Init\(/);
    const sourceRecl = await readFile(path.join(initDir, 'Init_Reclosers.xml'), 'utf8');
    assert.equal(readImplementation(sourceRecl), '');

    // Save lands it as a new version of the same entry.
    const saved = await dacinit.save(files, run);
    assert.equal(saved.placed, 'Test.rtac');
    const [entry] = await files.tree((name) => (name.endsWith('.rtac') ? 'rtac' : null));
    assert.equal(entry.name, 'Test.rtac');
    assert.equal(entry.versions.length, 1); // the prior (empty) project archived
    const liveRecl = await readFile(path.join(initDir, 'Init_Reclosers.xml'), 'utf8');
    assert.match(readImplementation(liveRecl), /R119\.Init\(/);
    const liveDecl = await readFile(declFile, 'utf8');
    assert.match(readDeclarations(liveDecl), /R119 : DA_REC;/);
    assert.match(readDeclarations(liveDecl), /XFMR_Three_Rivers_T1 : DA_SUB_TRANSFORMER;/);
    assert.match(readDeclarations(liveDecl), /F4015B : DA_FDR;/);
    assert.match(readDeclarations(liveDecl), /END_VAR\s*$/);

    // Re-running the same devices changes nothing and reports every identifier
    // as a conflict, with the POU it already sits in — no error, because the
    // caller is being offered the overwrite.
    const again = await dacinit.generate(files, payload);
    const againJob = await settled(jobs.get(again.job));
    assert.equal(againJob.status, 'done', againJob.error ?? '');
    assert.deepEqual(againJob.result.conflicts.map((c) => c.name).sort(),
      ['B4015B', 'F4015B', 'R119', 'XFMR_Three_Rivers_T1']);
    assert.deepEqual(againJob.result.conflicts.find((c) => c.name === 'R119').where,
      ['Init_Reclosers.xml']);
    assert.equal(againJob.result.changed, 0);         // nothing to save
    assert.deepEqual(againJob.result.reports, []);
    await assert.rejects(dacinit.save(files, again.run), /changed nothing/);

    // Overwriting rewrites the block in place — one R119, with the new
    // capacity — and leaves the (unchanged) declaration alone.
    const heavier = {
      ...payload,
      reclosers: [{ ...payload.reclosers[0], capacity: 250 }],
      overwrite: ['R119'],
    };
    const third = await dacinit.generate(files, heavier);
    const thirdJob = await settled(jobs.get(third.job));
    assert.equal(thirdJob.status, 'done', thirdJob.error ?? '');
    assert.deepEqual(thirdJob.result.replaced.reclosers, ['R119']);
    assert.deepEqual(thirdJob.result.added.reclosers, []);
    assert.deepEqual(thirdJob.result.declarations.added, []);
    assert.deepEqual(thirdJob.result.conflicts.map((c) => c.name).sort(),
      ['B4015B', 'F4015B', 'XFMR_Three_Rivers_T1']);
    assert.match(thirdJob.result.note, /overwrite R119/);

    const rewritten = readImplementation(await readFile(
      path.join(await workspace.runDir('dacinit', third.run),
        'Test.rtac', 'SEL_RTAC', 'DAC', 'Initializations', 'Init_Reclosers.xml'), 'utf8'));
    assert.equal(rewritten.match(/R119\.Init\(/g).length, 1);
    assert.match(rewritten, /Capacity := 250,/);
    assert.doesNotMatch(rewritten, /Capacity := 100,/);
    // The devices declared in the earlier run are still declared exactly once.
    const decls = readDeclarations(await readFile(declFile, 'utf8'));
    assert.equal(decls.match(/R119/g).length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('dacinit pou: overwrite a device block in place, leaving its neighbours be', () => {
  const impl = [
    '// hand-written note about R048',
    "R048.Init(",
    "\tName := 'R048',",
    '\tCapacity := 100);',
    '',
    'R048.DisplaySwitchMode := FALSE;',
    '',
    "R049.Init(",
    "\tName := 'R049',",
    '\tCapacity := 200);',
    '',
  ].join('\n');

  const spans = deviceIndex(impl).get('r048');
  assert.equal(spans.length, 2);
  const next = replaceDevices(impl, [{ spans, text: "R048.Init(\n\tCapacity := 250);" }]);
  assert.equal(next.match(/R048\.Init\(/g).length, 1);
  assert.match(next, /Capacity := 250\);/);
  assert.doesNotMatch(next, /DisplaySwitchMode/);       // the old block's statements are gone
  assert.match(next, /\/\/ hand-written note about R048/); // the comment above it stays
  assert.match(next, /R049\.Init\(/);                    // the next device is untouched
  assert.match(next, /Capacity := 200\);/);
  // R048's replacement sits where it was, still ahead of R049.
  assert.ok(next.indexOf('R048.Init(') < next.indexOf('R049.Init('));
  // Rewriting two devices at once leaves each in its own place.
  const index = deviceIndex(impl);
  const both = replaceDevices(impl, [
    { spans: index.get('r048'), text: 'R048.Init();' },
    { spans: index.get('r049'), text: 'R049.Init();' },
  ]);
  assert.match(both, /R048\.Init\(\);/);
  assert.match(both, /R049\.Init\(\);/);
  assert.ok(both.indexOf('R048') < both.indexOf('R049'));
  assert.doesNotMatch(both, /Capacity/);
});

test('dacinit pou: a ";" inside a comment or string does not end a statement', () => {
  const impl = "R1.Init( // capacity; per the study\n\tName := 'a;b');\n";
  const spans = deviceIndex(impl).get('r1');
  assert.equal(spans.length, 1);
  assert.equal(impl.slice(spans[0].start, spans[0].end), impl.trimEnd());
  assert.equal(replaceDevices(impl, [{ spans, text: 'R1.Init();' }]), 'R1.Init();\n');
});
