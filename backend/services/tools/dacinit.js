// CLECO DAC Inits — the projector-native replacement for the "DAC Inits"
// macro-enabled workbook + copy/paste dance. You pick a DAC .rtac project
// already in the tree, describe the devices you're adding (reclosers,
// transformers, feeders/breakers, connectors), and this generates the exact Structured-Text
// init blocks the macro would, merges them into the project's Init_* POUs, and
// lands the result as a NEW VERSION of the same .rtac entry. Pure XML text
// generation — no AcSELerator, no database.
//
// Everything a block points at is read from the project being built onto
// (dacinit/project.js): the DNP client and SCADA-map tags, the device
// definitions it declares, which Init_* POU holds which kind, and the point
// counts its reclosers already use. dacinit/resolve.js turns the rows into
// specs from that, falling back to the workbook's naming (with a warning) only
// where the project can't answer; dacinit/generate.js writes the ST, and
// dacinit/pou.js does the surgical CDATA edits. New devices first get their
// SCADA map blocks (dacinit/scadamap.js), and dacinit/scheme.js then wires
// them into the AreaMap, fault logic and Feeders_Excluded. Connectors and
// their managers are dacinit/connectors.js.
// Nothing lands in the tree until the explicit save().

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { copyEntry } from '../../lib/fs.js';
import { httpError } from '../../lib/http.js';
import { DECL_ORDER, declarationBatch, writeInits } from './dacinit/generate.js';
import { feedsOf } from './dacinit/areamap.js';
import { Cfc } from './dacinit/cfc.js';
import { addIpVars, newConnectorPou } from './dacinit/connectors.js';
import { POU_PATTERNS, hasDefinition, readProject, voltageFamily } from './dacinit/project.js';
import { resolveSpecs, rowNames, switchDefinition } from './dacinit/resolve.js';
import { addScadaBlocks, scadaWants } from './dacinit/scadamap.js';
import { addNavigatorItems } from './dacinit/faults.js';
import { wireScheme } from './dacinit/scheme.js';
import {
  appendImplementation, declarationHasDevice, deviceIndex, insertDeclarations, patchRecloser,
  readDeclarations, readImplementation, recloserState, replaceDevices, writeImplementation,
} from './dacinit/pou.js';

// The device kinds, in the order they read in a note. Each targets the
// Init_* POU project.js finds for it under SEL_RTAC/DAC/Initializations/
// (the schemes spell them differently); writeInits() keys its blocks by id.
const KINDS = [
  { id: 'reclosers', label: 'recloser' },
  { id: 'transformers', label: 'transformer' },
  { id: 'feeders', label: 'feeder' },
  { id: 'breakers', label: 'breaker' },
  { id: 'pseudoBreakers', label: 'pseudo breaker' },
  { id: 'connectors', label: 'connector' },
];
const CONNECTOR_POU = 'Init_DA_Connector';
const INIT_DIR = ['SEL_RTAC', 'DAC', 'Initializations'];
const DECL_FILE = ['SEL_RTAC', 'DAC', 'DeviceDeclarations.xml'];
const MANIFEST = '.dacinit-manifest.json';
const PREVIEW = 'generated-inits.txt';

