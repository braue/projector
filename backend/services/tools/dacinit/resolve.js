// Turn the tool's input rows into fully resolved init specs for generate.js,
// taking every definition, pointer and point count from the DAC project the
// devices are being added to (project.js). Where the project can't answer
// (a client not configured yet, a definition it doesn't declare) the spec
// falls back to the workbook's naming convention and says so in `warnings`, so
// the engineer sees exactly which lines were guessed rather than read.

import {
  breakerField, breakerScada, clientStruct, commonProfile, substationClient, conventions, definitionOf, feederScada,
  hasDefinition, recloserField, recloserScada, voltageFamily,
} from './project.js';
import { connectorName, planConnectors } from './connectors.js';

const SOURCE_SLOTS = 6;

// Per-family recloser definitions (VBA: Reclosers.rInit) and point counts,
// used where the project has no reclosers of that shape to copy counts from.
const FAMILY = {
  '13.2kV': {
    recloserDef: ({ sw }) => (sw ? 'Rec_SEL_651R_Downline_Sw' : 'Rec_SEL_651R_Downline'),
    status: 'BI_00000_A_PHASE_STATUS',
    command: 'BO_00000_DAC_TRIP_CLOSE',
    counts: () => ['69', '18', '13', '0', '0'],
  },
  '34.5kV': {
    recloserDef: ({ sw, commFail }) => `RecDef_${sw ? 'Switch' : 'Standard'}${commFail ? '_withCommFail' : ''}`,
    status: 'BI_00000_RECLOSER_STATUS',
    command: 'BO_00000_SS1',
    counts: (shared) => (shared ? ['65', '22', '34', '0', '0'] : ['47', '18', '34', '0', '0']),
  },
};

// Substation breaker relays (VBA: Breakers.BkrInit): definition, PT sets and
// the status point a missing client falls back to.
const BREAKERS = {
  '651R': { definition: 'Rec_SEL_651R_Sub', ptA: 'Set2', ptB: 'Set1', status: 'BI_00000_A_PHASE_STATUS' },
  '351R': { definition: 'Rec_SEL_351R_Sub', ptA: 'Set1', ptB: 'NO_PT', status: 'BI_00000_3_PHASE_STATUS' },
};

const isBlank = (v) => v == null || String(v).trim() === '';
const text = (v) => String(v ?? '').trim();

