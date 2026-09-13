// CLECO DAC Inits — the projector-native replacement for the "DAC Inits"
// macro-enabled workbook + copy/paste dance. You pick a DAC .rtac project
// already in the tree, describe the devices you're adding (reclosers,
// transformers, feeders/breakers), and this generates the exact Structured-Text
// init blocks the macro would, merges them into the project's Init_* POUs, and
// lands the result as a NEW VERSION of the same .rtac entry. Pure XML text
// generation — no AcSELerator, no database.
//
// The generators live in dacinit/generate.js (ported from the workbook VBA and
// validated against a real CLECO project); dacinit/pou.js does the surgical
// CDATA edits. Nothing lands in the tree until the explicit save().

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { copyEntry, statOrNull } from '../../lib/fs.js';
import { httpError } from '../../lib/http.js';
import { DECL_ORDER, declarationBatch, declarationNames, generateInits } from './dacinit/generate.js';
import {
  appendImplementation, declarationHasDevice, deviceIndex, insertDeclarations,
  readDeclarations, readImplementation, replaceDevices, writeImplementation,
} from './dacinit/pou.js';

// The device kinds, in the order they read in a note, each with the Init_* POU
// it targets under the DAC project's SEL_RTAC/DAC/Initializations/ folder.
// generateInits() keys its blocks by these ids.
const KINDS = [
  { id: 'reclosers', label: 'recloser', pou: 'Init_Reclosers.xml' },
  { id: 'transformers', label: 'transformer', pou: 'Init_Xfmr.xml' },
  { id: 'feeders', label: 'feeder', pou: 'Init_Feeders.xml' },
  { id: 'breakers', label: 'breaker', pou: 'Init_Breakers.xml' },
];
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
function versionNote(added, replaced, declared) {
  const parts = [];
  if (namesOf(added).length) parts.push(`add ${countPhrase(added)}`);
  const redone = namesOf(replaced);
  if (redone.length) {
    parts.push(`overwrite ${redone.length <= 6 ? redone.join(', ') : countPhrase(replaced)}`);
  }
  // A device can already be initialized but never declared; then the batch of
  // VAR_GLOBAL lines is the whole change.
  if (!parts.length && declared) parts.push(`declare ${declared} device${declared === 1 ? '' : 's'}`);
  return `Auto inits & declarations: ${parts.join('; ')}`;
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
   *   project: {…params…} as `params`,     // recPrefix/scadaMap/fdrPrefix/bkrPrefix/voltage
   *   reclosers[], transformers[], feedersBreakers[],
   *   overwrite[]                          // identifiers to regenerate in place
   * }
   */
  async generate(files, payload) {
    const sourcePath = String(payload?.path ?? '').trim();
    if (!sourcePath) throw httpError(400, 'pick a DAC .rtac project to build onto');

    const totalDevices = (payload?.reclosers?.length ?? 0)
      + (payload?.transformers?.length ?? 0)
      + (payload?.feedersBreakers?.length ?? 0);
    if (!totalDevices) throw httpError(400, 'add at least one device');

    const { absolute, isDirectory } = await files.identify(sourcePath);
    if (!isDirectory) throw httpError(400, `${sourcePath} is not a .rtac project folder`);
    const anchor = path.join(absolute, ...INIT_DIR, KINDS[0].pou);
    if (!(await statOrNull(anchor))?.isFile()) {
      throw httpError(400,
        `${sourcePath} is not a DAC project — it has no ${INIT_DIR.join('/')}/${KINDS[0].pou}`);
    }

    const blocksByPou = generateInits({
      project: payload?.params ?? {},
      reclosers: payload?.reclosers,
      transformers: payload?.transformers,
      feedersBreakers: payload?.feedersBreakers,
    });

    // Two rows claiming one identifier would generate two blocks for the same
    // device — caught here rather than written out as invalid ST.
    const seen = new Set();
    const repeats = [];
    for (const { id } of KINDS) {
      for (const block of blocksByPou[id] ?? []) {
        const key = block.name.toLowerCase();
        if (seen.has(key)) repeats.push(block.name);
        else seen.add(key);
      }
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

    const declBase = {
      reclosers: payload?.reclosers,
      transformers: payload?.transformers,
      feedersBreakers: payload?.feedersBreakers,
    };
    const jobs = this.jobs;
    const job = jobs.start(`CLECO DAC Inits: ${totalDevices} device(s)`, async (handle) => {
      await copyEntry(absolute, projectCopy);
      const added = {};
      const replaced = {};
      const conflicts = [];
      const previewSections = [];

      // 1) Inits. Every Init_* POU is read and indexed up front: an identifier
      //    counts as "already used" wherever in the project it sits, and an
      //    overwrite rewrites it there — not in the POU this device kind would
      //    normally go to.
      const pous = [];
      for (const { id, pou } of KINDS) {
        const file = path.join(projectCopy, ...INIT_DIR, pou);
        const xml = await readFile(file, 'utf8').catch(() => null);
        if (xml == null) continue;
        const impl = readImplementation(xml);
        pous.push({ id, name: pou, file, xml, impl, devices: deviceIndex(impl), appends: [], edits: [] });
      }

      for (const { id, pou } of KINDS) {
        added[id] = [];
        replaced[id] = [];
        for (const block of blocksByPou[id] ?? []) {
          const key = block.name.toLowerCase();
          const hosts = pous.filter((target) => target.devices.has(key));
          if (!hosts.length) {
            const target = pous.find((candidate) => candidate.id === id);
            if (!target) {
              handle.log(`skip ${block.name}: ${pou} not found in project`);
              continue;
            }
            target.appends.push(block);
            added[id].push(block.name);
          } else if (overwrite.has(key)) {
            for (const host of hosts) host.edits.push({ spans: host.devices.get(key), text: block.text });
            replaced[id].push(block.name);
          } else {
            conflicts.push({ name: block.name, where: hosts.map((host) => host.name) });
          }
        }
      }

      for (const pou of pous) {
        if (!pou.appends.length && !pou.edits.length) continue;
        let impl = pou.edits.length ? replaceDevices(pou.impl, pou.edits) : pou.impl;
        if (pou.appends.length) {
          impl = appendImplementation(impl, pou.appends.map((block) => block.text).join('\n\n'));
        }
        await writeFile(pou.file, writeImplementation(pou.xml, impl));
        const tally = [
          pou.appends.length ? `+${pou.appends.length}` : null,
          pou.edits.length ? `~${pou.edits.length}` : null,
        ].filter(Boolean).join(' ');
        previewSections.push(`// ==== ${pou.name} (${tally}) ====\n\n`
          + [...pou.edits, ...pou.appends].map((block) => block.text).join('\n\n'));
        handle.log(`${pou.name}: added ${pou.appends.length}, overwrote ${pou.edits.length}`);
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
      const declFile = path.join(projectCopy, ...DECL_FILE);
      let declXml = await readFile(declFile, 'utf8').catch(() => null);
      if (declXml == null) {
        handle.log(`skip declarations: ${DECL_FILE.join('/')} not found`);
      } else {
        const content = readDeclarations(declXml);
        const wanted = declarationNames(declBase);
        const toDeclare = {};
        for (const kind of DECL_ORDER) {
          toDeclare[kind] = [];
          for (const name of wanted[kind]) {
            if (declarationHasDevice(content, name)) declarations.skipped.push(name);
            else { toDeclare[kind].push(name); declarations.added.push(name); }
          }
        }
        if (declarations.added.length) {
          const header = `Auto-added by CLECO DAC Inits ${new Date().toISOString().slice(0, 10)}`;
          const batch = declarationBatch(toDeclare, header);
          declXml = insertDeclarations(declXml, batch);
          await writeFile(declFile, declXml);
          previewSections.push(`// ==== DeviceDeclarations.xml (+${declarations.added.length}) ====\n\n${batch}`);
        }
        handle.log(`DeviceDeclarations.xml: added ${declarations.added.length}`
          + (declarations.skipped.length ? `, skipped ${declarations.skipped.length} already declared` : ''));
      }

      // Writing nothing is not an error — it means every device you listed is
      // already there, and the caller is being offered the overwrite instead.
      const changed = namesOf(added).length + namesOf(replaced).length + declarations.added.length;
      const note = versionNote(added, replaced, declarations.added.length);
      await writeFile(path.join(runDir, PREVIEW), previewSections.join('\n\n\n'));
      await writeFile(path.join(runDir, MANIFEST), JSON.stringify(
        { dir, entryName, sourcePath, note, changed, added, replaced, declarations, conflicts }, null, 2,
      ));

      return {
        run: runId,
        entryName,
        changed,
        added,
        replaced,
        declarations,
        conflicts,
        note,
        reports: changed ? [{ path: PREVIEW, label: `Inits & declarations (${changed})` }] : [],
      };
    });
    return { job: job.id, run: runId };
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
