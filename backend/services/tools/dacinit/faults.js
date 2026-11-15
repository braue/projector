// Fault-current reporting for new reclosers — the three places every CLECO
// scheme wires it, done the way the schemes do:
//
//  1. Fault_Data (a virtual tag list): four MV tags per recloser,
//     Fault_Data.<base>_IA/IB/IC/IG_FAULT_CURRENT, where <base> is the
//     recloser's DNP client name without _DNP (SEL_651R2_6267).
//  2. The circuit's fault program (Fault Logic/<sub>/Circuit_<n>_….xml, a
//     CFC): one Fault_Three_Phase_Data block per recloser, instance <base>,
//     fed from the client's event-available, fault-current and retrieve-event
//     points and writing the Fault_Data tags.
//  3. Tag Processor: one row per phase copying the Fault_Data tag to the
//     recloser's fault-current point on the SCADA map.
//
// Only a recloser on its own DNP client gets these (every scheme: ~600 such
// reclosers, all but a handful wired; reclosers sharing a client, none).
// Blocks are copies of a recloser block already in the project, renamed and
// re-pointed: each client tag is matched by section and description
// (BI_00038_FAULT_EVENT_AVAILABLE -> the new client's BI_…_FAULT_EVENT_AVAILABLE),
// so 13.2kV (RELAY_EVENT_AVAILABLE / LOAD_NEXT_EVENT) and 34.5kV
// (FAULT_EVENT_AVAILABLE / RETRIEVE_RELAY_EVENT) layouts both carry over.

import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Cfc } from './cfc.js';

const PHASES = ['IA', 'IB', 'IC', 'IG'];
const FB_TYPE = 'Fault_Three_Phase_Data';
const CIRCUIT = /(?:circuit|cicuit|circut)[ _]*(\d+[A-Za-z]?)(?![A-Za-z0-9])/i;
const CLUSTER_GAP = 5;

const lower = (s) => String(s ?? '').toLowerCase();
const circuitOf = (text) => CIRCUIT.exec(String(text ?? ''))?.[1]?.toUpperCase() ?? null;

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.xml$/i.test(e.name)) out.push(full);
  }
  return out;
}

/** The project's fault pieces: Fault_Data, the fault programs, Tag Processor. */
async function readFaultSetup(rtacDir) {
  const root = path.join(rtacDir, 'SEL_RTAC');
  const files = await walk(root);
  let faultData = null;
  const programs = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (!/^Fault[ _]Logic[\\/]/i.test(rel)) continue;
    const xml = await readFile(file, 'utf8');
    if (/<TagList>/.test(xml) && /<Name>Fault_Data<\/Name>/.test(xml)) { faultData = { file, xml }; continue; }
    if (!/<POUKind>Program<\/POUKind>/.test(xml) || !xml.includes('<ArchivedContent>')) continue;
    const instances = [...xml.matchAll(/(\w+)\s*:\s*Fault_(?:Three|Single)_Phase_Data\s*;/g)].map((m) => m[1]);
    programs.push({ file, xml, name: /<Name>([^<]*)<\/Name>/.exec(xml)[1], circuit: circuitOf(path.basename(file)), instances });
  }
  const tpFile = path.join(root, 'Tag Processor.xml');
  const tp = await readFile(tpFile, 'utf8').catch(() => null);
  return { faultData, programs, tagProcessor: tp == null ? null : { file: tpFile, xml: tp } };
}

// --- 1. Fault_Data rows -------------------------------------------------------

function inputsPage(xml) {
  const m = /<SettingPage>\s*<Name>Inputs<\/Name>[\s\S]*?<\/SettingPage>/.exec(xml);
  return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null;
}

function faultDataHas(xml, base) {
  return xml.toLowerCase().includes(`<value>fault_data.${lower(base)}_ia_fault_current</value>`);
}