/** "15", "15s", "T#15S" -> "T#15S". */
function lockoutPeriod(value) {
  const v = text(value);
  if (!v) return 'T#15S';
  if (/^t#/i.test(v)) return v.toUpperCase();
  const secs = /^(\d+(?:\.\d+)?)\s*s?$/i.exec(v);
  return secs ? `T#${secs[1]}S` : v;
}

/** Which breaker a feeder row has: 651R / 351R relay, a pseudo breaker, or none. */
function breakerKind(row, family) {
  const v = text(row.breaker).toLowerCase();
  if (v === '651r' || v === '351r') return v.toUpperCase();
  if (v === 'pseudo' || v === 'none') return v;
  if (typeof row.downstream === 'boolean') return row.downstream ? '651R' : '351R';
  // The schemes' own default: 34.5kV feeders head on pseudo breakers.
  return family === '34.5kV' ? 'pseudo' : '651R';
}

/**
 * An existing recloser's definition with its switch mode set: the 13.2kV
 * Rec_SEL_651R_Downline <-> Rec_SEL_651R_Downline_Sw pair, and the 34.5kV
 * RecDef_Standard… <-> RecDef_Switch… pair keeping any suffix (_withCommFail,
 * _Forest_Hill). Null when the definition is neither shape.
 */
function switchDefinition(definition, on) {
  const def = String(definition ?? '');
  const low = /^(Rec_SEL_651R_Downline)(_sw)?$/i.exec(def);
  if (low) return on ? (low[2] ? def : `${low[1]}_Sw`) : low[1];
  const high = /^(RecDef_)(Standard|Switch)(.*)$/i.exec(def);
  if (high) return `${high[1]}${on ? 'Switch' : 'Standard'}${high[3]}`;
  return null;
}

/** Identifiers each input row produces, before anything is resolved. */
function rowNames(payload) {
  const family = payload.family ?? '13.2kV';
  const feeders = payload.feedersBreakers ?? [];
  return {
    reclosers: (payload.reclosers ?? []).map((r) => `R${text(r.number)}`),
    transformers: (payload.transformers ?? []).map((x) => transformerName(x).name),
    feeders: feeders.map((f) => `F${text(f.number)}`),
    breakers: feeders.filter((f) => /^[36]51R$/.test(breakerKind(f, family))).map((f) => `B${text(f.number)}`),
    pseudoBreakers: feeders.filter((f) => breakerKind(f, family) === 'pseudo').map((f) => `B${text(f.number)}`),
    connectors: (payload.connectors ?? []).map(connectorName).filter(Boolean),
  };
}

/** The first Binary Input of a map group ("F5905A_Conn"), as ADR() text. */
function groupPointer(project, group) {
  const key = `${group}_`.toLowerCase();
  for (const entry of project.structs) {
    if (entry.kind !== 'map') continue;
    const tag = entry.sections.BI.find((t) => t.group?.toLowerCase() === key);
    if (tag) return `ADR(${tag.struct}.${tag.member})`;
  }
  return null;
}

function transformerName(xf) {
  const sub = text(xf.substation).replace(/\s+/g, '_');
  const id = text(xf.transformer);
  return { name: `XFMR_${sub}_${id}`, label: `${sub}_${id}_XFMR`, sub };
}

/**
 * Resolve every row. `known(name)` says whether an identifier already exists
 * in the project (initialized or declared); the run's own new devices count
 * too, so a recloser can be sourced from a feeder added beside it.
 */
function resolveSpecs(payload, project, known) {
  const params = payload.params ?? {};
  const warnings = [];
  const warn = (device, message) => warnings.push({ device, message });
  const family = FAMILY[params.voltage] ? params.voltage : voltageFamily(project);
  const fam = FAMILY[family];
  const names = rowNames({ ...payload, family });
  const adding = new Set(Object.values(names).flat().map((n) => n.toLowerCase()));
  const exists = (name) => adding.has(name.toLowerCase()) || known(name);
  const declared = (device, definition) => {
    if (!hasDefinition(project, definition)) warn(device, `${definition} is not a device definition in this project`);
    return definition;
  };
  // Fallback names for points the project doesn't have yet: what the row's
  // parameters say, else what the project's maps already go by.
  const naming = conventions(project);
  const scadaMapName = text(params.scadaMap) || naming.scadaMap || 'DMS_MAP';
  const fdrPrefix = text(params.fdrPrefix) || naming.feederPrefix || 'FDR';
  const overrideCounts = ['numBi', 'numAi', 'numBo', 'numAo', 'numCnt'].map((key) => text(params[key]));

  // A settings-group source: a feeder number ("4094D" -> F4094D.ID), or any
  // identifier the project has (F4094D, R3472_Connector).
  const source = (device, slot, value) => {
    const v = text(value).replace(/\.ID$/i, '');
    if (!v || v === '0') return '0';
    // A typed identifier ("F4094D", "R3472_Connector") is taken as it is; a
    // bare number is a feeder's.
    const candidates = [...(/^[A-Za-z_]/.test(v) ? [v] : []), `F${v}`, `${v}_Connector`, `R${v}_Connector`];
    const hit = candidates.find(exists);
    if (!hit) warn(device, `SRC_${slot} ${v} is not a feeder or connector in this project`);
    return `${hit ?? (/^[A-Za-z_]/.test(v) ? v : `F${v}`)}.ID`;
  };

  const reclosers = (payload.reclosers ?? []).map((row) => {
    const n = text(row.number);
    const name = `R${n}`;
    const sw = !!row.switch;
    const client = text(row.dnpClient);
    const prefix = text(params.recPrefix) || 'SEL_651R2';

    const field = recloserField(project, n, client || null);
    let fieldPtr;
    let pou;
    if (field.problem) {
      const struct = client ? `${client.replace(/_DNP$/i, '')}_DNP` : `${prefix}_${n}_DNP`;
      fieldPtr = { bi: `ADR(${struct}.${fam.status})`, ai: `ADR(${struct}.AI_00000_IA)`, bo: `ADR(${struct}.${fam.command})` };
      pou = `${struct}_POU`;
      warn(name, `field points: ${field.problem}; wrote ${struct}`);
    } else {
      fieldPtr = field.field;
      pou = `${field.struct}_POU`;
    }

    const scada = recloserScada(project, n);
    let scadaPtr;
    if (scada.problem) {
      const base = `${scadaMapName}_DNP.${prefix}_${n}`;
      scadaPtr = { bi: `ADR(${base}_${fam.status})`, ai: `ADR(${base}_AI_00000_IA)`, bo: `ADR(${base}_${fam.command})` };
      warn(name, `SCADA points: ${scada.problem}; wrote ${base}_…`);
    } else {
      scadaPtr = scada.scada;
    }

    const shared = !field.problem && field.shared;
    const profile = commonProfile(project, shared) ?? fam.counts(shared);
    const counts = profile.map((v, i) => overrideCounts[i] || v);

    const sources = Array.from({ length: SOURCE_SLOTS }, (_, i) => {
      const src = row.sources?.[i] ?? {};
      return { src: source(name, String.fromCharCode(65 + i), src.feeder), sg: isBlank(src.sg) ? '0' : text(src.sg) };
    });

    return {
      name,
      comment: text(row.circuit),
      definition: declared(name, fam.recloserDef({ sw, commFail: !!row.commFail })),
      normallyOpen: !!row.normallyOpen,
      capacity: text(row.capacity),
      ptA: text(row.sideAPtSet ?? params.ptA) || 'Set2',
      ptB: text(row.sideBPtSet ?? params.ptB) || 'Set1',
      field: fieldPtr,
      pou,
      scada: scadaPtr,
      switchMode: sw,
      sources,
      counts,
      // For the AreaMap and fault logic, not the init block.
      number: n,
      struct: field.problem ? null : field.struct,
      shared,
      circuit: text(row.circuit),
      aSide: text(row.aSide),
      bSide: text(row.bSide),
    };
  });

  const xfmrDef = definitionOf(project, 'transformer');
  const transformers = (payload.transformers ?? []).map((row) => {
    const { name, label, sub } = transformerName(row);
    // A given client is taken as it is; otherwise the one named for the
    // substation, else the convention.
    let client = text(row.dnpClient);
    if (client) {
      if (!clientStruct(project, client)) warn(name, `no DNP client named ${client}`);
    } else {
      const found = substationClient(project, sub);
      client = found.client ?? found.candidates[0] ?? `${sub}_Sub`;
      if (found.problem) warn(name, `${found.problem}; wrote ${client}_DNP_POU`);
    }
    if (!xfmrDef) warn(name, 'the project declares no transformer definition; wrote Sub_XFMR');
    // Capacity = ((MVA * 1e6) / 13200 / 1.73) * 1.20, rounded to nearest 1 — the
    // workbook's formula and the note the schemes carry beside it.
    const mva = Number(row.ratedMva) || 0;
    return {
      name,
      label,
      definition: xfmrDef ?? 'Sub_XFMR',
      capacity: Math.round(((mva * 1000000) / 13200 / 1.73) * 1.2),
      capacityNote: `(${mva}MVA / 13.2kV / 1.73) * 1.20`,
      pou: `${client.replace(/_DNP$/i, '')}_DNP_POU`,
    };
  });

  const fdrDef = definitionOf(project, 'feeder');
  const pseudoDef = definitionOf(project, 'pseudoBreaker');
  const feeders = [];
  const breakers = [];
  const pseudoBreakers = [];
  for (const row of payload.feedersBreakers ?? []) {
    const n = text(row.number);
    const client = text(row.dnpClient);
    const scadaMap = `${scadaMapName}_DNP`;

    const fs = feederScada(project, n);
    if (!fs.bi || !fs.bo) warn(`F${n}`, `SCADA points: no Armed/Exclude_CMD tags for ${n} on a SCADA map; wrote ${scadaMap}.${fdrPrefix}_${n}_…`);
    if (!fdrDef) warn(`F${n}`, 'the project declares no feeder definition; wrote Feeder_Std');
    feeders.push({
      name: `F${n}`,
      aSide: text(row.aSide),
      comment: client,
      definition: fdrDef ?? 'Feeder_Std',
      capacity: text(row.capacity),
      scada: {
        bi: fs.bi ?? `ADR(${scadaMap}.${fdrPrefix}_${n}_BI_00000_Armed)`,
        bo: fs.bo ?? `ADR(${scadaMap}.${fdrPrefix}_${n}_BO_00000_Exclude_CMD)`,
      },
    });

    const kind = breakerKind(row, family);
    const B = `B${n}`;
    if (kind === 'pseudo') {
      if (!pseudoDef) warn(B, 'the project declares no pseudo-breaker definition; wrote PseudoBkr_Std');
      pseudoBreakers.push({
        name: B,
        comment: '',
        definition: pseudoDef ?? 'PseudoBkr_Std',
        lockout: lockoutPeriod(row.lockout),
        capacity: text(row.capacity),
      });
    } else if (BREAKERS[kind]) {
      const relay = BREAKERS[kind];
      const bkrPrefix = text(params.bkrPrefix) || 'BKR';
      const located = breakerField(project, n, client || null);
      let fieldPtr;
      let pou;
      if (located.problem) {
        const struct = `${client.replace(/_DNP$/i, '') || 'SUB'}_DNP`;
        const base = `${struct}.${bkrPrefix}_${n}`;
        fieldPtr = { bi: `ADR(${base}_${relay.status})`, ai: `ADR(${base}_AI_00000_IA)`, bo: `ADR(${base}_BO_00000_DAC_TRIP_CLOSE)` };
        pou = `${struct}_POU`;
        warn(B, `field points: ${located.problem}; wrote ${base}_…`);
      } else {
        fieldPtr = located.field;
        pou = `${located.struct}_POU`;
      }
      const bs = breakerScada(project, n);
      if (!bs.bi || !bs.bo) warn(B, `SCADA points: no CommandTimeout/Inhibit tags for ${n} on a SCADA map; wrote ${scadaMap}.${fdrPrefix}_${n}_…`);
      breakers.push({
        name: B,
        comment: client,
        definition: declared(B, relay.definition),
        normallyOpen: !!row.normallyOpen,
        capacity: text(row.capacity),
        ptA: relay.ptA,
        ptB: relay.ptB,
        field: fieldPtr,
        pou,
        scada: {
          bi: bs.bi ?? `ADR(${scadaMap}.${fdrPrefix}_${n}_BI_00027_Breaker_CommandTimeout)`,
          bo: bs.bo ?? `ADR(${scadaMap}.${fdrPrefix}_${n}_BO_00004_Breaker_Inhibit_CMD)`,
        },
      });
    }
  }

  // Connectors, and the manager each one hangs on.
  const connectorDef = definitionOf(project, 'connector');
  const managerDef = definitionOf(project, 'manager');
  const planned = planConnectors(payload.connectors ?? [], project, family);
  warnings.push(...planned.warnings);
  const connectors = planned.plans.map((plan) => {
    const scada = groupPointer(project, plan.name);
    if (!scada) warn(plan.name, `SCADA points: no ${plan.name} block on a SCADA map; wrote ${scadaMapName}_DNP.${plan.name}_BI_00000_Abnormal`);
    if (!connectorDef) warn(plan.name, 'the project declares no connector definition; wrote DA_Connector');
    let managerScada = null;
    if (plan.newManager) {
      managerScada = groupPointer(project, plan.manager.group);
      if (!managerScada) warn(plan.manager.name, `SCADA points: no ${plan.manager.group} block on a SCADA map; wrote ${scadaMapName}_DNP.${plan.manager.group}_BI_00000_CommFail`);
      if (!managerDef) warn(plan.manager.name, 'the project declares no manager definition; wrote DA_Manager');
    }
    return {
      name: plan.name,
      connection: plan.connection,
      definition: connectorDef ?? 'DA_Connector',
      manager: plan.manager,
      newManager: plan.newManager,
      managerDefinition: managerDef ?? 'DA_Manager',
      managerScada: plan.newManager ? (managerScada ?? `ADR(${scadaMapName}_DNP.${plan.manager.group}_BI_00000_CommFail)`) : null,
      scada: scada ?? `ADR(${scadaMapName}_DNP.${plan.name}_BI_00000_Abnormal)`,
      feeds: plan.feeds,
      vars: plan.vars,
    };
  });

  return { family, specs: { reclosers, transformers, feeders, breakers, pseudoBreakers, connectors }, warnings };
}

export { resolveSpecs, rowNames, breakerKind, lockoutPeriod, switchDefinition };
