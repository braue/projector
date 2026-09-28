// RTAC Exporter — bulk-export AcRTAC database projects as XML trees or .exp
// files, ported from the standalone RTAC EXPORTER app. The export runs
// through the one AcRTAC database bridge (py/acrtac_bridge.py, via the
// catalog's client), which logs into the database itself with the fixed
// admin/TAIL pair; the exports land in a tool run instead of the old fixed
// C:\RTAC_exports path, zipped for download / save-to-project. The project
// list is the shared catalog (/api/acrtac/projects).

import { httpError } from '../../lib/http.js';

class RtacExportService {
  constructor({ workspace, jobs, catalog }) {
    this.workspace = workspace;
    this.jobs = jobs;
    this.catalog = catalog;
  }

  /** Export the chosen projects into a new run, as a job; the run ends up
   *  holding the trees/.exp files plus one ZIP of everything. */
  async startExport({ projects, format, projectPassword }) {
    if (!Array.isArray(projects) || projects.length === 0) {
      throw httpError(400, 'pick at least one project');
    }
    const exportFormat = format === 'xml' ? 'xml' : 'exp';
    const { runId, dir } = await this.workspace.createRun('rtac-export');
    const workspace = this.workspace;
    const job = this.jobs.start(`RTAC export: ${projects.length} project(s)`, async (handle) => {
      handle.log(`Exporting ${projects.length} project(s) as ${exportFormat.toUpperCase()}…`);
      const results = await this.catalog.client.export({
        projects,
        format: exportFormat,
        directory: dir,
        projectPassword: projectPassword || null,
        job: handle,
      });
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
