// The rest of a scheme addition, after the inits and declarations: the new
// devices (connectors too) go onto the AreaMap, new reclosers get fault reporting, and new
// 13.2kV feeders with nothing downline are added to Feeders_Excluded. Only
// devices this run ADDS are touched; an existing recloser being updated is
// already wired.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { placeOnAreaMap, hasDownline } from './areamap.js';
import { Cfc } from './cfc.js';
import { addFaultLogic } from './faults.js';
import { appendImplementation, readImplementation, writeImplementation } from './pou.js';

const AREA_MAP = ['SEL_RTAC', 'DAC', 'AreaMap.xml'];
const EXCLUDED = ['SEL_RTAC', 'DAC', 'Feeders_Excluded.xml'];

const lower = (s) => String(s ?? '').toLowerCase();
const unwrapAdr = (ptr) => /^ADR\((.*)\)$/i.exec(String(ptr ?? '').trim())?.[1] ?? null;

/**
 * specs: resolveSpecs() output; added: { kind: [names] } of what the inits
 * step appended. Returns { areaMap, faults, excluded, warnings, preview }.
 */
async function wireScheme(rtacDir, project, specs, added, header) {
  const isAdded = (kind, name) => (added[kind] ?? []).some((n) => lower(n) === lower(name));
  const warnings = [];
  const preview = [];
  const out = { areaMap: [], faults: [], excluded: [] };

  // --- AreaMap -----------------------------------------------------------------
  const breakerOf = (number) => {
    const name = `B${number}`;
    if (specs.breakers.some((b) => b.name === name) && isAdded('breakers', name)) return { name, kind: 'breaker' };
    if (specs.pseudoBreakers.some((b) => b.name === name) && isAdded('pseudoBreakers', name)) return { name, kind: 'pseudo' };
    return null;
  };
  const requests = [
    ...specs.transformers.filter((t) => isAdded('transformers', t.name)).map((t) => ({ kind: 'transformer', name: t.name })),
    ...specs.feeders.filter((f) => isAdded('feeders', f.name)).map((f) => ({
      kind: 'feeder', name: f.name, aSide: f.aSide, breaker: breakerOf(f.name.slice(1)),
    })),
    ...specs.reclosers.filter((r) => isAdded('reclosers', r.name)).map((r) => ({
      kind: 'recloser', name: r.name, aSide: r.aSide, bSide: r.bSide, open: r.normallyOpen,
    })),
    ...specs.connectors.filter((c) => isAdded('connectors', c.name)).map((c) => ({
      kind: 'connector', name: c.name, feeds: c.feeds,
    })),
  ];
  const mapFile = path.join(rtacDir, ...AREA_MAP);
  let areaMap = null;
  if (requests.length) {
    const xml = await readFile(mapFile, 'utf8').catch(() => null);
    if (xml == null) {
      warnings.push({ device: 'AreaMap', message: `${AREA_MAP.join('/')} not found; devices not placed` });
    } else {
      areaMap = new Cfc(xml);
      const { placed, problems } = placeOnAreaMap(areaMap, requests);
      warnings.push(...problems);
      if (placed.length) {
        await writeFile(mapFile, areaMap.toXml());
        out.areaMap = placed;
        preview.push(`// ==== AreaMap.xml (+${placed.length}) ====\n\n${placed.map((p) => `${p.name}: ${p.where}`).join('\n')}`);
      }
    }
  }

  // --- fault reporting -----------------------------------------------------------
  const newReclosers = specs.reclosers.filter((r) => isAdded('reclosers', r.name));
  if (newReclosers.length) {
    const faults = await addFaultLogic(rtacDir, project, newReclosers);
    warnings.push(...faults.problems);
    out.faults = faults.done;
    if (faults.preview.length) preview.push(`// ==== Fault logic (+${faults.done.length}) ====\n\n${faults.preview.join('\n\n')}`);
  }

  // --- Feeders_Excluded ------------------------------------------------------
  // A feeder with nothing past its own breaker is excluded from DAC
  // operation (every 13.2kV scheme; 34.5kV schemes have no such program).
  const newFeeders = specs.feeders.filter((f) => isAdded('feeders', f.name));
  const exFile = path.join(rtacDir, ...EXCLUDED);
  const exXml = newFeeders.length ? await readFile(exFile, 'utf8').catch(() => null) : null;
  if (exXml != null) {
    let impl = readImplementation(exXml);
    const feedsSomething = (f) => {
      const bkr = `B${f.name.slice(1)}`;
      const known = areaMap && hasDownline(areaMap, f.name, bkr);
      if (known != null) return known;
      return specs.reclosers.some((r) => [lower(f.name), lower(bkr)].includes(lower(r.aSide)));
    };
    const blocks = [];
    for (const f of newFeeders) {
      if (new RegExp(`\\b${f.name}\\s*\\.\\s*Outputdata\\b`, 'i').test(impl) || feedsSomething(f)) continue;
      const tag = unwrapAdr(f.scada.bo);
      if (!tag) continue;
      blocks.push(`IF ${f.name}.Outputdata.Excluded = FALSE THEN\n\t${tag}.operClose.ctlVal:= TPInst.Q;\nEND_IF`);
      out.excluded.push(f.name);
    }
    if (blocks.length) {
      const text = `// ${header}\n${blocks.join('\n\n')}`;
      impl = appendImplementation(impl, text);
      await writeFile(exFile, writeImplementation(exXml, impl));
      preview.push(`// ==== Feeders_Excluded.xml (+${blocks.length}) ====\n\n${text}`);
    }
  }

  return { ...out, warnings, preview };
}

export { wireScheme };