function countPhrase(byKind) {
  const parts = [];
  for (const { id, label } of KINDS) {
    const n = byKind[id]?.length ?? 0;
    if (n) parts.push(`${n} ${label}${n === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** The device names of a per-kind map, flattened. */
function namesOf(byKind) {
  return Object.values(byKind).flat();
}

/**
 * The version note. Names are what you want to read in the tree when a few
 * devices changed; past a handful, counts stay legible.
 */
function versionNote(added, replaced, declared, updated = [], wired = {}) {
  const parts = [];
  if (namesOf(added).length) parts.push(`add ${countPhrase(added)}`);
  if (updated.length) {
    parts.push(`update ${updated.length <= 6
      ? updated.map((u) => `${u.name} (${u.changes.map((c) => c.what).join(', ')})`).join(', ')
      : `${updated.length} reclosers`}`);
  }
  const redone = namesOf(replaced);
  if (redone.length) {
    parts.push(`overwrite ${redone.length <= 6 ? redone.join(', ') : countPhrase(replaced)}`);
  }
  // A device can already be initialized but never declared; then the batch of
  // VAR_GLOBAL lines is the whole change.
  if (!parts.length && declared) parts.push(`declare ${declared} device${declared === 1 ? '' : 's'}`);
  const extras = [
    wired.scada?.length ? 'SCADA map' : null,
    wired.areaMap?.length ? 'AreaMap' : null,
    wired.faults?.length ? 'fault logic' : null,
    wired.excluded?.length ? 'Feeders_Excluded' : null,
  ].filter(Boolean);
  if (extras.length) parts.push(`wire ${extras.join(', ')}`);
  return `Auto inits & declarations: ${parts.join('; ')}`;
}

// AreaMap box types, by what the form calls them.
const AREA_KINDS = [
  ['recloser', /^DA_REC\./i], ['feeder', /^DA_FDR\./i], ['breaker', /^DA_(PSEUDO_)?BKR\./i],
  ['transformer', /^DA_SUB_TRANSFORMER\./i], ['connector', /^DA_DAC_INTERCONNECT\./i],
];

// A device number may be typed with its identifier's letter ("R6267",
// "F4473A", "B4473A") or without; the generators want it without.
const bare = (letters) => (value) => String(value ?? '').trim().replace(new RegExp(`^[${letters}](?=\\d)`, 'i'), '');
const bareRecloser = bare('R');
const bareFeeder = bare('FB');
function withBareNumbers(payload) {
  if (!payload) return payload;
  return {
    ...payload,
    reclosers: payload.reclosers?.map((r) => ({ ...r, number: bareRecloser(r.number) })),
    feedersBreakers: payload.feedersBreakers?.map((f) => ({ ...f, number: bareFeeder(f.number) })),
  };
}

class DacInitService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /**
   * Generate the init blocks and merge them into a run-local copy of the
   * selected DAC project. Nothing touches the tree yet.
   *
   * A device whose identifier is already used in the project is NOT quietly
   * skipped: it comes back in `conflicts`, and the caller re-runs with that
   * name in `overwrite` to have its init block regenerated in place — where
   * the engineer put it, so a changed capacity (or any other parameter) lands
   * as an edit rather than a duplicate at the bottom of the POU. Declarations
   * are never overwritten: a device's VAR_GLOBAL line carries only its type,
   * which the parameters can't change.
   *
   * payload: {
   *   project, path,                       // the .rtac entry to build onto
   *   params: {…},                         // voltage (blank = the project's), PT sets,
   *                                        // count overrides, fallback prefixes
   *   reclosers[], transformers[], feedersBreakers[],   // a recloser row's aSide/bSide
   *                                        // and a feeder row's aSide place it on the AreaMap
   *   connectors[],                        // { name, connection, remoteDac, feeds, port, remoteIp }
   *   overwrite[]                          // identifiers to regenerate in place
   * }
   */
  async generate(files, rawPayload) {
    const payload = withBareNumbers(rawPayload);
    const sourcePath = String(payload?.path ?? '').trim();
    if (!sourcePath) throw httpError(400, 'pick a DAC .rtac project to build onto');

    const totalDevices = (payload?.reclosers?.length ?? 0)
      + (payload?.transformers?.length ?? 0)
      + (payload?.feedersBreakers?.length ?? 0)
      + (payload?.connectors?.length ?? 0);
    if (!totalDevices) throw httpError(400, 'add at least one device');

    const { absolute, isDirectory } = await files.identify(sourcePath);
    if (!isDirectory) throw httpError(400, `${sourcePath} is not a .rtac project folder`);
    const inits = await readdir(path.join(absolute, ...INIT_DIR)).catch(() => []);
    if (!inits.some((name) => POU_PATTERNS.reclosers.test(name))) {
      throw httpError(400,
        `${sourcePath} is not a DAC project — it has no ${INIT_DIR.join('/')}/Init_Reclosers.xml`);
    }

    // Two rows claiming one identifier would generate two blocks for the same
    // device — caught here rather than written out as invalid ST.
    const seen = new Set();
    const repeats = [];
    for (const name of Object.values(rowNames(payload)).flat()) {
      const key = name.toLowerCase();
      if (seen.has(key)) repeats.push(name);
      else seen.add(key);
    }
    if (repeats.length) {
      throw httpError(400, `two device rows generate the same identifier: ${[...new Set(repeats)].join(', ')}`);
    }

    const overwrite = new Set(
      (payload?.overwrite ?? []).map((name) => String(name).trim().toLowerCase()).filter(Boolean),
    );

    const entryName = path.basename(sourcePath);
    const dir = path.dirname(sourcePath) === '.' ? '' : path.dirname(sourcePath);
    const { runId, dir: runDir } = await this.workspace.createRun('dacinit');
    const projectCopy = path.join(runDir, entryName);

    const jobs = this.jobs;
    const job = jobs.start(`CLECO DAC Inits: ${totalDevices} device(s)`, async (handle) => {
      await copyEntry(absolute, projectCopy);
      const project = await readProject(projectCopy);
      const header = `Auto-added by CLECO DAC Inits ${new Date().toISOString().slice(0, 10)}`;

      // A project with no connector POU yet gets one, made from another
      // Init_* POU and listed beside it.
      if (payload.connectors?.length && !project.pous.connectors) {
        const sibling = project.pous.transformers ?? project.pous.reclosers;
        const siblingXml = await readFile(path.join(projectCopy, ...INIT_DIR, sibling), 'utf8');
        await writeFile(path.join(projectCopy, ...INIT_DIR, `${CONNECTOR_POU}.xml`), newConnectorPou(siblingXml, CONNECTOR_POU));
        await addNavigatorItems(projectCopy, [{ after: sibling.replace(/\.xml$/i, ''), name: CONNECTOR_POU }]);
        project.pous.connectors = `${CONNECTOR_POU}.xml`;
        handle.log(`${CONNECTOR_POU}.xml: created`);
      }
      const added = {};
      const replaced = {};
      const conflicts = [];
      const previewSections = [];

      // 1) Inits. Every Init_* POU is read and indexed up front: an identifier
      //    counts as "already used" wherever in the project it sits, and an
      //    overwrite rewrites it there — not in the POU this device kind would
      //    normally go to.
      const pous = [];
      for (const { id } of KINDS) {
        const pou = project.pous[id];
        if (!pou) continue;
        const file = path.join(projectCopy, ...INIT_DIR, pou);
        const xml = await readFile(file, 'utf8');
        const impl = readImplementation(xml);
        pous.push({ id, name: pou, file, xml, impl, devices: deviceIndex(impl), appends: [], edits: [], patches: [] });
      }

      const declFile = path.join(projectCopy, ...DECL_FILE);
      let declXml = await readFile(declFile, 'utf8').catch(() => null);
      const declContent = declXml == null ? '' : readDeclarations(declXml);
      const known = (name) => pous.some((pou) => pou.devices.has(name.toLowerCase()))
        || declarationHasDevice(declContent, name);

      // 0) SCADA map: a block for each new device the maps don't carry yet,
      //    so the inits below point at real tags.
      const scadaFamily = ['13.2kV', '34.5kV'].includes(payload.params?.voltage) ? payload.params.voltage : voltageFamily(project);
      const scadaMap = await addScadaBlocks(projectCopy, project, scadaWants(payload, project, scadaFamily, known));
      for (const s of scadaMap.added) handle.log(`${s.map}: +${s.group} (${s.points} points, from ${s.template})`);
      if (scadaMap.added.length) {
        previewSections.push(`// ==== SCADA map (+${scadaMap.added.length}) ====\n\n`
          + scadaMap.added.map((s) => `${s.map}.${s.group}_…: ${s.points} points, copied from ${s.template}`).join('\n'));
      }

      const { family, specs, warnings } = resolveSpecs(payload, project, known);
      warnings.unshift(...scadaMap.problems);
      const blocksByPou = writeInits(specs);
      handle.log(`${family} scheme`);
      for (const { device, message } of warnings) handle.log(`${device}: ${message}`);

      // A recloser the project already has is UPDATED, not flagged: a scheme
      // addition commonly changes an existing recloser's capacity, switch mode
      // or settings-group sources, so just those settings are rewritten in its
      // block, where it sits, and the rest of the block is left exactly as
      // the engineer wrote it.
      // (Naming it in `overwrite` still regenerates the whole block.)
      const updated = [];
      const unchanged = [];
      const updateRecloser = (spec, host) => {
        const spans = host.devices.get(spec.name.toLowerCase());
        const state = recloserState(host.impl, spans);
        const patch = {};
        const changes = [];
        if (spec.capacity && spec.capacity !== state.capacity) {
          patch.capacity = spec.capacity;
          changes.push({ what: 'capacity', from: state.capacity, to: spec.capacity });
        }
        if (spec.switchMode !== state.switchMode) {
          const definition = switchDefinition(state.definition, spec.switchMode);
          if (!definition) {
            warnings.push({ device: spec.name, message: `switch mode not changed: no switch counterpart of ${state.definition}` });
          } else if (!hasDefinition(project, definition)) {
            warnings.push({ device: spec.name, message: `switch mode not changed: ${definition} is not a device definition in this project` });
          } else {
            if (definition !== state.definition) patch.definition = definition;
            patch.switchMode = spec.switchMode;
            changes.push({ what: 'switch mode', from: state.switchMode ? 'on' : 'off', to: spec.switchMode ? 'on' : 'off' });
          }
        }
        // Settings groups: compared slot by slot, case-insensitively (ST is).
        const slots = [];
        spec.sources.forEach((want, i) => {
          const had = state.sources?.[i] ?? { src: '0', sg: '0' };
          const letter = String.fromCharCode(65 + i);
          if (want.src.toLowerCase() !== had.src.toLowerCase()) slots.push([`SRC_${letter}`, had.src, want.src]);
          if (want.sg !== had.sg) slots.push([`SG_${letter}`, had.sg, want.sg]);
        });
        if (slots.length && !state.sources) {
          warnings.push({ device: spec.name, message: 'settings groups not changed: it has no InitSettingsGroups call' });
        } else if (slots.length) {
          patch.sources = spec.sources;
          changes.push({
            what: 'settings groups',
            from: slots.map(([arg, from]) => `${arg} ${from}`).join(', '),
            to: slots.map(([arg, , to]) => `${arg} ${to}`).join(', '),
          });
        }
        if (!changes.length) { unchanged.push(spec.name); return; }
        host.patches.push({ name: spec.name, patch });
        updated.push({ name: spec.name, where: host.name, changes });
      };
      const recloserSpecs = new Map(specs.reclosers.map((spec) => [spec.name.toLowerCase(), spec]));

      const unwritten = new Set();
      for (const { id } of KINDS) {
        added[id] = [];
        replaced[id] = [];
        for (const block of blocksByPou[id] ?? []) {
          const key = block.name.toLowerCase();
          const hosts = pous.filter((target) => target.devices.has(key));
          if (!hosts.length) {
            const target = pous.find((candidate) => candidate.id === id);
            if (!target) {
              warnings.push({ device: block.name, message: `the project has no Init_* POU for ${KINDS.find((k) => k.id === id).label}s; not written` });
              handle.log(`skip ${block.name}: no Init_* POU for ${id}`);
              unwritten.add(key);
              continue;
            }
            target.appends.push(block);
            added[id].push(block.name);
          } else if (overwrite.has(key)) {
            for (const host of hosts) host.edits.push({ key, text: block.text });
            replaced[id].push(block.name);
          } else if (id === 'reclosers') {
            updateRecloser(recloserSpecs.get(key), hosts[0]);
          } else {
            conflicts.push({ name: block.name, where: hosts.map((host) => host.name) });
          }
        }
      }

      // The resolver's notes about an updated recloser's pointers and
      // definition don't apply: none of those lines are touched. Its notes on
      // sources (an SRC that names nothing in the project) still do.
      const kept = new Set([...updated.map((u) => u.name), ...unchanged].map((n) => n.toLowerCase()));
      for (let i = warnings.length - 1; i >= 0; i -= 1) {
        if (kept.has(warnings[i].device.toLowerCase())
          && !/^(switch mode not changed|settings groups not changed|SRC_)/.test(warnings[i].message)) {
          warnings.splice(i, 1);
        }
      }

      for (const pou of pous) {
        if (!pou.appends.length && !pou.edits.length && !pou.patches.length) continue;
        let impl = pou.impl;
        // Patch one device at a time, re-indexing between, so each sees
        // spans that are valid for the text as it now stands.
        for (const { name, patch } of pou.patches) {
          impl = patchRecloser(impl, name, deviceIndex(impl).get(name.toLowerCase()), patch);
        }
        if (pou.edits.length) {
          const index = deviceIndex(impl);
          impl = replaceDevices(impl, pou.edits.map(({ key, text }) => ({ spans: index.get(key), text })));
        }
        if (pou.appends.length) {
          impl = appendImplementation(impl, pou.appends.map((block) => block.text).join('\n\n'));
        }
        let xml = writeImplementation(pou.xml, impl);
        // A new manager's IP variables, in the connector POU's VAR block.
        if (pou.id === 'connectors') {
          const appended = new Set(pou.appends.map((block) => block.name.toLowerCase()));
          xml = addIpVars(xml, specs.connectors.filter((c) => appended.has(c.name.toLowerCase())).flatMap((c) => c.vars));
        }
        await writeFile(pou.file, xml);
        const tally = [
          pou.appends.length ? `+${pou.appends.length}` : null,
          pou.edits.length ? `~${pou.edits.length}` : null,
          pou.patches.length ? `updated ${pou.patches.length}` : null,
        ].filter(Boolean).join(' ');
        // Each updated recloser as its block now reads, under what changed.
        const finalIndex = deviceIndex(impl);
        const patched = updated.filter((u) => u.where === pou.name).map((u) => {
          const spans = finalIndex.get(u.name.toLowerCase());
          return `// ${u.name}: ${u.changes.map((c) => `${c.what} ${c.from ?? '—'} -> ${c.to}`).join(', ')}\n`
            + impl.slice(spans[0].start, spans[spans.length - 1].end);
        });
        previewSections.push(`// ==== ${pou.name} (${tally}) ====\n\n`
          + [...patched, ...[...pou.edits, ...pou.appends].map((block) => block.text)].join('\n\n'));
        handle.log(`${pou.name}: added ${pou.appends.length}, overwrote ${pou.edits.length}, updated ${pou.patches.length}`);
      }
      for (const conflict of conflicts) {
        handle.log(`${conflict.name}: already in ${conflict.where.join(', ')} — left as is`);
      }

      // 2) Declarations — insert each device's VAR_GLOBAL entry into
      //    DeviceDeclarations.xml (a device must be declared for its init to
      //    compile). One labeled batch before END_VAR. Already-declared
      //    devices are left alone even under overwrite: the line says only
      //    what type the device is.
      const declarations = { added: [], skipped: [] };
      if (declXml == null) {
        handle.log(`skip declarations: ${DECL_FILE.join('/')} not found`);
      } else {
        const toDeclare = {};
        // Managers come with the connectors that bring them.
        blocksByPou.managers = specs.connectors
          .filter((c) => c.newManager && added.connectors?.some((n) => n.toLowerCase() === c.name.toLowerCase()))
          .map((c) => ({ name: c.manager.name }));
        for (const kind of DECL_ORDER) {
          toDeclare[kind] = [];
          for (const { name } of blocksByPou[kind] ?? []) {
            if (unwritten.has(name.toLowerCase())) continue;
            if (declarationHasDevice(declContent, name)) declarations.skipped.push(name);
            else { toDeclare[kind].push(name); declarations.added.push(name); }
          }
        }
        if (declarations.added.length) {
          const batch = declarationBatch(toDeclare, header);
          declXml = insertDeclarations(declXml, batch);
          await writeFile(declFile, declXml);
          previewSections.push(`// ==== DeviceDeclarations.xml (+${declarations.added.length}) ====\n\n${batch}`);
        }
        handle.log(`DeviceDeclarations.xml: added ${declarations.added.length}`
          + (declarations.skipped.length ? `, skipped ${declarations.skipped.length} already declared` : ''));
      }

      // 3) The rest of the addition: AreaMap, fault reporting,
      //    Feeders_Excluded — for the devices just added.
      const scheme = await wireScheme(projectCopy, project, specs, added, header);
      warnings.push(...scheme.warnings);
      previewSections.push(...scheme.preview);
      if (scheme.areaMap.length) handle.log(`AreaMap.xml: placed ${scheme.areaMap.length}`);
      if (scheme.faults.length) handle.log(`fault logic: ${scheme.faults.length} recloser(s)`);
      if (scheme.excluded.length) handle.log(`Feeders_Excluded.xml: added ${scheme.excluded.length}`);
      const wired = { scada: scadaMap.added, areaMap: scheme.areaMap, faults: scheme.faults, excluded: scheme.excluded };

      // Writing nothing is not an error — it means every device you listed is
      // already there, and the caller is being offered the overwrite instead.
      const changed = namesOf(added).length + namesOf(replaced).length + updated.length + declarations.added.length
        + wired.scada.length + wired.areaMap.length + wired.faults.length + wired.excluded.length;
      const note = versionNote(added, replaced, declarations.added.length, updated, wired);
      await writeFile(path.join(runDir, PREVIEW), previewSections.join('\n\n\n'));
      await writeFile(path.join(runDir, MANIFEST), JSON.stringify(
        { dir, entryName, sourcePath, note, changed, family, added, replaced, updated, unchanged, declarations, wired, conflicts, warnings }, null, 2,
      ));

      return {
        run: runId,
        entryName,
        changed,
        family,
        added,
        replaced,
        updated,
        unchanged,
        declarations,
        wired,
        conflicts,
        warnings,
        note,
        reports: changed ? [{ path: PREVIEW, label: `Changes (${changed})` }] : [],
      };
    });
    return { job: job.id, run: runId };
  }

  /**
   * The reclosers a DAC project already initializes, with the settings an
   * update can change — what the form prefills when a typed number matches.
   */
  async lookup(files, sourcePath) {
    const { absolute, isDirectory } = await files.identify(String(sourcePath ?? '').trim());
    if (!isDirectory) throw httpError(400, `${sourcePath} is not a .rtac project folder`);
    const project = await readProject(absolute);
    if (!project.pous.reclosers) throw httpError(400, `${sourcePath} is not a DAC project`);
    const xml = await readFile(path.join(absolute, ...INIT_DIR, project.pous.reclosers), 'utf8');
    const impl = readImplementation(xml);
    const reclosers = [];
    for (const [, spans] of deviceIndex(impl)) {
      const head = /^\s*(R\w+)\s*\./i.exec(impl.slice(spans[0].start, spans[0].end));
      if (!head) continue;
      const state = recloserState(impl, spans);
      if (state.definition == null) continue;
      reclosers.push({ name: head[1], ...state });
    }
    const remotes = project.interconnect.managers.map((m) => m.remote);
    // What the A side / B side / feeds / source fields can name.
    const mapXml = await readFile(path.join(absolute, 'SEL_RTAC', 'DAC', 'AreaMap.xml'), 'utf8').catch(() => null);
    const areaMap = [];
    if (mapXml != null) {
      const cfc = new Cfc(mapXml);
      for (const box of cfc.boxes()) {
        let kind = AREA_KINDS.find(([, pattern]) => pattern.test(box.type ?? ''))?.[0];
        // A 651R breaker is a DA_REC on the map.
        if (kind === 'recloser' && /^B\d/i.test(box.name ?? '')) kind = 'breaker';
        if (kind && box.name) areaMap.push({ name: box.name, kind, feeds: feedsOf(cfc, box) });
      }
    }
    const clients = project.structs.filter((e) => e.kind === 'client')
      .map((e) => e.struct.replace(/_DNP$/i, '')).sort();
    return { family: voltageFamily(project), reclosers, remotes, areaMap, clients };
  }

  /**
   * Land the run's modified project as a new version of the source .rtac entry.
   * Same name → placeEntry archives the existing bytes as a version first, so
   * the prior project is never lost.
   */
  async save(files, runId) {
    const runDir = await this.workspace.runDir('dacinit', runId);
    const manifest = JSON.parse(
      (await this.workspace.readFile('dacinit', runId, MANIFEST)).toString(),
    );
    const { dir, entryName, note, changed } = manifest;
    if (!changed) {
      throw httpError(409, 'this run changed nothing — overwrite the existing devices, or change the rows');
    }
    await files.placeEntry(dir, entryName, note, async (target) => {
      await copyEntry(path.join(runDir, entryName), target);
    }, { directory: true });
    return { placed: dir ? `${dir}/${entryName}` : entryName, note };
  }
}

export { DacInitService };
