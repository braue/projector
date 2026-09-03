// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// a folder of exported DAC project XML plus its settings.json, ported from
// the standalone DACSIMCONVERT app. The vendored dacToSim package does the
// conversion in py/dacsim_convert.py, headless: prompts auto-skip (the
// package scaffolds its own warning notes), progress streams into the job
// log, and the generated SIM folders land in the run beside the inputs —
// zipped for download / save-to-project. Importing the results into AcRTAC
// stays with AcRTAC itself (the converter's optional import needs selacrtac
// and versioned type/firmware choices better made in the database UI).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { bridgeMessage, bridgePath, PYTHON } from '../../lib/acrtac/pythonClient.js';

const SCRIPT = 'dacsim_convert.py';
const TEMPLATE = 'dacsim_settings_template.json';
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;
const ZIP_NAME = 'sim projects.zip';

/** The scheme list from a bundle's settings.json — the converter's own
 *  Python validation is authoritative; this is the cheap Node-side read the
 *  upload response and output-zip selection are built from. */
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

function cleanFolder(value, fallback) {
  const name = String(value ?? '').trim() || fallback;
  if (!/^[A-Za-z0-9 _.-]+$/.test(name)) {
    throw httpError(400, `folder name must be letters, digits, spaces, _ - . : ${name}`);
  }
  return name;
}

/** Run the converter over `dir`, streaming its narration into `log`. */
function runConvertBridge(dir, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [bridgePath(SCRIPT)], { windowsHide: true });
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
        reject(new Error(`dacsim bridge returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify({ root: dir }));
  });
}

class DacsimService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /** The starter settings.json, for the UI's download link. */
  async settingsTemplate() {
    return readFile(bridgePath(TEMPLATE), 'utf8');
  }

  /**
   * Stage 1: a ZIP of the DAC export bundle — the folder holding
   * settings.json beside the "DAC 1", "SIM 1", … subfolders — becomes a new
   * run. A single wrapping top folder (how archivers export a directory) is
   * stripped.
   */
  async uploadBundle(upload) {
    const { unzipSync } = await import('fflate');
    let entries;
    try {
      entries = unzipSync(new Uint8Array(upload.buffer));
    } catch {
      throw httpError(400, 'not a readable ZIP file');
    }
    const paths = Object.keys(entries).filter((p) => !p.endsWith('/'));
    if (!paths.length) throw httpError(400, 'the ZIP is empty');
    const tops = new Set(paths.map((p) => p.split('/')[0]));
    const strip = tops.size === 1 && paths.every((p) => p.includes('/')) ? 1 : 0;
    const stripped = new Map(paths
      .map((entryPath) => [entryPath.split('/').slice(strip).join('/'), entryPath])
      .filter(([rel]) => rel));
    if (!stripped.has('settings.json')) {
      throw httpError(400, 'the ZIP must hold settings.json beside the DAC export folders');
    }
    const schemes = parseSchemes(Buffer.from(entries[stripped.get('settings.json')]).toString('utf8'));

    const { runId, dir } = await this.workspace.createRun('dacsim');
    for (const [rel, entryPath] of stripped) {
      const target = path.join(dir, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entries[entryPath]);
    }
    return { run: runId, schemes };
  }

  /**
   * The projector-native stage 1: DAC exports already living in a project's
   * tree (`.rtac` entries — the same AcRTAC XML-export shape) are copied
   * into a new run and settings.json is written FROM the form fields, so
   * nobody hand-authors it. Same staged-bundle response as the ZIP path.
   *
   * payload: { schemes: [{ schemeName, dacPath, dacIps[], remoteIp }],
   *            masterFolder?, masterIp, defaultLoad? }
   */
  async stageFromProject(files, payload) {
    const schemes = Array.isArray(payload?.schemes) ? payload.schemes : [];
    if (!schemes.length) throw httpError(400, 'add at least one scheme');
    const masterFolder = cleanFolder(payload?.masterFolder, 'SIM Master');
    const masterIp = requireIp(payload?.masterIp, 'master IP');
    const defaultLoad = Number(payload?.defaultLoad) || 10;

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

  /** Stage 2 as a job: run the converter over the bundle; the generated SIM
   *  folders join the run, zipped for download / save-to-project. */
  async startConvert(runId) {
    const dir = await this.workspace.runDir('dacsim', runId);
    const schemes = parseSchemes(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    const workspace = this.workspace;
    const job = this.jobs.start(`DAC SIM convert: ${schemes.length} scheme(s)`, async (handle) => {
      handle.log(`Converting ${schemes.length} scheme(s)…`);
      const result = await runConvertBridge(dir, handle.log);

      // Zip just the GENERATED simulator folders (remote + master) — the DAC
      // inputs came from the user and are still in the run for reference.
      // Prefix-matched on the top folder: a large scheme can split into
      // "SIM 1", "SIM 1_2", … simulators.
      const simPrefixes = [...new Set(schemes
        .flatMap((scheme) => [scheme.remoteFolder, scheme.logicFolder]))];
      const files = (await workspace.listFiles('dacsim', runId)).filter(({ path: rel }) => {
        const top = rel.split('/')[0];
        return simPrefixes.some((prefix) => top.startsWith(prefix));
      });
      const reports = [];
      if (files.length) {
        const { zipSync } = await import('fflate');
        const zipEntries = {};
        for (const file of files) {
          zipEntries[file.path] = new Uint8Array(await workspace.readFile('dacsim', runId, file.path));
        }
        await writeFile(path.join(dir, ZIP_NAME), zipSync(zipEntries));
        reports.push({ path: ZIP_NAME, label: `Simulator projects ZIP (${files.length} files)` });
      }
      return { run: runId, ...result, files: files.length, reports };
    });
    return { job: job.id, run: runId };
  }
}

export { DacsimService };
