// RTAC Exporter — bulk-export AcRTAC database projects as XML trees or .exp
// files, ported from the standalone RTAC EXPORTER app. The selacrtac work
// runs in py/acrtac_export.py, which logs into the database itself with the
// fixed admin/TAIL pair (same as acrtac_bridge.py); the request travels as
// JSON on the bridge's stdin, and the exports land in a tool run instead of
// the old fixed C:\RTAC_exports path, zipped for download / save-to-project.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { bridgeMessage, bridgePath, PYTHON } from '../../lib/acrtac/pythonClient.js';

const SCRIPT = 'acrtac_export.py';
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/** One bridge invocation: request JSON on stdin, result JSON on stdout. */
function runExportBridge(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [bridgePath(SCRIPT)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, BRIDGE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(bridgeMessage(err, stderr)));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) {
        reject(new Error(bridgeMessage({ killed: Boolean(signal), code }, stderr)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`acrtac export bridge returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

class RtacExportService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  async listProjects() {
    const result = await runExportBridge({ command: 'list' });
    return { projects: result.projects };
  }

  /** Export the chosen projects into a new run, as a job; the run ends up
   *  holding the trees/.exp files plus one ZIP of everything. */
  async startExport({ projects, format, projectPassword }) {
    if (!Array.isArray(projects) || projects.length === 0) {
      throw httpError(400, 'pick at least one project');
    }
    const exportFormat = format === 'exp' ? 'exp' : 'xml';
    const { runId, dir } = await this.workspace.createRun('rtac-export');
    const workspace = this.workspace;
    const job = this.jobs.start(`RTAC export: ${projects.length} project(s)`, async (handle) => {
      handle.log(`Exporting ${projects.length} project(s) as ${exportFormat.toUpperCase()}…`);
      const { results } = await runExportBridge({
        command: 'export',
        projects,
        format: exportFormat,
        directory: dir,
        projectPassword: projectPassword || null,
      });
      for (const entry of results) {
        handle.log(entry.success ? `✓ ${entry.project}` : `✕ ${entry.project}: ${entry.error}`);
      }
      // One ZIP of the whole run for download / save-to-project.
      const files = await workspace.listFiles('rtac-export', runId);
      const reports = [];
      if (files.length) {
        const { zipSync } = await import('fflate');
        const entries = {};
        for (const file of files) {
          entries[file.path] = new Uint8Array(await workspace.readFile('rtac-export', runId, file.path));
        }
        const zipName = 'rtac exports.zip';
        await writeFile(path.join(dir, zipName), zipSync(entries));
        reports.push({ path: zipName, label: `Exports ZIP (${files.length} files)` });
      }
      const succeeded = results.filter((r) => r.success).length;
      return { run: runId, succeeded, failed: results.length - succeeded, results, reports };
    });
    return { job: job.id, run: runId };
  }
}

export { RtacExportService };
