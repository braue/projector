// CLECO DAC Inits: the ST generators (ported from the DAC Inits workbook and
// validated against a real CLECO project), the surgical POU CDATA append, and
// the end-to-end generate -> save round-trip that lands a new version.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';
import { JobRegistry } from '../services/jobs.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';
import { DacInitService } from '../services/tools/dacinit.js';
import { declarationBatch, writeInits } from '../services/tools/dacinit/generate.js';
import { readProject } from '../services/tools/dacinit/project.js';
import { lockoutPeriod, resolveSpecs, switchDefinition } from '../services/tools/dacinit/resolve.js';
import {
  appendImplementation, declarationHasDevice, deviceIndex, insertDeclarations, patchRecloser,
  readDeclarations, readImplementation, recloserState, replaceDevices, writeImplementation,
} from '../services/tools/dacinit/pou.js';

const PROJ = { ptA: 'Set2', ptB: 'Set1' };
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

// --- project fixtures: the shapes the CLECO schemes export ------------------

const tagRows = (tags) => tags.map((tag) => `
          <Row>
            <Setting><Column>Enable</Column><Value>True</Value></Setting>
            <Setting><Column>Tag Name</Column><Value>${tag}</Value></Setting>
          </Row>`).join('');
const pages = (sections) => ['Binary Inputs', 'Analog Inputs', 'Binary Outputs'].map((page, i) => `
        <SettingPage>
          <Name>${page}</Name>${tagRows(sections[i] ?? [])}
        </SettingPage>`).join('');
/** A DNP client device export with BI/AI/BO tag pages. */
const CLIENT_XML = (name, bi, ai, bo) => `<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <Device>
    <Name>${name}</Name>
    <Connection>
      <Protocol>DNPClient</Protocol>
      <SettingPages>${pages([bi, ai, bo])}
      </SettingPages>
    </Connection>
  </Device>
</RTACModule>`;
/** A SCADA server map (TagList) export. */
const MAP_XML = (name, bi, ai, bo) => `<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <TagList>
    <Name>${name}</Name>
    <TagListType>DNP</TagListType>
    <SettingPages>${pages([bi, ai, bo])}
    </SettingPages>
  </TagList>
</RTACModule>`;
const DEVDEF_XML = (name, decls) => `<?xml version="1.0" encoding="utf-8"?>
<RTACModule>
  <GVL>
    <Name>${name}</Name>
    <Content><![CDATA[VAR_GLOBAL
${decls.map(([def, type]) => `${def} : ${type} := (\n\t\tTypeName := '${def}'\n\t);`).join('\n')}
END_VAR
]]></Content>
  </GVL>
</RTACModule>`;

/** Write a DAC .rtac folder: { 'rel/path.xml': xml }. */
async function writeProject(dir, filesByPath) {
  for (const [rel, xml] of Object.entries(filesByPath)) {
    const file = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, xml);
  }
}

// A 13.2kV scheme in the Slidell shape: recloser clients named SEL_651R2_R###,
// a DMS_MAP server map, breakers on a substation client.
const PROJECT_13 = {
  'SEL_RTAC/DAC/Initializations/Init_Reclosers.xml': POU_XML('Init_Reclosers'),
  'SEL_RTAC/DAC/Initializations/Init_XFMR.xml': POU_XML('Init_XFMR'),
  'SEL_RTAC/DAC/Initializations/Init_Feeders.xml': POU_XML('Init_Feeders'),
  'SEL_RTAC/DAC/Initializations/Init_Breakers.xml': POU_XML('Init_Breakers'),
  'SEL_RTAC/DAC/DeviceDeclarations.xml': GVL_XML,
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Recloser.xml': DEVDEF_XML('DevDef_Recloser', [
    ['Rec_SEL_651R_Downline', 'typeRecloserDeviceDef'], ['Rec_SEL_651R_Downline_sw', 'typeRecloserDeviceDef'],
    ['Rec_SEL_651R_Sub', 'typeRecloserDeviceDef'], ['Rec_SEL_351R_Sub', 'typeRecloserDeviceDef']]),
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Feeder.xml': DEVDEF_XML('DevDef_Feeder', [['Feeder_Std', 'typeFeederDeviceDef']]),
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Xfmr.xml': DEVDEF_XML('DevDef_Xfmr', [['Sub_XFMR', 'typeBaseTransformerDeviceDef']]),
  'SEL_RTAC/Substations/Abita/Circuit_4015B/SEL_651R2_R119_DNP.xml': CLIENT_XML('SEL_651R2_R119',
    ['SEL_651R2_R119_DNP.BI_00000_A_PHASE_STATUS', 'SEL_651R2_R119_DNP.BI_00001_B_PHASE_STATUS'],
    ['SEL_651R2_R119_DNP.AI_00000_IA'],
    ['SEL_651R2_R119_DNP.BO_00000_DAC_TRIP_CLOSE.status']),
  'SEL_RTAC/Substations/Abita/Abita_Springs_Sub_DNP.xml': CLIENT_XML('Abita_Springs_Sub',
    ['Abita_Springs_Sub_DNP.Bkr_4015A_BI_00000_A_PHASE_STATUS', 'Abita_Springs_Sub_DNP.Bkr_4015B_BI_00000_A_PHASE_STATUS'],
    ['Abita_Springs_Sub_DNP.Bkr_4015A_AI_00000_IA', 'Abita_Springs_Sub_DNP.Bkr_4015B_AI_00000_IA'],
    ['Abita_Springs_Sub_DNP.Bkr_4015A_BO_00000_DAC_TRIP_CLOSE', 'Abita_Springs_Sub_DNP.Bkr_4015B_BO_00000_DAC_TRIP_CLOSE']),
  'SEL_RTAC/Substations/Three_Rivers_Sub_DNP.xml': CLIENT_XML('Three_Rivers_Sub', ['Three_Rivers_Sub_DNP.BI_00000_X'], [], []),
  'SEL_RTAC/Substations/SCADA/DMS_MAP_DNP.xml': MAP_XML('DMS_MAP',
    ['DMS_MAP_DNP.DAC_BI_00000_Enabled', 'DMS_MAP_DNP.FDR_4015B_BI_00000_Armed',
      'DMS_MAP_DNP.FDR_4015B_BI_00027_Breaker_CommandTimeout', 'DMS_MAP_DNP.SEL_651R2_R119_BI_00000_A_PHASE_STATUS'],
    ['DMS_MAP_DNP.SEL_651R2_R119_AI_00000_IA'],
    ['DMS_MAP_DNP.FDR_4015B_BO_00000_Exclude_CMD', 'DMS_MAP_DNP.FDR_4015B_BO_00004_Breaker_Inhibit_CMD',
      'DMS_MAP_DNP.SEL_651R2_R119_BO_00000_DAC_TRIP_CLOSE']),
};

