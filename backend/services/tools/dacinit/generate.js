// Structured-Text writers for the DAC device initializations. Each takes a
// fully resolved spec (resolve.js decides the definitions, pointers and
// counts from the project itself) and writes the same `.Init(...)` call block
// the "DAC Inits" workbook did and the CLECO schemes carry. Pure functions, no
// I/O.
//
// Formatting matches the pasted-from-Excel convention: the call header sits at
// the left margin, parameters are one tab in. Structured Text is
// whitespace- and case-insensitive and AcSELerator reformats on import, so the
// goal here is faithful CONTENT, not byte-identical whitespace.

import { connectorBlock } from './connectors.js';

const TAB = '\t';

/** VBA writes booleans as the sheet's "True"/"False" text uppercased. */
function boolText(v) {
  return v ? 'TRUE' : 'FALSE';
}

function param(name, value) {
  return `${TAB}${name} := ${value},`;
}
function lastParam(name, value) {
  return `${TAB}${name} := ${value});`;
}
const header = (call, comment) => `${call}(${comment ? ` // ${comment}` : ''}`;

/** The five field/SCADA pointer parameters of an Init or link call. */
function pointers(lines, prefix, ptr, last) {
  lines.push(param(`${prefix}_Bi`, ptr.bi ?? '0'));
  lines.push(param(`${prefix}_Ai`, ptr.ai ?? '0'));
  lines.push(param(`${prefix}_Bo`, ptr.bo ?? '0'));
  lines.push(param(`${prefix}_Ao`, '0'));
  lines.push(last ? lastParam(`${prefix}_Cnt`, '0') : param(`${prefix}_Cnt`, '0'));
}

function diagnostics(lines, pou, poll = true) {
  lines.push(param('pDeviceOffline', `ADR(${pou}.Offline)`));
  if (poll) lines.push(param('pPoll', `ADR(${pou}.Poll_Integrity_Obj_60_Cls_1230)`));
  lines.push(lastParam('pMessageReceivedCount', `ADR(${pou}.Message_Received_Count)`));
}

// --- reclosers ---------------------------------------------------------------

// One recloser -> five statements: .Init, .initDaScadaLink, .DisplaySwitchMode,
// .InitSettingsGroups, .InitAutoMapScadaLink.
function recloserBlock(rec) {
  const R = rec.name;
  const lines = [];
  lines.push(header(`${R}.Init`, rec.comment));
  lines.push(param('Name', `'${R}'`));
  lines.push(param('DeviceDefinition', rec.definition));
  lines.push(param('NormallyOpen', boolText(rec.normallyOpen)));
  lines.push(param('Capacity', rec.capacity));
  lines.push(param('TempCapacity', rec.capacity));
  lines.push(param('SideA_PT_Set', rec.ptA));
  lines.push(param('SideB_PT_Set', rec.ptB));
  pointers(lines, 'pFieldFirst', rec.field, false);
  diagnostics(lines, rec.pou);
  lines.push('');

  lines.push(`${R}.initDaScadaLink(`);
  pointers(lines, 'pFirst', rec.scada, true);
  lines.push('');

  lines.push(`${R}.DisplaySwitchMode := ${boolText(rec.switchMode)};`);
  lines.push('');

  lines.push(`${R}.InitSettingsGroups(`);
  rec.sources.forEach((src, idx) => {
    const letter = String.fromCharCode(65 + idx);
    lines.push(param(`SRC_${letter}`, src.src));
    lines.push(idx === rec.sources.length - 1 ? lastParam(`SG_${letter}`, src.sg) : param(`SG_${letter}`, src.sg));
  });
  lines.push('');

  const [numBi, numAi, numBo, numAo, numCnt] = rec.counts;
  lines.push(`${R}.InitAutoMapScadaLink(`);
  pointers(lines, 'pFirst', rec.scada, false);
  lines.push(param('NumBi', numBi));
  lines.push(param('NumAi', numAi));
  lines.push(param('NumBo', numBo));
  lines.push(param('NumAo', numAo));
  lines.push(lastParam('NumCnt', numCnt));
  return lines.join('\n');
}

// --- transformers ------------------------------------------------------------

