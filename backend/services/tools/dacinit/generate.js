// Structured-Text generators for the DAC device initializations, ported
// faithfully from the "DAC Inits" macro-enabled workbook (the VBA modules
// Reclosers/Transformers/Feeders/Breakers). Each device row expands into the
// exact `.Init(...)` call block the engineer used to generate in Excel and
// paste into the RTAC project's Init_* POUs. Pure functions, no I/O — the
// service layer decides where the text lands.
//
// Formatting matches the pasted-from-Excel convention: the call header sits at
// the left margin, parameters are one tab in. Structured Text is
// whitespace- and case-insensitive and AcSELerator reformats on import, so the
// goal here is faithful CONTENT (device names, definitions, pointer targets,
// counts), not byte-identical whitespace.

const TAB = '\t';

/** VBA writes booleans as the sheet's "True"/"False" text uppercased. */
function boolText(v) {
  return v ? 'TRUE' : 'FALSE';
}

/** MRound(x, 1) — round to the nearest whole number (Excel banker's-free). */
function mround1(x) {
  return Math.round(x);
}

function param(name, value) {
  return `${TAB}${name} := ${value},`;
}
function lastParam(name, value) {
  return `${TAB}${name} := ${value});`;
}

// --- reclosers (VBA: Reclosers.rInit) ---------------------------------------