function addFaultDataRows(xml, bases) {
  const page = inputsPage(xml);
  if (!page) throw new Error('Fault_Data has no Inputs page');
  let text = page.text;
  const rows = [...text.matchAll(/( *)<Row>[\s\S]*?<\/Row>/g)];
  const last = rows[rows.length - 1];
  if (!last) throw new Error('Fault_Data has no row to copy');
  const model = last[0].trimStart();
  const indent = last[1];
  const made = [];
  for (const base of bases) {
    for (const phase of PHASES) {
      made.push(model
        .replace(/(<Column>Tag Name<\/Column>\s*<Value>)[^<]*/, `$1Fault_Data.${base}_${phase}_FAULT_CURRENT`)
        .replace(/(<Column>Tag Alias<\/Column>\s*<Value>)[^<]*/, '$1')
        .replace(/(<Column>Comment<\/Column>\s*<Value>)[^<]*/, '$1'));
    }
  }
  const at = last.index + last[0].length;
  text = text.slice(0, at) + made.map((row) => `\n${indent}${row}`).join('') + text.slice(at);
  // The page's Commands list sizes it: one AddItems per batch of rows.
  const adds = [...text.matchAll(/( *)<AddItems>\s*<Quantity>\d+<\/Quantity>\s*<\/AddItems>/g)];
  const lastAdd = adds[adds.length - 1];
  if (lastAdd) {
    const block = lastAdd[0].trimStart().replace(/<Quantity>\d+<\/Quantity>/, `<Quantity>${made.length}</Quantity>`);
    const end = lastAdd.index + lastAdd[0].length;
    text = `${text.slice(0, end)}\n${lastAdd[1]}${block}${text.slice(end)}`;
  }
  return xml.slice(0, page.start) + text + xml.slice(page.end);
}

// --- 2. the circuit program block -----------------------------------------

/** A block and everything wired straight to it (its variable boxes). */
function cluster(cfc, box) {
  const pins = new Set([...box.ins, ...box.outs]);
  const conns = cfc.connections.filter((c) => pins.has(c.src) || pins.has(c.dst));
  const others = new Set(conns.map((c) => cfc.pinOwner.get(pins.has(c.src) ? c.dst : c.src)?.el).filter(Boolean));
  return { box, elements: [box, ...others], conns };
}

/** The new client's tag for a template tag "OLD_DNP.BI_00038_FAULT_EVENT_AVAILABLE". */
function retarget(text, from, to) {
  const [struct, member, ...rest] = text.split('.');
  if (lower(struct) === lower(`fault_data`) && member && lower(member).startsWith(`${lower(from.base)}_`)) {
    return `Fault_Data.${to.base}${member.slice(from.base.length)}`;
  }
  if (lower(struct) !== lower(from.struct) || !member) return text;
  const m = /^(BI|AI|BO)_\d{5}_(.+)$/i.exec(member);
  if (!m) throw new Error(`can't match ${text} on ${to.struct}`);
  const [, section, desc] = m;
  const hit = to.entry.sections[section.toUpperCase()]
    .find((t) => t.group === '' && new RegExp(`^${section}_\\d{5}_${desc}$`, 'i').test(t.member));
  if (!hit) throw new Error(`${to.struct} has no ${section.toUpperCase()} …_${desc} point`);
  return [`${to.struct}.${hit.member}`, ...rest].join('.');
}

function addDeclaration(cfc, name) {
  const decl = cfc.declaration;
  const end = /^\s*END_VAR/im.exec(decl);
  if (!end) throw new Error('program has no END_VAR');
  const head = decl.slice(0, end.index).replace(/\s*$/, '');
  cfc.declaration = `${head}\n\t${name} : ${FB_TYPE};\n${decl.slice(end.index).replace(/^\s*\n/, '\n')}`;
}

