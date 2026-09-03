// RTAC Exporter — bulk-export AcRTAC database projects as XML trees or .exp
// files, ported from the standalone RTAC EXPORTER app. The selacrtac work
// runs in py/acrtac_export.py, which logs into the database itself with the
// fixed admin/TAIL pair (same as acrtac_bridge.py); the request travels as
// JSON on the bridge's stdin, and the exports land in a tool run instead of
// the old fixed C:\RTAC_exports path, zipped for download / save-to-project.

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const SCRIPT = 'acrtac_export.py';

class RtacExportService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  async listProjects() {
    const result = await runStdinBridge(SCRIPT, { command: 'list' });
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
      const { results } = await runStdinBridge(SCRIPT, {
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
      const zipName = 'rtac exports.zip';
      const zipped = await workspace.zipRun('rtac-export', runId, zipName);
      const reports = zipped
        ? [{ path: zipName, label: `Exports ZIP (${zipped} files)` }]
        : [];
      const succeeded = results.filter((r) => r.success).length;
      return { run: runId, succeeded, failed: results.length - succeeded, results, reports };
    });
    return { job: job.id, run: runId };
  }
}

export { RtacExportService };
