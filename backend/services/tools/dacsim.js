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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