// A 34.5kV scheme in the Eunice shape: two reclosers on one shared client
// (ST_MARY_3166_3168_DNP._3166_…), points split onto DMS_POINTS_TWO, feeders
// heading on pseudo breakers, no switch definitions declared.
const PROJECT_345 = {
  'SEL_RTAC/DAC/Initializations/Init_Reclosers.xml': POU_XML('Init_Reclosers'),
  'SEL_RTAC/DAC/Initializations/Init_Feeders.xml': POU_XML('Init_Feeders'),
  'SEL_RTAC/DAC/Initializations/Init_Pseudo_Bkrs.xml': POU_XML('Init_Pseudo_Bkrs'),
  'SEL_RTAC/DAC/Initializations/Init_DA_Connector.xml': POU_XML('Init_DA_Connector')
    .replace('<![CDATA[]]></Implementation>', "<![CDATA[R3472_Connector.Init(Name := 'R3472');]]></Implementation>"),
  'SEL_RTAC/DAC/DeviceDeclarations.xml': GVL_XML,
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Recloser.xml': DEVDEF_XML('DevDef_Recloser', [
    ['RecDef_Standard', 'typeRecloserDeviceDef'], ['RecDef_Standard_withCommFail', 'typeRecloserDeviceDef']]),
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Feeder.xml': DEVDEF_XML('DevDef_Feeder', [['FdrDef_Standard', 'typeFeederDeviceDef']]),
  'SEL_RTAC/DAC/DeviceDefinitions/DevDef_PseudoBkr.xml': DEVDEF_XML('DevDef_PseudoBkr', [['PseudoBkr_Std', 'typePseudoBreakerDeviceDef']]),
  'SEL_RTAC/Substations/Eunice_Sub/ST_MARY_3166_3168_DNP.xml': CLIENT_XML('ST_MARY_3166_3168',
    ['ST_MARY_3166_3168_DNP._3166_BI_00000_RECLOSER_STATUS', 'ST_MARY_3166_3168_DNP._3168_BI_00000_RECLOSER_STATUS'],
    ['ST_MARY_3166_3168_DNP._3166_AI_00000_IA', 'ST_MARY_3166_3168_DNP._3168_AI_00000_IA'],
    ['ST_MARY_3166_3168_DNP._3166_BO_00000_SS1', 'ST_MARY_3166_3168_DNP._3168_BO_00000_SS1']),
  'SEL_RTAC/Substations/SCADA/DMS_POINTS_TWO_DNP.xml': MAP_XML('DMS_POINTS_TWO',
    ['DMS_POINTS_TWO_DNP.FEEDER_3183_BI_00000_Armed', 'DMS_POINTS_TWO_DNP.SEL_651R2_3166_BI_00000_Recloser_Status',
      'DMS_POINTS_TWO_DNP.R3166_Connector_BI_00000_Status'],
    ['DMS_POINTS_TWO_DNP.SEL_651R2_3166_AI_00000_IA'],
    ['DMS_POINTS_TWO_DNP.FEEDER_3183_BO_00000_Exclude_CMD', 'DMS_POINTS_TWO_DNP.SEL_651R2_3166_BO_00000_SS1']),
};

const recRow = (number, extra = {}) => ({
  number, switch: false, normallyOpen: false, capacity: 100,
  sources: [{ feeder: '4015B', sg: 1 }], ...extra,
});