/** Copy `template` (a cluster of `source`) into `cfc` for recloser `to`. */
function addBlock(cfc, source, template, from, to) {
  const ys = cfc.elements.filter((el) => el.y != null && el.kind !== 'connection').map((el) => el.y);
  const minY = Math.min(...template.elements.map((el) => el.y));
  // The first block of an empty program sits at the top, as the schemes' do.
  const dy = ys.length ? Math.max(...ys) + CLUSTER_GAP - minY : 3 - minY;
  // Resolve every renamed text first, so a missing point leaves nothing half-built.
  const texts = template.elements.map((el) => (el === template.box ? to.base : retarget(el.name, from, to)));
  const pinMap = new Map();
  template.elements.forEach((el, i) => {
    const made = cfc.cloneElement(el, { x: el.x, y: el.y + dy });
    cfc.rename(made, texts[i]);
    el.ins.forEach((pin, k) => pinMap.set(pin, made.ins[k]));
    el.outs.forEach((pin, k) => pinMap.set(pin, made.outs[k]));
  });
  for (const conn of template.conns) {
    const pts = source.routePoints(conn.id);
    cfc.connect(pinMap.get(conn.src), pinMap.get(conn.dst), pts?.map((p) => ({ ...p, y: p.y + dy })));
  }
  addDeclaration(cfc, to.base);
  cfc.fitCanvas();
}

/** Find (or plan) the fault program for a recloser's circuit. */
function programFor(setup, circuit, clientDir, project) {
  if (circuit) {
    const hit = setup.programs.find((p) => p.circuit === circuit);
    if (hit) return { program: hit };
  }
  // A new circuit: a sibling program for another circuit of the same
  // substation gives the folder and the naming.
  const sub = path.dirname(clientDir);
  const siblings = setup.programs.filter((p) => p.instances.some((inst) => {
    const entry = project.structs.find((e) => e.kind === 'client' && lower(e.struct) === lower(`${inst}_DNP`));
    return entry && path.dirname(path.dirname(entry.file)) === sub;
  }));
  const sibling = siblings.find((p) => p.circuit) ?? null;
  if (!circuit || !sibling) return { problem: circuit ? `no fault program for circuit ${circuit}` : 'its circuit is unknown' };
  const name = sibling.name.replace(new RegExp(sibling.circuit, 'i'), circuit);
  return { create: { name, file: path.join(path.dirname(sibling.file), `${name}.xml`), sibling } };
}

function newProgram(sibling, name) {
  const xml = sibling.xml.replace(/<Name>[^<]*<\/Name>/, `<Name>${name}</Name>`);
  const cfc = new Cfc(xml);
  cfc.donor = new Cfc(sibling.xml);
  cfc.clear();
  cfc.declaration = `PROGRAM ${name}\nVAR\n\nEND_VAR\n`;
  return cfc;
}

// --- 3. Tag Processor rows -----------------------------------------------------

function addTagProcessorRows(xml, rows) {
  const all = [...xml.matchAll(/( *)<Row>[\s\S]*?<\/Row>/g)];
  const faults = all.filter((m) => /<Column>SourceExpression<\/Column>\s*<Value>Fault_Data\./.test(m[0]));
  const last = faults[faults.length - 1] ?? all[all.length - 1];
  if (!last) throw new Error('Tag Processor has no row to copy');
  let order = Math.max(0, ...all.map((m) => Number(/<Column>SolveOrder<\/Column>\s*<Value>(\d+)/.exec(m[0])?.[1] ?? 0)));
  const model = (faults[faults.length - 1] ?? last)[0].trimStart();
  const made = rows.map(({ dest, source }) => {
    order += 1;
    return model
      .replace(/(<Column>DestinationTagName<\/Column>\s*<Value>)[^<]*/, `$1${dest}`)
      .replace(/(<Column>SourceExpression<\/Column>\s*<Value>)[^<]*/, `$1${source}`)
      .replace(/(<Column>SolveOrder<\/Column>\s*<Value>)\d+/, `$1${order}`);
  });
  const at = last.index + last[0].length;
  return xml.slice(0, at) + made.map((row) => `\n${last[1]}${row}`).join('') + xml.slice(at);
}

