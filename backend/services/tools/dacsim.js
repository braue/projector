// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// DAC exports already in a project's tree, ported from the standalone
// DACSIMCONVERT app. One Generate does the whole pipeline: staging copies
// the picked .rtac entries into a run and generates settings.json from the
// form fields (nobody hand-authors it); the vendored dacToSim package
// converts in py/dacsim_convert.py, headless (prompts auto-skip onto the
// package's own warning scaffolds, narration streams into the job log); the
// generated simulator folders land back in the SOURCE PROJECT's tree as
// versioned .rtac entries under "DAC SIM Converter/". Getting one into the
// AcRTAC database is the tree's generic "Import to AcRTAC" action
// (services/tools/acrtacImport.js), not part of this pipeline.

import { cp, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const CONVERT_SCRIPT = 'dacsim_convert.py';
const ZIP_NAME = 'sim projects.zip';
const PROJECT_FOLDER = 'DAC SIM Converter';

/** This tool's own wording for the failure classes runStdinBridge shapes. */
const EXPLAIN = {
  python: 'Python was not found on PATH — install Python 3.12+ to run the DAC SIM Converter.',
};

/** The scheme list from a run's settings.json — the converter's own Python
 *  validation is authoritative; this is the cheap Node-side read the staging
 *  response and output-zip selection are built from. */
function parseSchemes(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError(400, 'settings.json is not valid JSON');
  }
  if (!Array.isArray(data) || !data.length) {
    throw httpError(400, 'settings.json must be a non-empty list of schemes');
  }
  return data.map((item, index) => {
    const scheme = {
      schemeName: String(item?.schemeName ?? ''),
      dacFolder: String(item?.dac?.subFolder ?? ''),
      remoteFolder: String(item?.remote?.subFolder ?? ''),
      logicFolder: String(item?.logic?.subFolder ?? ''),
    };
    if (!scheme.schemeName || !scheme.dacFolder || !scheme.remoteFolder || !scheme.logicFolder) {
      throw httpError(400, `scheme ${index + 1} needs schemeName and dac/remote/logic subFolder`);
    }
    return scheme;
  });
}

function requireIp(value, label) {
  const ip = String(value ?? '').trim();
  if (!ip) throw httpError(400, `${label} is required`);
  return ip;
}