function transformerBlock(xf) {
  const lines = [];
  lines.push(`${xf.name}.Init(`);
  lines.push(param('Name', `'${xf.label}'`));
  lines.push(param('DeviceDefinition', xf.definition));
  lines.push(`${TAB}Capacity := ${xf.capacity},${xf.capacityNote ? ` // ${xf.capacityNote}` : ''}`);
  lines.push(param('TempCapacity', xf.capacity));
  lines.push(param('SourceGroup', '1'));
  pointers(lines, 'pFieldFirst', {}, false);
  diagnostics(lines, xf.pou, false);
  return lines.join('\n');
}

// --- feeders -----------------------------------------------------------------

function feederBlock(fdr) {
  const F = fdr.name;
  const lines = [];
  lines.push(header(`${F}.Init`, fdr.comment));
  lines.push(param('Name', `'${F}'`));
  lines.push(param('DeviceDefinition', fdr.definition));
  lines.push(param('Capacity', fdr.capacity));
  lines.push(param('TempCapacity', fdr.capacity));
  lines.push(param('SourceGroup', '1'));
  pointers(lines, 'pFieldFirst', {}, true);
  lines.push('');
  lines.push(`${F}.initDaScadaLink(`);
  pointers(lines, 'pFirst', { bi: fdr.scada.bi, bo: fdr.scada.bo }, true);
  return lines.join('\n');
}

// --- substation breakers -----------------------------------------------------

function breakerBlock(bkr) {
  const B = bkr.name;
  const lines = [];
  lines.push(header(`${B}.init`, bkr.comment));
  lines.push(param('Name', `'${B}'`));
  lines.push(param('DeviceDefinition', bkr.definition));
  lines.push(param('NormallyOpen', boolText(bkr.normallyOpen)));
  lines.push(param('Capacity', bkr.capacity));
  lines.push(param('TempCapacity', bkr.capacity));
  lines.push(param('SideA_PT_Set', bkr.ptA));
  lines.push(param('SideB_PT_Set', bkr.ptB));
  pointers(lines, 'pFieldFirst', bkr.field, false);
  diagnostics(lines, bkr.pou);
  lines.push(`${B}.initDaScadaLink(`);
  pointers(lines, 'pFirst', { bi: bkr.scada.bi, bo: bkr.scada.bo }, true);
  return lines.join('\n');
}

// --- pseudo breakers ---------------------------------------------------------

// The feeder-head breaker of a scheme with no breaker relay of its own (every
// 34.5kV scheme, and a few 13.2kV feeders): no points, just a lockout period.
function pseudoBreakerBlock(bkr) {
  const B = bkr.name;
  const lines = [];
  lines.push(header(`${B}.init`, bkr.comment));
  lines.push(param('Name', `'${B}'`));
  lines.push(param('DeviceDefinition', bkr.definition));
  lines.push(param('LockoutPeriod', bkr.lockout));
  lines.push(param('Capacity', bkr.capacity));
  lines.push(lastParam('TempCapacity', bkr.capacity));
  return lines.join('\n');
}

// --- declarations (VBA: DevDec.Device_Declarations, DAC branch) --------------

// The VAR_GLOBAL entry type for each device kind (reclosers and substation
// breakers are both DA_REC). The batch lists the kinds in this order.
const DECL_TYPE = {
  transformers: 'DA_SUB_TRANSFORMER',
  feeders: 'DA_FDR',
  breakers: 'DA_REC',
  pseudoBreakers: 'DA_Pseudo_Bkr',
  reclosers: 'DA_REC',
  managers: 'DA_DAC_INTERCONNECT_MANAGER',
  connectors: 'DA_DAC_INTERCONNECT',
};
const DECL_ORDER = ['transformers', 'feeders', 'breakers', 'pseudoBreakers', 'reclosers', 'managers', 'connectors'];
// The schemes list at most eight devices per declaration line.
const DECL_PER_LINE = 8;

/**
 * Build the VAR_GLOBAL declaration batch to insert before END_VAR: a comment
 * header, then each kind's names eight to a line, kinds separated by a blank
 * line — the way the schemes' own batches read.
 */
function declarationBatch(namesByKind, comment) {
  const groups = [];
  for (const kind of DECL_ORDER) {
    const names = namesByKind[kind] ?? [];
    if (!names.length) continue;
    const lines = [];
    for (let i = 0; i < names.length; i += DECL_PER_LINE) {
      lines.push(`\t${names.slice(i, i + DECL_PER_LINE).join(', ')} : ${DECL_TYPE[kind]};`);
    }
    groups.push(lines.join('\n'));
  }
  return [comment ? `\t// ${comment}` : null, ...groups].filter(Boolean).join('\n\n');
}

const WRITERS = {
  reclosers: recloserBlock,
  transformers: transformerBlock,
  feeders: feederBlock,
  breakers: breakerBlock,
  pseudoBreakers: pseudoBreakerBlock,
  connectors: connectorBlock,
};

/** `{ name, text }` per spec, grouped by device kind (the WRITERS keys). */
function writeInits(specsByKind) {
  const out = {};
  for (const [kind, write] of Object.entries(WRITERS)) {
    out[kind] = (specsByKind[kind] ?? []).map((spec) => ({ name: spec.name, text: write(spec) }));
  }
  return out;
}

export {
  recloserBlock,
  transformerBlock,
  feederBlock,
  breakerBlock,
  pseudoBreakerBlock,
  writeInits,
  declarationBatch,
  DECL_ORDER,
};