/** The recloser's four fault-current points on the SCADA map, or a problem. */
function scadaFaultPoints(project, number) {
  const n = lower(number);
  const out = [];
  for (const entry of project.structs) {
    if (entry.kind !== 'map') continue;
    for (const phase of PHASES) {
      const tag = entry.sections.AI.find((t) => t.group && t.group.toLowerCase().split('_').some((tok) => tok === n || tok === `r${n}`)
        && !/^(fdr|feeder|bkr|dac|xfmr)_/i.test(t.group)
        && new RegExp(`_${phase}_FAULT_CURRENT$`, 'i').test(t.member));
      if (tag) out.push({ phase, tag: `${tag.struct}.${tag.member}` });
    }
  }
  const byPhase = new Map(out.map((p) => [p.phase, p.tag]));
  if (byPhase.size !== 4 || out.length !== 4) {
    return { problem: out.length > 4 ? 'several SCADA map points match its fault currents' : 'no fault-current points on the SCADA map' };
  }
  return { points: byPhase };
}

// --- all three ---------------------------------------------------------------

/**
 * Wire fault reporting for each new recloser. `reclosers` are
 * { name, number, struct, shared, circuit } (circuit: the row's text, used
 * when the client's folder doesn't name one). Writes the files it changes and
 * returns { done: [{ name, program, created }], skipped, problems, preview }.
 */