// One recloser -> five statements: .Init, .initDaScadaLink, .DisplaySwitchMode,
// .InitSettingsGroups, .InitAutoMapScadaLink. Covers both project voltages the
// macro supports; 13.2kV is validated against the CLECO project, 34.5kV follows
// the macro branch-for-branch.
function recloserBlock(rec, proj) {
  const n = String(rec.number);
  const R = `R${n}`;
  const prefix = proj.recPrefix;
  const scada = proj.scadaMap;
  const is345 = proj.voltage === '34.5kV';
  const sw = !!rec.switch;
  const commFail = !!rec.commFail;
  const lines = [];

  // .Init header + comment (the "Circuit" column).
  lines.push(`${R}.Init(${rec.circuit ? ` // ${rec.circuit}` : ''}`);
  lines.push(param('Name', `'${R}'`));

  // DeviceDefinition depends on voltage + switch (+ commFail on 34.5kV).
  let def;
  if (is345) {
    if (sw && commFail) def = 'RecDef_Switch_withCommFail';
    else if (sw) def = 'RecDef_Switch';
    else if (commFail) def = 'RecDef_Standard_withCommFail';
    else def = 'RecDef_Standard';
  } else {
    def = sw ? 'Rec_SEL_651R_Downline_Sw' : 'Rec_SEL_651R_Downline';
  }
  lines.push(param('DeviceDefinition', def));
  lines.push(param('NormallyOpen', boolText(rec.normallyOpen)));
  lines.push(param('Capacity', rec.capacity));
  lines.push(param('TempCapacity', rec.capacity));
  lines.push(param('SideA_PT_Set', rec.sideAPtSet));
  lines.push(param('SideB_PT_Set', rec.sideBPtSet));

  // Field-side DNP pointers. On 34.5kV the point names and (for switches) the
  // instance naming differ; 13.2kV uses the A-phase status / DAC_TRIP_CLOSE set.
  const inst345 = sw ? `${prefix}_${rec.specialPrefix}_DNP._${n}` : `${prefix}_${n}_DNP`;
  if (is345) {
    const base = sw ? inst345 : `${prefix}_${n}_DNP`;
    lines.push(param('pFieldFirst_Bi', `ADR(${base}.BI_00000_RECLOSER_STATUS)`));
    lines.push(param('pFieldFirst_Ai', `ADR(${base}.AI_00000_IA)`));
    lines.push(param('pFieldFirst_Bo', `ADR(${base}.BO_00000_SS1)`));
  } else {
    lines.push(param('pFieldFirst_Bi', `ADR(${prefix}_${n}_DNP.BI_00000_A_PHASE_STATUS)`));
    lines.push(param('pFieldFirst_Ai', `ADR(${prefix}_${n}_DNP.AI_00000_IA)`));
    lines.push(param('pFieldFirst_Bo', `ADR(${prefix}_${n}_DNP.BO_00000_DAC_TRIP_CLOSE)`));
  }
  lines.push(param('pFieldFirst_Ao', '0'));
  lines.push(param('pFieldFirst_Cnt', '0'));

  // Diagnostic POU pointers. On 34.5kV with commFail the macro keys these off
  // the special-prefix column; otherwise off the device number.
  const pouName = is345 && commFail ? `${prefix}_${rec.specialPrefix}_DNP_POU`
    : `${prefix}_${n}_DNP_POU`;
  lines.push(param('pDeviceOffline', `ADR(${pouName}.Offline)`));
  lines.push(param('pPoll', `ADR(${pouName}.Poll_Integrity_Obj_60_Cls_1230)`));
  lines.push(lastParam('pMessageReceivedCount', `ADR(${pouName}.Message_Received_Count)`));
  lines.push('');

  // .initDaScadaLink -> the SCADA master map.
  const scadaBase = `${scada}_DNP.${prefix}_${n}`;
  const biPt = is345 ? 'BI_00000_RECLOSER_STATUS' : 'BI_00000_A_PHASE_STATUS';
  const boPt = is345 ? 'BO_00000_SS1' : 'BO_00000_DAC_TRIP_CLOSE';
  lines.push(`${R}.initDaScadaLink(`);
  lines.push(param('pFirst_Bi', `ADR(${scadaBase}_${biPt})`));
  lines.push(param('pFirst_Ai', `ADR(${scadaBase}_AI_00000_IA)`));
  lines.push(param('pFirst_Bo', `ADR(${scadaBase}_${boPt})`));
  lines.push(param('pFirst_Ao', '0'));
  lines.push(lastParam('pFirst_Cnt', '0'));
  lines.push('');

  // .DisplaySwitchMode
  lines.push(`${R}.DisplaySwitchMode := ${boolText(sw)};`);
  lines.push('');

  // .InitSettingsGroups -> up to six source feeders + setting groups.
  lines.push(`${R}.InitSettingsGroups(`);
  const srcNames = ['A', 'B', 'C', 'D', 'E', 'F'];
  const sources = rec.sources ?? [];
  srcNames.forEach((letter, idx) => {
    const src = sources[idx] ?? { feeder: 0, sg: 0 };
    const feeder = src.feeder;
    const isZero = feeder === 0 || feeder === '0' || feeder === '' || feeder == null;
    lines.push(param(`SRC_${letter}`, isZero ? '0' : `F${feeder}.ID`));
    const sgLine = `SG_${letter}`;
    if (idx === srcNames.length - 1) lines.push(lastParam(sgLine, src.sg ?? 0));
    else lines.push(param(sgLine, src.sg ?? 0));
  });
  lines.push('');

  // .InitAutoMapScadaLink -> SCADA map + DNP point counts.
  lines.push(`${R}.InitAutoMapScadaLink(`);
  lines.push(param('pFirst_Bi', `ADR(${scadaBase}_${biPt})`));
  lines.push(param('pFirst_Ai', `ADR(${scadaBase}_AI_00000_IA)`));
  lines.push(param('pFirst_Bo', `ADR(${scadaBase}_${boPt})`));
  lines.push(param('pFirst_Ao', '0'));
  lines.push(param('pFirst_Cnt', '0'));
  lines.push(param('NumBi', rec.numBi));
  lines.push(param('NumAi', rec.numAi));
  lines.push(param('NumBo', rec.numBo));
  lines.push(param('NumAo', rec.numAo));
  lines.push(lastParam('NumCnt', rec.numCnt));

  return lines.join('\n');
}

// --- transformers (VBA: Transformers.xInit) ---------------------------------

// Capacity = ((MVA * 1e6) / 13200 / 1.73) * 1.20, rounded to nearest 1 — the
// macro hardcodes the 13.2kV line voltage and the 1.73 sqrt(3) approximation.
function transformerBlock(xf, proj) {
  const sub = String(xf.substation).replace(/ /g, '_');
  const id = String(xf.transformer);
  const name = `XFMR_${sub}_${id}`;
  const cap = mround1(((Number(xf.ratedMva) * 1000000) / 13200 / 1.73) * 1.2);
  const lines = [];
  lines.push(`${name}.Init(`);
  lines.push(param('Name', `'${sub}_${id}_XFMR'`));
  lines.push(param('DeviceDefinition', 'Sub_XFMR'));
  lines.push(`${TAB}Capacity := ${cap}, // (${xf.ratedMva}MVA / 13.2kV / 1.73) * 1.20`);
  lines.push(param('TempCapacity', cap));
  lines.push(param('SourceGroup', '1'));
  lines.push(param('pFieldFirst_Bi', '0'));
  lines.push(param('pFieldFirst_Ai', '0'));
  lines.push(param('pFieldFirst_Bo', '0'));
  lines.push(param('pFieldFirst_Ao', '0'));
  lines.push(param('pFieldFirst_Cnt', '0'));
  lines.push(param('pDeviceOffline', `ADR(${xf.dnpClient}_DNP_POU.Offline)`));
  lines.push(lastParam('pMessageReceivedCount', `ADR(${xf.dnpClient}_DNP_POU.Message_Received_Count)`));
  return lines.join('\n');
}

// --- feeders (VBA: Feeders.fInit) -------------------------------------------

function feederBlock(fb, proj) {
  const n = String(fb.number);
  const F = `F${n}`;
  const scada = proj.scadaMap;
  const fdrPrefix = proj.fdrPrefix;
  const lines = [];
  lines.push(`${F}.Init(${fb.dnpClient ? ` // ${fb.dnpClient}` : ''}`);
  lines.push(param('Name', `'${F}'`));
  lines.push(param('DeviceDefinition', 'Feeder_Std'));
  lines.push(param('Capacity', fb.capacity));
  lines.push(param('TempCapacity', fb.capacity));
  lines.push(param('SourceGroup', '1'));
  lines.push(param('pFieldFirst_Bi', '0'));
  lines.push(param('pFieldFirst_Ai', '0'));
  lines.push(param('pFieldFirst_Bo', '0'));
  lines.push(param('pFieldFirst_Ao', '0'));
  lines.push(lastParam('pFieldFirst_Cnt', '0'));
  lines.push('');
  lines.push(`${F}.initDaScadaLink(`);
  lines.push(param('pFirst_Bi', `ADR(${scada}_DNP.${fdrPrefix}_${n}_BI_00000_Armed)`));
  lines.push(param('pFirst_Ai', '0'));
  lines.push(param('pFirst_Bo', `ADR(${scada}_DNP.${fdrPrefix}_${n}_BO_00000_Exclude_CMD)`));
  lines.push(param('pFirst_Ao', '0'));
  lines.push(lastParam('pFirst_Cnt', '0'));
  return lines.join('\n');
}

// --- breakers (VBA: Breakers.BkrInit, DAC branch) ---------------------------

// Breakers share the Feeders input table. "downstream" (the "Are there any
// downstream devices?" column) picks the 651R vs 351R device definition, the
// PT sets, and the status-point name.
function breakerBlock(fb, proj) {
  const n = String(fb.number);
  const B = `B${n}`;
  const scada = proj.scadaMap;
  const fdrPrefix = proj.fdrPrefix;
  const bkrPrefix = proj.bkrPrefix;
  const dnp = fb.dnpClient;
  const down = !!fb.downstream;
  const lines = [];
  lines.push(`${B}.init(${dnp ? ` // ${dnp}` : ''}`);
  lines.push(param('Name', `'${B}'`));
  lines.push(param('DeviceDefinition', down ? 'Rec_SEL_651R_Sub' : 'Rec_SEL_351R_Sub'));
  lines.push(param('NormallyOpen', boolText(fb.normallyOpen)));
  lines.push(param('Capacity', fb.capacity));
  lines.push(param('TempCapacity', fb.capacity));
  lines.push(param('SideA_PT_Set', down ? 'Set2' : 'Set1'));
  lines.push(param('SideB_PT_Set', down ? 'Set1' : 'NO_PT'));
  const statusPt = down ? 'BI_00000_A_PHASE_STATUS' : 'BI_00000_3_PHASE_STATUS';
  lines.push(param('pFieldFirst_Bi', `ADR(${dnp}_DNP.${bkrPrefix}_${n}_${statusPt})`));
  lines.push(param('pFieldFirst_Ai', `ADR(${dnp}_DNP.${bkrPrefix}_${n}_AI_00000_IA)`));
  lines.push(param('pFieldFirst_Bo', `ADR(${dnp}_DNP.${bkrPrefix}_${n}_BO_00000_DAC_TRIP_CLOSE)`));
  lines.push(param('pFieldFirst_Ao', '0'));
  lines.push(param('pFieldFirst_Cnt', '0'));
  lines.push(param('pDeviceOffline', `ADR(${dnp}_DNP_POU.Offline)`));
  lines.push(param('pPoll', `ADR(${dnp}_DNP_POU.Poll_Integrity_Obj_60_Cls_1230)`));
  lines.push(lastParam('pMessageReceivedCount', `ADR(${dnp}_DNP_POU.Message_Received_Count)`));
  lines.push(`${B}.initDaScadaLink(`);
  lines.push(param('pFirst_Bi', `ADR(${scada}_DNP.${fdrPrefix}_${n}_BI_00027_Breaker_CommandTimeout)`));
  lines.push(param('pFirst_Ai', '0'));
  lines.push(param('pFirst_Bo', `ADR(${scada}_DNP.${fdrPrefix}_${n}_BO_00004_Breaker_Inhibit_CMD)`));
  lines.push(param('pFirst_Ao', '0'));
  lines.push(lastParam('pFirst_Cnt', '0'));
  return lines.join('\n');
}

/** The name each device block declares/uses, for append-time de-duplication. */
function deviceName(kind, dev) {
  if (kind === 'recloser') return `R${dev.number}`;
  if (kind === 'transformer') return `XFMR_${String(dev.substation).replace(/ /g, '_')}_${dev.transformer}`;
  if (kind === 'feeder') return `F${dev.number}`;
  if (kind === 'breaker') return `B${dev.number}`;
  return null;
}

// --- declarations (VBA: DevDec.Device_Declarations, DAC branch) --------------

// The VAR_GLOBAL entry type for each device kind (reclosers and breakers are
// both DA_REC). The batch lists one line per kind, in this order.
const DECL_TYPE = { transformers: 'DA_SUB_TRANSFORMER', feeders: 'DA_FDR', breakers: 'DA_REC', reclosers: 'DA_REC' };
const DECL_ORDER = ['transformers', 'feeders', 'breakers', 'reclosers'];

/** The declaration names each requested device would add, grouped by kind. */
function declarationNames(payload) {
  const out = { reclosers: [], transformers: [], feeders: [], breakers: [] };
  for (const r of payload.reclosers ?? []) out.reclosers.push(deviceName('recloser', r));
  for (const x of payload.transformers ?? []) out.transformers.push(deviceName('transformer', x));
  for (const f of payload.feedersBreakers ?? []) {
    out.feeders.push(deviceName('feeder', f));
    out.breakers.push(deviceName('breaker', f));
  }
  return out;
}

/**
 * Build the VAR_GLOBAL declaration batch to insert before END_VAR — one line
 * per kind that has names, under a comment header, matching how the file's
 * existing batches read.
 */
function declarationBatch(namesByKind, header) {
  const lines = [];
  if (header) lines.push(`\t// ${header}`);
  for (const kind of DECL_ORDER) {
    const names = namesByKind[kind];
    if (names?.length) lines.push(`\t${names.join(', ')} : ${DECL_TYPE[kind]};`);
  }
  return lines.join('\n');
}

/**
 * Generate every requested init block: `{ name, text }` per device, grouped by
 * device kind (the caller routes each kind to its Init_* POU). A feeder/breaker
 * row describes both a feeder and a breaker, so it expands into two groups.
 */
function generateInits(payload) {
  const proj = payload.project ?? {};
  const feedersBreakers = payload.feedersBreakers ?? [];
  const group = (rows, kind, build) => rows.map((row) => ({
    name: deviceName(kind, row), text: build(row, proj),
  }));
  return {
    reclosers: group(payload.reclosers ?? [], 'recloser', recloserBlock),
    transformers: group(payload.transformers ?? [], 'transformer', transformerBlock),
    feeders: group(feedersBreakers, 'feeder', feederBlock),
    breakers: group(feedersBreakers, 'breaker', breakerBlock),
  };
}

export {
  recloserBlock,
  transformerBlock,
  feederBlock,
  breakerBlock,
  deviceName,
  generateInits,
  declarationNames,
  declarationBatch,
  DECL_ORDER,
};
