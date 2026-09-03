// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// DAC exports already in a project's tree, ported from the standalone
// DACSIMCONVERT app. One Generate does the whole pipeline: staging copies
// the picked .rtac entries into a run and generates settings.json from the
// form fields (nobody hand-authors it); the vendored dacToSim package
// converts in py/dacsim_convert.py, headless (prompts auto-skip onto the
// package's own warning scaffolds, narration streams into the job log); the
// generated simulator folders land back in the SOURCE PROJECT's tree as
// versioned .rtac entries under "DAC SIM Converter/"; and each one imports
// into the AcRTAC database via py/acrtac_import.py with the user's device
// type + firmware (per scheme for remotes, one pair for the master).
// Import failures never cost the run — the outputs are already safe in the
// project — they land in the result for the UI to show.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { bridgeMessage, bridgePath, PYTHON } from '../../lib/acrtac/pythonClient.js';

const CONVERT_SCRIPT = 'dacsim_convert.py';
const IMPORT_SCRIPT = 'acrtac_import.py';
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;
const ZIP_NAME = 'sim projects.zip';
const PROJECT_FOLDER = 'DAC SIM Converter';

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

function requireField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

/** Run a python bridge with `request` on stdin, streaming its stderr
 *  narration into `log`; resolves the JSON document from stdout. */
function runBridge(script, request, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [bridgePath(script)], { windowsHide: true });
    let stdout = '';
    const lastLines = [];
    const timer = setTimeout(() => {
      child.kill();
    }, BRIDGE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      log(line);
      lastLines.push(line);
      if (lastLines.length > 20) lastLines.shift();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(bridgeMessage(err, lastLines.join('\n'))));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new Error(bridgeMessage({ killed: Boolean(signal), code }, lastLines.join('\n'))));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${script} returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
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
        remote: { subFolder: `SIM ${schemeName}`, ipAddr: requireIp(scheme?.remoteIp, `${schemeName}: remote IP`) },
        logic: { subFolder: masterFolder, ipAddr: masterIp },
        nameConversions: [],
        parameters: { defaultLoad },
      };
    });

    // Resolve every DAC entry BEFORE creating the run, so a bad pick fails
    // clean instead of leaving a half-staged run.
    const sources = [];
    for (const scheme of staged) {
      const { absolute, isDirectory } = await files.identify(scheme.dacPath);
      if (!isDirectory) {
        throw httpError(400, `${scheme.schemeName}: ${scheme.dacPath} is not a DAC export folder`);
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
   * The whole pipeline as one job: stage, convert, land the generated
   * simulator projects back in the source project's tree (versioned .rtac
   * entries under "DAC SIM Converter/"), and import each into the AcRTAC
   * database with the user's device type + firmware.
   *
   * payload adds to staging: per scheme { deviceType, firmware }, plus
   * { masterDeviceType, masterFirmware } for the one master project.
   */
  async generate(files, payload) {
    const schemes = Array.isArray(payload?.schemes) ? payload.schemes : [];
    // Import targeting validates BEFORE any staging or job.
    const importsByPrefix = schemes.map((scheme, index) => ({
      prefix: `SIM ${String(scheme?.schemeName ?? '').trim()}`,
      deviceType: requireField(scheme?.deviceType, `scheme ${index + 1}: device type`),
      firmware: requireField(scheme?.firmware, `scheme ${index + 1}: firmware`),
    }));
    const master = {
      deviceType: requireField(payload?.masterDeviceType, 'master device type'),
      firmware: requireField(payload?.masterFirmware, 'master firmware'),
    };

    const { run: runId, schemes: staged } = await this.stageFromProject(files, payload);
    const dir = await this.workspace.runDir('dacsim', runId);
    const workspace = this.workspace;
    const masterFolder = staged[0].logicFolder;

    const job = this.jobs.start(`DAC SIM generate: ${staged.length} scheme(s)`, async (handle) => {
      handle.log(`Converting ${staged.length} scheme(s)…`);
      const result = await runBridge(CONVERT_SCRIPT, { root: dir }, handle.log);

      // The GENERATED simulator folders (remote + master) — the DAC inputs
      // came from the project and stay in the run only for reference.
      // Prefix-matched: a large scheme can split into "SIM X", "SIM X_2", …
      const simPrefixes = [...new Set(staged
        .flatMap((scheme) => [scheme.remoteFolder, scheme.logicFolder]))];
      const simDirs = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()
          && simPrefixes.some((prefix) => entry.name.startsWith(prefix)))
        .map((entry) => entry.name)
        .sort();

      // ZIP for download / save-to-project.
      const outputs = (await workspace.listFiles('dacsim', runId)).filter(({ path: rel }) =>
        simDirs.includes(rel.split('/')[0]));
      const reports = [];
      if (outputs.length) {
        const { zipSync } = await import('fflate');
        const zipEntries = {};
        for (const file of outputs) {
          zipEntries[file.path] = new Uint8Array(await workspace.readFile('dacsim', runId, file.path));
        }
        await writeFile(path.join(dir, ZIP_NAME), zipSync(zipEntries));
        reports.push({ path: ZIP_NAME, label: `Simulator projects ZIP (${outputs.length} files)` });
      }

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

      // Import into AcRTAC: the master gets its one device/firmware pair,
      // every other sim folder inherits its scheme's. Failures are reported,
      // never fatal — the projects are already safe in the tree.
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '');
      const items = simDirs.map((simDir) => {
        const target = simDir.startsWith(masterFolder)
          ? master
          : importsByPrefix.find(({ prefix }) => simDir.startsWith(prefix));
        return target && {
          path: path.join(dir, simDir),
          name: `${simDir} ${stamp}`,
          type: target.deviceType,
          version: target.firmware,
        };
      }).filter(Boolean);
      let imports = null;
      let importError = null;
      try {
        handle.log(`Importing ${items.length} project(s) into AcRTAC…`);
        const response = await runBridge(IMPORT_SCRIPT, { items }, handle.log);
        imports = response.results;
        for (const entry of imports) {
          handle.log(entry.success ? `✓ ${entry.name}` : `✕ ${entry.name}: ${entry.error}`);
        }
      } catch (err) {
        importError = err?.message ?? String(err);
        handle.log(`AcRTAC import failed: ${importError}`);
      }

      return { run: runId, ...result, files: outputs.length, reports, placed, imports, importError };
    });
    return { job: job.id, run: runId };
  }
}

export { DacsimService };