async function addFaultLogic(rtacDir, project, reclosers) {
  const setup = await readFaultSetup(rtacDir);
  const done = [];
  const problems = [];
  const preview = [];
  if (!setup.faultData) return { done, problems, preview, skipped: [] };
  const skipped = [];
  const loaded = new Map(); // program file -> { cfc, program, created }
  const fdBases = [];
  const tpRows = [];
  const navigatorAdds = [];

  // A template block: the bottom one of the program it's going into, else
  // one from the same folder, else any — always a recloser on its own client
  // (a shared client's points carry a group prefix that doesn't carry over).
  const ownClient = (cfc, box) => cluster(cfc, box).elements
    .every((el) => !/_DNP\./i.test(el.name ?? '') || /_DNP\.(BI|AI|BO)_\d{5}_/i.test(el.name));
  const pick = (cfc) => cfc.boxes().filter((b) => b.type === FB_TYPE && ownClient(cfc, b))
    .sort((a, b) => a.y - b.y).pop() ?? null;
  const anyTemplate = (dir) => {
    const ordered = [...setup.programs.filter((p) => p.xml && path.dirname(p.file) === dir),
      ...setup.programs.filter((p) => p.xml && path.dirname(p.file) !== dir)];
    for (const p of ordered) {
      const cfc = new Cfc(p.xml);
      const box = pick(cfc);
      if (box) return { cfc, box };
    }
    return null;
  };

  for (const rec of reclosers) {
    const warn = (message) => problems.push({ device: rec.name, message });
    if (!rec.struct || rec.shared) { skipped.push(rec.name); continue; }
    const entry = project.structs.find((e) => e.kind === 'client' && e.struct === rec.struct);
    const base = rec.struct.replace(/_DNP$/i, '');
    const to = { struct: rec.struct, base, entry };
    if (faultDataHas(setup.faultData.xml, base) || setup.programs.some((p) => p.instances.some((i) => lower(i) === lower(base)))) {
      skipped.push(rec.name);
      continue;
    }
    const circuit = circuitOf(path.basename(path.dirname(entry.file))) ?? circuitOf(rec.circuit);
    const where = programFor(setup, circuit, path.dirname(entry.file), project);
    if (where.problem) { warn(`fault logic not added: ${where.problem}`); continue; }

    let slot;
    if (where.program) {
      slot = loaded.get(where.program.file);
      if (!slot) {
        slot = { cfc: new Cfc(where.program.xml), program: where.program, created: false };
        loaded.set(where.program.file, slot);
      }
    } else {
      slot = loaded.get(where.create.file);
      if (!slot) {
        const cfc = newProgram(where.create.sibling, where.create.name);
        const program = { file: where.create.file, name: where.create.name, circuit, instances: [], xml: null };
        setup.programs.push(program);
        slot = { cfc, program, created: true, sibling: where.create.sibling };
        loaded.set(program.file, slot);
        navigatorAdds.push({ after: where.create.sibling.name, name: where.create.name });
      }
    }
    const own = pick(slot.cfc);
    const src = own ? { cfc: slot.cfc, box: own } : anyTemplate(path.dirname(slot.program.file));
    if (!src) { warn('fault logic not added: the project has no Fault_Three_Phase_Data block to copy'); continue; }
    const template = cluster(src.cfc, src.box);
    const fromStruct = template.elements.map((el) => el.name).find((t) => /_DNP\./i.test(t))?.split('.')[0];
    const from = { base: src.box.name, struct: fromStruct ?? `${src.box.name}_DNP` };

    const scada = scadaFaultPoints(project, rec.number);
    try {
      addBlock(slot.cfc, src.cfc, template, from, to);
    } catch (err) {
      warn(`fault logic not added: ${err.message}`);
      continue;
    }
    slot.program.instances.push(base);
    fdBases.push(base);
    if (scada.problem) warn(`Tag Processor rows not added: ${scada.problem}`);
    else for (const phase of PHASES) tpRows.push({ dest: scada.points.get(phase), source: `Fault_Data.${base}_${phase}_FAULT_CURRENT` });
    done.push({ name: rec.name, base, program: slot.program.name, created: slot.created, tagProcessor: !scada.problem });
  }

  for (const [file, slot] of loaded) {
    if (!slot.program.instances.length) continue;
    let xml = slot.cfc.toXml();
    if (slot.created) xml = xml.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_Decl_LineIds)/, `${randomUUID()}$1`);
    await writeFile(file, xml);
  }
  if (fdBases.length) {
    await writeFile(setup.faultData.file, addFaultDataRows(setup.faultData.xml, fdBases));
    preview.push(`// Fault_Data: +${fdBases.length * 4} tags\n${fdBases.flatMap((b) => PHASES.map((p) => `Fault_Data.${b}_${p}_FAULT_CURRENT`)).join('\n')}`);
  }
  if (tpRows.length && setup.tagProcessor) {
    await writeFile(setup.tagProcessor.file, addTagProcessorRows(setup.tagProcessor.xml, tpRows));
    preview.push(`// Tag Processor: +${tpRows.length} rows\n${tpRows.map((r) => `${r.dest} := ${r.source}`).join('\n')}`);
  }
  if (done.length) {
    preview.push(`// Fault programs\n${done.map((d) => `${d.program}${d.created ? ' (new)' : ''}: ${d.base} : ${FB_TYPE};`).join('\n')}`);
  }
  if (navigatorAdds.length) await addNavigatorItems(rtacDir, navigatorAdds);
  return { done, skipped, problems, preview };
}

/** List new POUs in Navigator Layout.xml beside the sibling they were made from. */
async function addNavigatorItems(rtacDir, adds) {
  const file = path.join(rtacDir, 'Navigator Layout.xml');
  let xml = await readFile(file, 'utf8').catch(() => null);
  if (xml == null) return;
  for (const { after, name } of adds) {
    const m = new RegExp(`\\n( *)<Item Name="${after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" />`).exec(xml);
    if (!m) continue;
    const at = m.index + m[0].length;
    xml = `${xml.slice(0, at)}\n${m[1]}<Item Name="${name}" />${xml.slice(at)}`;
  }
  await writeFile(file, xml);
}

export { addFaultLogic, addNavigatorItems, readFaultSetup, circuitOf, addFaultDataRows, addTagProcessorRows, retarget };