async function resolved(fixture, payload, known = () => false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'projector-dacinit-proj-'));
  try {
    await writeProject(dir, fixture);
    const project = await readProject(dir);
    const out = resolveSpecs(payload, project, known);
    return { ...out, project, text: writeInits(out.specs) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('dacinit 13.2kV: pointers come from the project\'s own clients and SCADA map', async () => {
  const { family, warnings, text } = await resolved(PROJECT_13, {
    params: { ptA: 'Set2', ptB: 'Set1' },
    reclosers: [recRow('119', { switch: true, normallyOpen: true })],
    transformers: [{ substation: 'Three Rivers', transformer: 'T1', ratedMva: 14 }],
    feedersBreakers: [{ number: '4015B', capacity: 400, normallyOpen: false, breaker: '651R', dnpClient: 'Abita_Springs_Sub' }],
  });
  assert.equal(family, '13.2kV');
  assert.deepEqual(warnings, []);

  const rec = text.reclosers[0].text;
  assert.match(rec, /R119\.Init\(/);
  assert.match(rec, /DeviceDefinition := Rec_SEL_651R_Downline_Sw,/);
  assert.match(rec, /NormallyOpen := TRUE,/);
  // The client is SEL_651R2_R119, not the SEL_651R2_119 a template would guess.
  assert.match(rec, /pFieldFirst_Bi := ADR\(SEL_651R2_R119_DNP\.BI_00000_A_PHASE_STATUS\),/);
  assert.match(rec, /pFieldFirst_Bo := ADR\(SEL_651R2_R119_DNP\.BO_00000_DAC_TRIP_CLOSE\),/);
  assert.match(rec, /pPoll := ADR\(SEL_651R2_R119_DNP_POU\.Poll_Integrity_Obj_60_Cls_1230\),/);
  assert.match(rec, /pFirst_Bi := ADR\(DMS_MAP_DNP\.SEL_651R2_R119_BI_00000_A_PHASE_STATUS\),/);
  assert.match(rec, /R119\.DisplaySwitchMode := TRUE;/);
  assert.match(rec, /SRC_A := F4015B\.ID,/);  // the feeder added in the same run
  assert.match(rec, /SRC_B := 0,/);
  assert.match(rec, /NumBi := 69,\n\tNumAi := 18,\n\tNumBo := 13,/);

  const xf = text.transformers[0].text;
  assert.match(xf, /XFMR_Three_Rivers_T1\.Init\(/);
  assert.match(xf, /Name := 'Three_Rivers_T1_XFMR',/);
  assert.match(xf, /Capacity := 736,/); // (14e6 / 13200 / 1.73) * 1.2 = 735.7
  assert.match(xf, /pDeviceOffline := ADR\(Three_Rivers_Sub_DNP_POU\.Offline\),/); // client defaults to <sub>_Sub

  const fdr = text.feeders[0].text;
  assert.match(fdr, /DeviceDefinition := Feeder_Std,/);
  assert.match(fdr, /pFirst_Bi := ADR\(DMS_MAP_DNP\.FDR_4015B_BI_00000_Armed\),/);
  assert.match(fdr, /pFirst_Bo := ADR\(DMS_MAP_DNP\.FDR_4015B_BO_00000_Exclude_CMD\),/);

  const bkr = text.breakers[0].text;
  assert.match(bkr, /DeviceDefinition := Rec_SEL_651R_Sub,/);
  assert.match(bkr, /SideA_PT_Set := Set2,\n\tSideB_PT_Set := Set1,/);
  // Its own group on the substation client, not its neighbour's.
  assert.match(bkr, /pFieldFirst_Bi := ADR\(Abita_Springs_Sub_DNP\.Bkr_4015B_BI_00000_A_PHASE_STATUS\),/);
  assert.match(bkr, /pFirst_Bi := ADR\(DMS_MAP_DNP\.FDR_4015B_BI_00027_Breaker_CommandTimeout\),/);
  assert.match(bkr, /pFirst_Bo := ADR\(DMS_MAP_DNP\.FDR_4015B_BO_00004_Breaker_Inhibit_CMD\),/);
  assert.deepEqual(text.pseudoBreakers, []);
});

test('dacinit 34.5kV: shared clients, split SCADA maps, pseudo breakers', async () => {
  const { family, warnings, text } = await resolved(PROJECT_345, {
    params: {},
    reclosers: [recRow('3166', { commFail: true, sources: [{ feeder: '3183', sg: 1 }, { feeder: 'R3472_Connector', sg: 2 }] })],
    feedersBreakers: [{ number: '3183', capacity: 950, lockout: '48' }],
  }, (name) => name === 'R3472_Connector');
  assert.equal(family, '34.5kV'); // from the definitions the project declares
  assert.deepEqual(warnings, []);

  const rec = text.reclosers[0].text;
  assert.match(rec, /DeviceDefinition := RecDef_Standard_withCommFail,/);
  assert.match(rec, /pFieldFirst_Bi := ADR\(ST_MARY_3166_3168_DNP\._3166_BI_00000_RECLOSER_STATUS\),/);
  assert.match(rec, /pFieldFirst_Bo := ADR\(ST_MARY_3166_3168_DNP\._3166_BO_00000_SS1\),/);
  assert.match(rec, /pDeviceOffline := ADR\(ST_MARY_3166_3168_DNP_POU\.Offline\),/);
  // The recloser's own group on the map — not R3166_Connector's.
  assert.match(rec, /pFirst_Bi := ADR\(DMS_POINTS_TWO_DNP\.SEL_651R2_3166_BI_00000_Recloser_Status\),/);
  assert.match(rec, /SRC_B := R3472_Connector\.ID,/);
  // A shared-client recloser with no same-shaped neighbours: 65/22/34.
  assert.match(rec, /NumBi := 65,\n\tNumAi := 22,\n\tNumBo := 34,/);

  const fdr = text.feeders[0].text;
  assert.match(fdr, /DeviceDefinition := FdrDef_Standard,/);
  assert.match(fdr, /pFirst_Bi := ADR\(DMS_POINTS_TWO_DNP\.FEEDER_3183_BI_00000_Armed\),/);
  // 34.5kV feeders head on pseudo breakers unless told otherwise.
  assert.deepEqual(text.breakers, []);
  const pseudo = text.pseudoBreakers[0].text;
  assert.match(pseudo, /B3183\.init\(/);
  assert.match(pseudo, /DeviceDefinition := PseudoBkr_Std,/);
  assert.match(pseudo, /LockoutPeriod := T#48S,/);
  assert.match(pseudo, /TempCapacity := 950\);/);
});

test('dacinit: what the project cannot answer falls back to the naming convention, with a warning', async () => {
  const { warnings, text } = await resolved(PROJECT_345, {
    params: { recPrefix: 'SEL_651R2', scadaMap: 'DMS_POINTS' },
    reclosers: [recRow('9999', { switch: true, sources: [{ feeder: '1234', sg: 1 }] })],
  });
  const rec = text.reclosers[0].text;
  assert.match(rec, /DeviceDefinition := RecDef_Switch,/);
  assert.match(rec, /pFieldFirst_Bi := ADR\(SEL_651R2_9999_DNP\.BI_00000_RECLOSER_STATUS\),/);
  assert.match(rec, /pFirst_Bi := ADR\(DMS_POINTS_DNP\.SEL_651R2_9999_BI_00000_RECLOSER_STATUS\),/);
  const messages = warnings.map((w) => `${w.device}: ${w.message}`);
  assert.ok(messages.some((m) => /^R9999: RecDef_Switch is not a device definition/.test(m)), messages.join('\n'));
  assert.ok(messages.some((m) => /^R9999: field points: no DNP client carries its points/.test(m)));
  assert.ok(messages.some((m) => /^R9999: SCADA points: no SCADA map has its points/.test(m)));
  assert.ok(messages.some((m) => /^R9999: SRC_A 1234 is not a feeder or connector/.test(m)));
});

test('dacinit: a transformer finds its DNP client by its substation name', async () => {
  const { warnings, text } = await resolved(PROJECT_13, {
    params: PROJ,
    transformers: [
      { substation: 'Abita Springs', transformer: 'T1', ratedMva: 14 },
      { substation: 'three_rivers', transformer: 'T2', ratedMva: 14 },
      { substation: 'Nowhere', transformer: 'T1', ratedMva: 14 },
    ],
  });
  const [abita, rivers, nowhere] = text.transformers.map((t) => t.text);
  assert.match(abita, /Abita_Springs_Sub_DNP_POU/);
  assert.match(rivers, /Three_Rivers_Sub_DNP_POU/);
  assert.match(nowhere, /Nowhere_Sub_DNP_POU/);
  assert.deepEqual(warnings.filter((w) => /DNP client/.test(w.message)).map((w) => w.device), ['XFMR_Nowhere_T1']);
});

test('dacinit: a source the project lacks keeps the name it was typed as', async () => {
  const { warnings, text } = await resolved(PROJECT_13, {
    params: PROJ,
    reclosers: [recRow('119', { sources: [{ feeder: 'F9999', sg: 1 }, { feeder: '9998', sg: 2 }] })],
  });
  const rec = text.reclosers[0].text;
  assert.match(rec, /F9999\.ID/);
  assert.match(rec, /F9998\.ID/);
  assert.doesNotMatch(rec, /FF999/);
  assert.equal(warnings.filter((w) => /SRC_/.test(w.message)).length, 2);
});

test('dacinit: declarations batch eight to a line, kinds apart', () => {
  const batch = declarationBatch({
    reclosers: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
    pseudoBreakers: ['B10'],
    feeders: ['F10'],
  }, 'header');
  assert.equal(batch, [
    '\t// header',
    '',
    '\tF10 : DA_FDR;',
    '',
    '\tB10 : DA_Pseudo_Bkr;',
    '',
    '\tR1, R2, R3, R4, R5, R6, R7, R8 : DA_REC;',
    '\tR9 : DA_REC;',
  ].join('\n'));
  assert.equal(lockoutPeriod('15s'), 'T#15S');
  assert.equal(lockoutPeriod('t#50s'), 'T#50S');
  assert.equal(lockoutPeriod(''), 'T#15S');
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
    // A 13.2kV DAC .rtac in the store, Init_XFMR spelled the Alexandria way.
    const rtac = path.join(tmp, 'files', 'Test.rtac');
    await writeProject(rtac, PROJECT_13);
    const initDir = path.join(rtac, 'SEL_RTAC', 'DAC', 'Initializations');
    const declFile = path.join(rtac, 'SEL_RTAC', 'DAC', 'DeviceDeclarations.xml');

    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const jobs = new JobRegistry();
    const dacinit = new DacInitService({ workspace, jobs });

    const payload = {
      path: 'Test.rtac',
      params: PROJ,
      reclosers: [{
        number: '119', switch: true, normallyOpen: true, capacity: 100, sideAPtSet: 'Set2', sideBPtSet: 'Set1',
        sources: [{ feeder: '4015B', sg: 1 }], numBi: 69, numAi: 18, numBo: 13, numAo: 0, numCnt: 0,
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
    // This fixture has no AreaMap; the inits don't need one.
    assert.deepEqual(job.result.warnings, [
      { device: 'AreaMap', message: 'SEL_RTAC/DAC/AreaMap.xml not found; devices not placed' }]);
    assert.equal(job.result.family, '13.2kV');
    const runXfmr = await readFile(path.join(await workspace.runDir('dacinit', run),
      'Test.rtac', 'SEL_RTAC', 'DAC', 'Initializations', 'Init_XFMR.xml'), 'utf8');
    assert.match(runXfmr, /XFMR_Three_Rivers_T1\.Init\(/);
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

    // Re-running the same devices changes nothing: the recloser already has
    // these settings, and every other identifier is reported as a conflict,
    // with the POU it already sits in — no error, because the caller is being
    // offered the overwrite.
    const again = await dacinit.generate(files, payload);
    const againJob = await settled(jobs.get(again.job));
    assert.equal(againJob.status, 'done', againJob.error ?? '');
    assert.deepEqual(againJob.result.unchanged, ['R119']);
    assert.deepEqual(againJob.result.updated, []);
    assert.deepEqual(againJob.result.conflicts.map((c) => c.name).sort(),
      ['B4015B', 'F4015B', 'XFMR_Three_Rivers_T1']);
    assert.deepEqual(againJob.result.conflicts.find((c) => c.name === 'F4015B').where,
      ['Init_Feeders.xml']);
    assert.equal(againJob.result.changed, 0);         // nothing to save
    assert.deepEqual(againJob.result.reports, []);
    await assert.rejects(dacinit.save(files, again.run), /changed nothing/);

    // An existing recloser with a new capacity, switch mode and settings
    // groups is updated in place: those settings change, nothing else in its
    // block does.
    const before = readImplementation(await readFile(path.join(initDir, 'Init_Reclosers.xml'), 'utf8'));
    const update = await dacinit.generate(files, {
      ...payload,
      reclosers: [{ number: '119', switch: false, capacity: 300,
        sources: [{ feeder: '4015B', sg: 2 }, { feeder: '4015B', sg: 1 }] }],
    });
    const updateJob = await settled(jobs.get(update.job));
    assert.equal(updateJob.status, 'done', updateJob.error ?? '');
    assert.deepEqual(updateJob.result.updated, [{
      name: 'R119',
      where: 'Init_Reclosers.xml',
      changes: [
        { what: 'capacity', from: '100', to: '300' },
        { what: 'switch mode', from: 'on', to: 'off' },
        { what: 'settings groups', from: 'SG_A 1, SRC_B 0, SG_B 0', to: 'SG_A 2, SRC_B F4015B.ID, SG_B 1' },
      ],
    }]);
    assert.deepEqual(updateJob.result.warnings, []);
    assert.match(updateJob.result.note, /update R119 \(capacity, switch mode, settings groups\)/);
    const after = readImplementation(await readFile(path.join(await workspace.runDir('dacinit', update.run),
      'Test.rtac', 'SEL_RTAC', 'DAC', 'Initializations', 'Init_Reclosers.xml'), 'utf8'));
    assert.equal(after, before
      .replace('DeviceDefinition := Rec_SEL_651R_Downline_Sw,', 'DeviceDefinition := Rec_SEL_651R_Downline,')
      .replace('Capacity := 100,', 'Capacity := 300,')
      .replace('TempCapacity := 100,', 'TempCapacity := 300,')
      .replace('R119.DisplaySwitchMode := TRUE;', 'R119.DisplaySwitchMode := FALSE;')
      .replace('SG_A := 1,', 'SG_A := 2,')
      .replace('SRC_B := 0,\n\tSG_B := 0,', 'SRC_B := F4015B.ID,\n\tSG_B := 1,'));

    // A source the project doesn't have is still written, and flagged.
    const unknown = await dacinit.generate(files, {
      ...payload,
      reclosers: [{ number: '119', switch: true, capacity: 100, sources: [{ feeder: '4015B', sg: 1 }, { feeder: '9999', sg: 2 }] }],
    });
    const unknownJob = await settled(jobs.get(unknown.job));
    assert.equal(unknownJob.status, 'done', unknownJob.error ?? '');
    assert.deepEqual(unknownJob.result.updated.map((u) => u.changes.map((c) => c.what)), [['settings groups']]);
    assert.deepEqual(unknownJob.result.warnings.map((w) => w.message),
      ['SRC_B 9999 is not a feeder or connector in this project']);

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

test('dacinit update: switch-mode definitions and in-place recloser patches', () => {
  assert.equal(switchDefinition('Rec_SEL_651R_Downline', true), 'Rec_SEL_651R_Downline_Sw');
  assert.equal(switchDefinition('Rec_SEL_651R_Downline_sw', true), 'Rec_SEL_651R_Downline_sw');
  assert.equal(switchDefinition('Rec_SEL_651R_Downline_sw', false), 'Rec_SEL_651R_Downline');
  assert.equal(switchDefinition('RecDef_Standard_withCommFail', true), 'RecDef_Switch_withCommFail');
  assert.equal(switchDefinition('RecDef_Switch_Forest_Hill', false), 'RecDef_Standard_Forest_Hill');
  assert.equal(switchDefinition('Rec_SEL_651R_Sub', true), null);

  // The 34.5kV paste shape: tab-aligned, no DisplaySwitchMode written.
  const impl = [
    'R6895.init(\t\t\t\t',
    "\tName\t:=\t'R6895'\t,",
    '\tDeviceDefinition\t:=\tRecDef_Standard_withCommFail\t,',
    '\tCapacity\t:=\t250\t,',
    '\tTempCapacity\t:=\t250\t,',
    '\tSideA_PT_Set\t:=\tSet2\t);',
    'R6895.initDaScadaLink(',
    '\tpFirst_Bi\t:=\t0\t);',
    '',
    'R6895.InitSettingsGroups(SRC_A := F6878.ID, SG_A := 1);',
    '',
    'R6896.init(Name := \'R6896\', Capacity := 250);',
  ].join('\n');
  const spans = deviceIndex(impl).get('r6895');
  const sources = [{ src: 'F6878.ID', sg: '1' }, ...Array.from({ length: 5 }, () => ({ src: '0', sg: '0' }))];
  assert.deepEqual(recloserState(impl, spans),
    { capacity: '250', definition: 'RecDef_Standard_withCommFail', switchMode: false, sources });
  const moved = [{ src: 'F6878.ID', sg: '2' }, { src: 'R3472_Connector.ID', sg: '1' }, ...sources.slice(2)];
  const next = patchRecloser(impl, 'R6895', spans,
    { capacity: '315', definition: 'RecDef_Switch_withCommFail', switchMode: true, sources: moved });
  // A call that leaves arguments out is written out in full, so SRC_B lands.
  assert.match(next, /R6895\.InitSettingsGroups\(\n\tSRC_A := F6878\.ID,\n\tSG_A := 2,\n\tSRC_B := R3472_Connector\.ID,\n\tSG_B := 1,/);
  assert.match(next, /\tSG_F := 0\);\n\nR6896/);
  assert.match(next, /\tDeviceDefinition\t:=\tRecDef_Switch_withCommFail\t,/);
  assert.match(next, /\tCapacity\t:=\t315\t,\n\tTempCapacity\t:=\t315\t,/);
  // DisplaySwitchMode lands right after the SCADA link, ahead of the settings groups.
  assert.match(next, /pFirst_Bi\t:=\t0\t\);\n\nR6895\.DisplaySwitchMode := TRUE;\n\nR6895\.InitSettingsGroups/);
  assert.match(next, /R6896\.init\(Name := 'R6896', Capacity := 250\);/); // the neighbour is untouched
  assert.deepEqual(recloserState(next, deviceIndex(next).get('r6895')),
    { capacity: '315', definition: 'RecDef_Switch_withCommFail', switchMode: true,
      sources: moved });
});

// --- the rest of an addition: AreaMap, fault logic, Feeders_Excluded --------

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'dacinit');
const faultClient = (n) => CLIENT_XML(`SEL_651R2_${n}`,
  [`SEL_651R2_${n}_DNP.BI_00000_RECLOSER_STATUS`, `SEL_651R2_${n}_DNP.BI_00038_FAULT_EVENT_AVAILABLE`],
  [`SEL_651R2_${n}_DNP.AI_00000_IA`,
    ...['IA', 'IB', 'IC', 'IG'].map((p, i) => `SEL_651R2_${n}_DNP.AI_000${18 + i}_${p}_FAULT_CURRENT`)],
  [`SEL_651R2_${n}_DNP.BO_00000_SS1`, `SEL_651R2_${n}_DNP.BO_00026_RETRIEVE_RELAY_EVENT`]);

/** Every wire's drawn path starts and ends on its pins (the geometry rule). */
function routesOnPins(cfc) {
  const bad = [];
  for (const conn of cfc.connections) {
    const pts = cfc.routePoints(conn.id);
    const from = cfc.pinPoint(conn.src);
    const to = cfc.pinPoint(conn.dst);
    const a = pts[0];
    const b = pts[pts.length - 1];
    const box = (pin) => cfc.pinOwner.get(pin).el.kind === 'box';
    if (box(conn.src) && (a.x !== from.x || a.y !== from.y)) bad.push(`${conn.id} start`);
    if (box(conn.dst) && (b.x !== to.x || b.y !== to.y)) bad.push(`${conn.id} end`);
  }
  return bad;
}
function wiring(cfc) {
  const end = (pin) => {
    const { el, side, i } = cfc.pinOwner.get(pin);
    return el.kind === 'box' ? `${el.name}.${el.pinNames[side === 'in' ? i : el.ins.length + i]}` : el.name;
  };
  return cfc.connections.map((c) => `${end(c.src)}->${end(c.dst)}`);
}

test('dacinit scheme: a recloser addition lands on the AreaMap, in fault logic and Feeders_Excluded', async () => {
  const { Cfc } = await import('../services/tools/dacinit/cfc.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacinit-scheme-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    const rtac = path.join(tmp, 'files', 'Bunkie.rtac');
    const fixture = async (name) => readFile(path.join(FIXTURES, name), 'utf8');
    const program = 'SEL_RTAC/Fault Logic/Bunkie/Coughlin_Sub/Circuit_6310_Fault_Current.xml';
    await writeProject(rtac, {
      'SEL_RTAC/DAC/Initializations/Init_Reclosers.xml': POU_XML('Init_Reclosers'),
      'SEL_RTAC/DAC/Initializations/Init_Feeders.xml': POU_XML('Init_Feeders'),
      'SEL_RTAC/DAC/Initializations/Init_Pseudo_Bkrs.xml': POU_XML('Init_Pseudo_Bkrs'),
      'SEL_RTAC/DAC/DeviceDeclarations.xml': GVL_XML,
      'SEL_RTAC/DAC/Feeders_Excluded.xml': POU_XML('Feeders_Excluded'),
      'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Recloser.xml': DEVDEF_XML('DevDef_Recloser', [['RecDef_Standard', 'typeRecloserDeviceDef']]),
      'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Feeder.xml': DEVDEF_XML('DevDef_Feeder', [['FdrDef_Standard', 'typeFeederDeviceDef']]),
      'SEL_RTAC/DAC/DeviceDefinitions/DevDef_PseudoBkr.xml': DEVDEF_XML('DevDef_PseudoBkr', [['PseudoBkr_Std', 'typePseudoBreakerDeviceDef']]),
      'SEL_RTAC/DAC/AreaMap.xml': await fixture('AreaMap.xml'),
      [program]: await fixture('Circuit_6310_Fault_Current.xml'),
      'SEL_RTAC/Fault Logic/Fault_Data.xml': await fixture('Fault_Data.xml'),
      'SEL_RTAC/Tag Processor.xml': await fixture('Tag Processor.xml'),
      'SEL_RTAC/Substations/Coughlin_Sub/Circuit_6310/SEL_651R2_6267_DNP.xml': faultClient('6267'),
      'SEL_RTAC/Substations/Coughlin_Sub/Circuit_6310/SEL_651R2_6268_DNP.xml': faultClient('6268'),
      'SEL_RTAC/Substations/SCADA/DMS_POINTS_DNP.xml': MAP_XML('DMS_POINTS',
        ['6267', '6268'].map((n) => `DMS_POINTS_DNP.SEL_651R2_${n}_BI_00000_RECLOSER_STATUS`)
          .concat(['7001', '7002'].map((n) => `DMS_POINTS_DNP.FEEDER_${n}_BI_00000_Armed`)),
        ['6267', '6268'].flatMap((n) => [`DMS_POINTS_DNP.SEL_651R2_${n}_AI_00000_IA`,
          ...['IA', 'IB', 'IC', 'IG'].map((p, i) => `DMS_POINTS_DNP.SEL_651R2_${n}_AI_000${18 + i}_${p}_FAULT_CURRENT`)]),
        ['6267', '6268'].map((n) => `DMS_POINTS_DNP.SEL_651R2_${n}_BO_00000_SS1`)
          .concat(['7001', '7002'].map((n) => `DMS_POINTS_DNP.FEEDER_${n}_BO_00000_Exclude_CMD`))),
    });

    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const jobs = new JobRegistry();
    const dacinit = new DacInitService({ workspace, jobs });
    const { job: jobId, run } = await dacinit.generate(files, {
      path: 'Bunkie.rtac',
      params: PROJ,
      // St Landry 2026: R6268 and R6267 go in between B6310 and R6318.
      reclosers: [
        // Typed with or without its letter: R6268 and F7001 are 6268 and 7001.
        recRow('R6268', { capacity: 170, aSide: 'B6310', bSide: 'R6318', sources: [] }),
        recRow('6267', { capacity: 170, aSide: 'R6268', bSide: 'R6318', sources: [] }),
        recRow('7003', { capacity: 170, aSide: 'B7002', bSide: 'none', sources: [] }),
      ],
      feedersBreakers: [
        { number: 'F7001', capacity: 400, breaker: 'pseudo', lockout: '15' },
        { number: '7002', capacity: 400, breaker: 'pseudo', lockout: '15' },
      ],
    });
    // What the form offers for A side / B side / feeds / sources.
    const { areaMap, clients } = await dacinit.lookup(files, 'Bunkie.rtac');
    assert.deepEqual(areaMap.find((b) => b.name === 'B6310'), { name: 'B6310', kind: 'breaker', feeds: ['R6315', 'R6318'] });
    assert.deepEqual(areaMap.find((b) => b.name === 'R6315_Connector'), { name: 'R6315_Connector', kind: 'connector', feeds: ['R6315'] });
    assert.deepEqual(clients, ['SEL_651R2_6267', 'SEL_651R2_6268']);

    const job = await settled(jobs.get(jobId));
    assert.equal(job.status, 'done', job.error ?? '');
    const { wired } = job.result;
    assert.deepEqual(wired.areaMap, [
      { name: 'F7001', where: 'new row' },
      { name: 'F7002', where: 'new row' },
      { name: 'R6268', where: 'between B6310 and R6318' },
      { name: 'R6267', where: 'between R6268 and R6318' },
      { name: 'R7003', where: 'after B7002' },
    ]);
    assert.deepEqual(wired.faults.map((f) => [f.name, f.program]), [
      ['R6268', 'Circuit_6310_Fault_Current'], ['R6267', 'Circuit_6310_Fault_Current']]);
    // F7001 feeds nothing past its breaker; F7002 has R7003.
    assert.deepEqual(wired.excluded, ['F7001']);
    assert.match(job.result.note, /wire SCADA map, AreaMap, fault logic, Feeders_Excluded/);
    // R7003 is the one recloser the map doesn't carry yet.
    assert.deepEqual(wired.scada.map((s) => [s.name, s.group, s.template]), [['R7003', 'SEL_651R2_7003', 'SEL_651R2_6268']]);
    assert.ok(!job.result.warnings.some((w) => /AreaMap|fault|Tag Processor/i.test(w.message)),
      JSON.stringify(job.result.warnings));

    const out = path.join(await workspace.runDir('dacinit', run), 'Bunkie.rtac');
    const map = new Cfc(await readFile(path.join(out, 'SEL_RTAC/DAC/AreaMap.xml'), 'utf8'));
    const wires = wiring(map);
    for (const w of ['B6310.B->R6268.A', 'R6268.B->R6267.A', 'R6267.B->R6318.A', 'F7001.B->B7001.A', 'B7002.B->R7003.A']) {
      assert.ok(wires.includes(w), w);
    }
    assert.ok(!wires.includes('B6310.B->R6318.A'));
    assert.deepEqual(routesOnPins(map), []);
    // R6318 moved right to make room, by two boxes.
    assert.equal(map.box('R6318').x, 34 + 2 * 18);

    const faults = new Cfc(await readFile(path.join(out, program), 'utf8'));
    assert.match(faults.declaration, /SEL_651R2_6268 : Fault_Three_Phase_Data;\s*SEL_651R2_6267 : Fault_Three_Phase_Data;/);
    const fw = wiring(faults);
    assert.ok(fw.includes('SEL_651R2_6267_DNP.BI_00038_FAULT_EVENT_AVAILABLE->SEL_651R2_6267.BI_Event_Available'));
    assert.ok(fw.includes('SEL_651R2_6267.Fault_Current_G->Fault_Data.SEL_651R2_6267_IG_FAULT_CURRENT'));
    assert.ok(fw.includes('SEL_651R2_6268_DNP.BO_00026_RETRIEVE_RELAY_EVENT->SEL_651R2_6268.BO_Retrieve_Event_Command'));
    assert.deepEqual(routesOnPins(faults), []);

    const fd = await readFile(path.join(out, 'SEL_RTAC/Fault Logic/Fault_Data.xml'), 'utf8');
    assert.equal((fd.match(/<Row>/g) ?? []).length, 12);
    assert.match(fd, /<Value>Fault_Data\.SEL_651R2_6267_IG_FAULT_CURRENT<\/Value>/);
    assert.deepEqual([...fd.matchAll(/<Quantity>(\d+)<\/Quantity>/g)].map((m) => m[1]), ['4', '8']);
    const tp = await readFile(path.join(out, 'SEL_RTAC/Tag Processor.xml'), 'utf8');
    assert.match(tp, /<Value>DMS_POINTS_DNP\.SEL_651R2_6268_AI_00021_IG_FAULT_CURRENT<\/Value>\s*<\/Setting>\s*<Setting>\s*<Column>DTDataType<\/Column>\s*<Value>MV<\/Value>\s*<\/Setting>\s*<Setting>\s*<Column>SourceExpression<\/Column>\s*<Value>Fault_Data\.SEL_651R2_6268_IG_FAULT_CURRENT<\/Value>/);

    const ex = readImplementation(await readFile(path.join(out, 'SEL_RTAC/DAC/Feeders_Excluded.xml'), 'utf8'));
    assert.match(ex, /IF F7001\.Outputdata\.Excluded = FALSE THEN\n\tDMS_POINTS_DNP\.FEEDER_7001_BO_00000_Exclude_CMD\.operClose\.ctlVal:= TPInst\.Q;\nEND_IF/);
    assert.doesNotMatch(ex, /F7002/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('dacinit areamap: B side is required, a list takes over several branches, none ends the line', async () => {
  const { Cfc } = await import('../services/tools/dacinit/cfc.js');
  const { placeOnAreaMap } = await import('../services/tools/dacinit/areamap.js');
  const fresh = async () => new Cfc(await readFile(path.join(FIXTURES, 'AreaMap.xml'), 'utf8'));

  // B6310 branches to R6318 and R6315; R7020 goes in front of both.
  const map = await fresh();
  const { placed, problems } = placeOnAreaMap(map, [
    { kind: 'recloser', name: 'R7020', aSide: 'B6310', bSide: 'R6318, R6315' },
    { kind: 'recloser', name: 'R7021', aSide: 'R7020', bSide: 'none', open: false },
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(placed, [
    { name: 'R7020', where: 'between B6310 and R6318, R6315' },
    { name: 'R7021', where: 'after R7020' },
  ]);
  const wires = wiring(map);
  for (const w of ['B6310.B->R7020.A', 'R7020.B->R6318.A', 'R7020.B->R6315.A']) assert.ok(wires.includes(w), w);
  assert.ok(!wires.some((w) => /^B6310\.B->R63(18|15)/.test(w)), wires.join(' '));
  assert.deepEqual(routesOnPins(map), []);
  // Both re-fed rows moved clear of the new box.
  assert.ok(map.box('R6318').x > map.box('R7020').x && map.box('R6315').x > map.box('R7020').x);

  const bad = placeOnAreaMap(await fresh(), [
    { kind: 'recloser', name: 'R7030', aSide: 'B6310', bSide: '' },
    { kind: 'recloser', name: 'R7031', aSide: 'B6310', bSide: 'R5914' },
    { kind: 'recloser', name: 'R7032', aSide: 'B6310, F6310', bSide: 'none' },
    { kind: 'recloser', name: 'R7033', aSide: 'R6318', bSide: 'R5914, R6315', open: true },
  ]);
  assert.deepEqual(bad.placed, []);
  assert.deepEqual(bad.problems.map((p) => p.message.replace('not placed on the AreaMap: ', '')), [
    'give the B side (or none)',
    'B6310 is not wired to R5914 (it feeds R6315, R6318)',
    'one A side',
    'a tie has one B side',
  ]);
});

test('dacinit scada map: a copied block is numbered after each page and its AddItems grow', async () => {
  const { cloneBlock, readMap, renumber } = await import('../services/tools/dacinit/scadamap.js');
  const row = (tag, point) => `        <Row>
          <Setting><Column>Tag Name</Column><Value>${tag}</Value></Setting>
          <Setting><Column>Point Number</Column><Value>${point}</Value></Setting>
        </Row>\n`;
  const page = (name, ranges, rows) => `      <SettingPage>
        <Name>${name}</Name>
        <Commands>
${ranges.map(([s, q]) => `          <AddItems>\n            <Start>${s}</Start>\n            <Quantity>${q}</Quantity>\n          </AddItems>`).join('\n')}
        </Commands>
${rows.join('')}      </SettingPage>\n`;
  const xml = `<RTACModule>\n  <TagList>\n    <SettingPages>\n`
    + page('Binary Inputs', [[0, 2], [10, 2]], [row('M_DNP.DAC_BI_00000_On', 0), row('M_DNP.DAC_BI_00001_Off', 1),
      row('M_DNP.SEL_651R2_6315_BI_00000_RECLOSER_STATUS', 10), row('M_DNP.SEL_651R2_6315_BI_00001_TRIP', 11)])
    + page('Binary Outputs', [[0, 2]], ['status', 'operPulse'].map((m) => row(`M_DNP.SEL_651R2_6315_BO_00000_SS1.${m}`, 0))
      .concat(['status', 'operPulse'].map((m) => row(`M_DNP.SEL_651R2_6315_BO_00001_SS2.${m}`, 1))))
    + '    </SettingPages>\n  </TagList>\n</RTACModule>\n';
  const map = readMap(xml);
  assert.equal(renumber('SEL_651R2_6315_', '6268'), 'SEL_651R2_6268_');
  assert.equal(renumber('SEL_651R2_R042_', '6268'), 'SEL_651R2_R6268_');
  assert.equal(renumber('FDR_6421A_', '7001'), 'FDR_7001_');
  const { xml: out, tags } = cloneBlock(xml, map, map.blocks.get('sel_651r2_6315_'), 'SEL_651R2_6268_');
  const got = readMap(out);
  const block = got.blocks.get('sel_651r2_6268_');
  assert.deepEqual(block.rows.map(({ page: p, row: r }) => `${p[7]}${r.point} ${r.tag}`), [
    'I12 M_DNP.SEL_651R2_6268_BI_00000_RECLOSER_STATUS', 'I13 M_DNP.SEL_651R2_6268_BI_00001_TRIP',
    // Six-rows-a-point outputs keep their spacing.
    'O2 M_DNP.SEL_651R2_6268_BO_00000_SS1.status', 'O2 M_DNP.SEL_651R2_6268_BO_00000_SS1.operPulse',
    'O3 M_DNP.SEL_651R2_6268_BO_00001_SS2.status', 'O3 M_DNP.SEL_651R2_6268_BO_00001_SS2.operPulse']);
  assert.deepEqual([...out.matchAll(/<Start>(\d+)<\/Start>\s*<Quantity>(\d+)/g)].map((m) => `${m[1]}+${m[2]}`), ['0+2', '10+4', '0+4']);
  assert.equal(tags.BI[0].member, 'SEL_651R2_6268_BI_00000_RECLOSER_STATUS');
  // The template is untouched.
  assert.equal(got.blocks.get('sel_651r2_6315_').rows.length, 6);
});

test('dacinit connectors: a tie with its connector, on a new manager and an existing one', async () => {
  const { Cfc } = await import('../services/tools/dacinit/cfc.js');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-dacinit-conn-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    const rtac = path.join(tmp, 'files', 'Bunkie.rtac');
    const connPou = POU_XML('Init_DA_Connector')
      .replace('VAR\n', "VAR\n\tBunkie_IPs : ARRAY[1..1] OF IpAdrStr := ['192.168.199.21'];\n\tEunice_IPs : ARRAY[1..1] OF IpAdrStr := ['192.168.199.22'];\n")
      .replace('<Implementation><![CDATA[', `<Implementation><![CDATA[Bunkie_Eunice_Manager.Init(
	RemoteDacName		:=	'Eunice',
	DeviceDefinition	:=	DA_Manager );
Bunkie_Eunice_Manager.InitBackplane(
	Port		:=	59056,
	LocalIps	:=	Bunkie_IPs,
	RemoteIps	:=	Eunice_IPs);
Bunkie_Eunice_Manager.InitDaScadaLink(
	pFirst_Bi	:=	ADR(DMS_POINTS_DNP.Bunkie_Eunice_Manager_BI_00000_CommFail),
	pFirst_Ai	:=	0, pFirst_Bo	:=	0, pFirst_Ao	:=	0, pFirst_Cnt	:=	0);
R6315_Connector.Init(
	Name				:=	'C6315',
	DeviceDefinition	:=	DA_Connector,
	Manager				:=	Bunkie_Eunice_Manager);
R6315_Connector.InitDaScadaLink(
	pFirst_Bi	:=	ADR(DMS_POINTS_DNP.R6315_Connector_BI_00000_Abnormal),
	pFirst_Ai	:=	0, pFirst_Bo	:=	0, pFirst_Ao	:=	0, pFirst_Cnt	:=	0);`);
    await writeProject(rtac, {
      'SEL_RTAC/DAC/Initializations/Init_Reclosers.xml': POU_XML('Init_Reclosers'),
      'SEL_RTAC/DAC/Initializations/Init_DA_Connector.xml': connPou,
      'SEL_RTAC/DAC/DeviceDeclarations.xml': GVL_XML,
      'SEL_RTAC/DAC/AreaControl.xml': POU_XML('AreaControl').replace('<Implementation><![CDATA[', "<Implementation><![CDATA[DA_CONTROLLER.Init(\n\tName := 'Bunkie');"),
      'SEL_RTAC/DAC/DeviceDefinitions/DevDef_Recloser.xml': DEVDEF_XML('DevDef_Recloser', [['RecDef_Standard', 'typeRecloserDeviceDef']]),
      'SEL_RTAC/DAC/DeviceDefinitions/DevDef_DA_Connector.xml': DEVDEF_XML('DevDef_DA_Connector',
        [['DA_Connector', 'typeDacInterconnectDeviceDef'], ['DA_Manager', 'typeDacInterconnectManagerDeviceDef']]),
      'SEL_RTAC/DAC/AreaMap.xml': await readFile(path.join(FIXTURES, 'AreaMap.xml'), 'utf8'),
      'SEL_RTAC/Substations/Coughlin_Sub/Circuit_6310/SEL_651R2_7010_DNP.xml': faultClient('7010'),
      'SEL_RTAC/Substations/SCADA/DMS_POINTS_DNP.xml': MAP_XML('DMS_POINTS',
        ['DMS_POINTS_DNP.SEL_651R2_6315_BI_00000_RECLOSER_STATUS', 'DMS_POINTS_DNP.Bunkie_Eunice_Manager_BI_00000_CommFail',
          'DMS_POINTS_DNP.Bunkie_Eunice_Manager_BI_00001_RemoteDacEnabled', 'DMS_POINTS_DNP.R6315_Connector_BI_00000_Abnormal',
          'DMS_POINTS_DNP.R6315_Connector_BI_00001_CommAlarm'],
        ['DMS_POINTS_DNP.SEL_651R2_6315_AI_00000_IA'], ['DMS_POINTS_DNP.SEL_651R2_6315_BO_00000_SS1']),
    });

    const workspace = new ToolsWorkspace({ dataDir: tmp });
    await workspace.init();
    const jobs = new JobRegistry();
    const dacinit = new DacInitService({ workspace, jobs });
    const { job: jobId, run } = await dacinit.generate(files, {
      path: 'Bunkie.rtac',
      params: PROJ,
      reclosers: [recRow('7010', { capacity: 170, aSide: 'R6318', bSide: 'none', normallyOpen: true, sources: [] })],
      connectors: [
        { feeds: 'R7010', remoteDac: 'Pineville', port: '59052', remoteIp: '192.168.199.25' },
        { name: 'R5914_Connector', feeds: 'R5914', remoteDac: 'eunice' },
      ],
    });
    const job = await settled(jobs.get(jobId));
    assert.equal(job.status, 'done', job.error ?? '');
    const { wired, added, warnings } = job.result;
    assert.deepEqual(added.connectors, ['R7010_Connector', 'R5914_Connector']);
    // R5914 is fed from both sides already.
    assert.deepEqual(warnings, [{ device: 'R5914_Connector', message: 'not placed on the AreaMap: R5914 has no free input' }]);
    assert.deepEqual(wired.scada.map((s) => s.group), ['SEL_651R2_7010', 'R7010_Connector', 'Bunkie_Pineville_Manager', 'R5914_Connector']);
    assert.deepEqual(wired.areaMap.map((p) => [p.name, p.where]), [['R7010', 'tie after R6318'], ['R7010_Connector', 'feeding R7010']]);

    const out = path.join(await workspace.runDir('dacinit', run), 'Bunkie.rtac');
    const xml = await readFile(path.join(out, 'SEL_RTAC/DAC/Initializations/Init_DA_Connector.xml'), 'utf8');
    const impl = readImplementation(xml);
    assert.match(impl, /Bunkie_Pineville_Manager\.Init\(\n\tRemoteDacName\t\t:=\t'Pineville',[^\n]*\n\tDeviceDefinition\t:=\tDA_Manager\);/);
    assert.match(impl, /Port\t\t:=\t59052,[^\n]*\n\tLocalIps\t:=\tBunkie_IPs,\n\tRemoteIps\t:=\tPineville_IPs\);/);
    assert.match(impl, /pFirst_Bi\t:=\tADR\(DMS_POINTS_DNP\.Bunkie_Pineville_Manager_BI_00000_CommFail\),/);
    assert.match(impl, /R7010_Connector\.Init\(\n\tName\t\t\t\t:=\t'C7010',[^\n]*\n\tDeviceDefinition\t:=\tDA_Connector,\n\tManager\t\t\t\t:=\tBunkie_Pineville_Manager\);/);
    assert.match(impl, /R5914_Connector\.Init\([\s\S]*?Manager\t\t\t\t:=\tBunkie_Eunice_Manager\);\nR5914_Connector\.InitDaScadaLink\(\n\tpFirst_Bi\t:=\tADR\(DMS_POINTS_DNP\.R5914_Connector_BI_00000_Abnormal\),/);
    assert.equal((impl.match(/Bunkie_Pineville_Manager\.Init\(/g) ?? []).length, 1);
    assert.match(xml, /\tPineville_IPs : ARRAY\[1\.\.1\] OF IpAdrStr := \['192\.168\.199\.25'\];\nEND_VAR/);

    const decl = await readFile(path.join(out, 'SEL_RTAC/DAC/DeviceDeclarations.xml'), 'utf8');
    assert.match(decl, /\tBunkie_Pineville_Manager : DA_DAC_INTERCONNECT_MANAGER;\n\n\tR7010_Connector, R5914_Connector : DA_DAC_INTERCONNECT;/);

    const map = new Cfc(await readFile(path.join(out, 'SEL_RTAC/DAC/AreaMap.xml'), 'utf8'));
    const wires = wiring(map);
    assert.ok(wires.includes('R6318.B->R7010.A'), wires.join(' '));
    assert.ok(wires.includes('R7010_Connector.B->R7010.B'), wires.join(' '));
    assert.deepEqual(routesOnPins(map), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