class DacsimService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /**
   * Stage 1: DAC exports already living in a project's
   * tree (`.rtac` entries — the same AcRTAC XML-export shape) are copied
   * into a new run and settings.json is written FROM the form fields, so
   * nobody hand-authors it.
   *
   * payload: { schemes: [{ schemeName, dacPath, dacIps[], remoteIp }],
   *            masterIp }
   *
   * masterIp is ONE address for the whole run — settings.json repeats it
   * per scheme because the format demands it, not because it varies. The
   * master folder is always "SIM Master" and defaultLoad is always 1.
   */
  async stageFromProject(files, payload) {
    const schemes = Array.isArray(payload?.schemes) ? payload.schemes : [];
    if (!schemes.length) throw httpError(400, 'add at least one scheme');
    const masterFolder = 'SIM Master';
    const masterIp = requireIp(payload?.masterIp, 'master IP');
    const defaultLoad = 1;

    const staged = schemes.map((scheme, index) => {
      const schemeName = String(scheme?.schemeName ?? '').trim();
      if (!/^[A-Za-z0-9 _.-]+$/.test(schemeName)) {
        throw httpError(400, `scheme ${index + 1}: name must be letters, digits, spaces, _ - .`);
      }
      const dacIps = (Array.isArray(scheme?.dacIps) ? scheme.dacIps : [])
        .map((ip) => String(ip).trim()).filter(Boolean);
      if (!dacIps.length) throw httpError(400, `${schemeName}: at least one DAC IP is required`);
      if (!String(scheme?.dacPath ?? '').trim()) {
        throw httpError(400, `${schemeName}: pick the DAC export entry`);
      }
      return {
        schemeName,
        subSimId: `Sim${index + 1}`,
        dacPath: String(scheme?.dacPath ?? ''),
        dac: { subFolder: `DAC ${schemeName}`, ipAddr: dacIps },
        remote: { subFolder: `${schemeName}_REMOTE`, ipAddr: requireIp(scheme?.remoteIp, `${schemeName}: remote IP`) },
        logic: { subFolder: masterFolder, ipAddr: masterIp },
        nameConversions: [],
        parameters: { defaultLoad },
      };
    });

    // Resolve every DAC entry BEFORE creating the run, so a bad pick fails
    // clean instead of leaving a half-staged run. The converter demands the
    // DAC folder convention (documentation/folderPaths.md in DACSIMCONVERT):
    // the DAC's own logic under SEL_RTAC/DAC/ — check its anchor file up
    // front so a mis-organized export reads as a form error, not a
    // traceback minutes into the job.
    const sources = [];
    for (const scheme of staged) {
      const { absolute, isDirectory } = await files.identify(scheme.dacPath);
      if (!isDirectory) {
        throw httpError(400, `${scheme.schemeName}: ${scheme.dacPath} is not a DAC export folder`);
      }
      const anchor = path.join(absolute, 'SEL_RTAC', 'DAC', 'DeviceDeclarations.xml');
      if (!(await stat(anchor).catch(() => null))?.isFile()) {
        throw httpError(400,
          `${scheme.schemeName}: ${scheme.dacPath} is not organized for the converter — it needs `
          + 'its DAC logic (AreaMap.xml, DeviceDeclarations.xml, Initializations/) under '
          + 'SEL_RTAC/DAC/. Reorganize the DAC project and re-export it.');
      }
      sources.push(absolute);
    }

    const { runId, dir } = await this.workspace.createRun('dacsim');
    for (const [index, scheme] of staged.entries()) {
      await cp(sources[index], path.join(dir, scheme.dac.subFolder), {
        recursive: true,
        // Never drag store bookkeeping (.versions etc.) into the bundle.
        filter: (source) => !path.basename(source).startsWith('.'),
      });
    }
    const settings = staged.map(({ dacPath, ...scheme }) => scheme);
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
    return { run: runId, schemes: parseSchemes(JSON.stringify(settings)) };
  }

  /**
   * The whole pipeline as one job: stage, convert, and land the generated
   * simulator projects back in the source project's tree (versioned .rtac
   * entries under "DAC SIM Converter/"). From there, any of them imports
   * into AcRTAC via the tree's generic "Import to AcRTAC" action.
   */
  async generate(files, payload) {
    const { run: runId, schemes: staged } = await this.stageFromProject(files, payload);
    const dir = await this.workspace.runDir('dacsim', runId);
    const workspace = this.workspace;

    const job = this.jobs.start(`DAC SIM generate: ${staged.length} scheme(s)`, async (handle) => {
      handle.log(`Converting ${staged.length} scheme(s)…`);
      const result = await runStdinBridge(CONVERT_SCRIPT, { root: dir }, {
        onStderrLine: handle.log,
        explain: EXPLAIN,
      });

      // The GENERATED simulator folders (remote + master) — the DAC inputs
      // came from the project and stay in the run only for reference.
      // Prefix-matched: a large scheme can split into "X_REMOTE", "X_REMOTE_2", …
      const simPrefixes = [...new Set(staged
        .flatMap((scheme) => [scheme.remoteFolder, scheme.logicFolder]))];
      const simDirs = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()
          && simPrefixes.some((prefix) => entry.name.startsWith(prefix)))
        .map((entry) => entry.name)
        .sort();

      // ZIP for download / save-to-project.
      const zipped = await workspace.zipRun('dacsim', runId, ZIP_NAME, ({ path: rel }) =>
        simDirs.includes(rel.split('/')[0]));
      const reports = zipped
        ? [{ path: ZIP_NAME, label: `Simulator projects ZIP (${zipped} files)` }]
        : [];

      // Land each simulator in the source project as a versioned .rtac
      // entry under one top-level folder the user can rearrange from.
      await files.createFolder('', PROJECT_FOLDER).catch((err) => {
        if (err?.status !== 409) throw err;
      });
      const note = `generated by DAC SIM Converter (run ${runId})`;
      const placed = [];
      for (const simDir of simDirs) {
        const entryName = `${simDir}.rtac`;
        await files.placeEntry(PROJECT_FOLDER, entryName, note, async (target) => {
          await cp(path.join(dir, simDir), target, { recursive: true });
        }, { directory: true });
        placed.push(`${PROJECT_FOLDER}/${entryName}`);
        handle.log(`Placed ${PROJECT_FOLDER}/${entryName}`);
      }

      return { run: runId, ...result, files: zipped, reports, placed };
    });
    return { job: job.id, run: runId };
  }
}

export { DacsimService };
