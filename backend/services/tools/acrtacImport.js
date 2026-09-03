// Import to AcRTAC — the project tree's generic action on any RTAC export
// entry (the sidebar's right-click, not a Tools-pane tool). One entry's
// folder-of-XML goes into the AcRTAC database via py/acrtac_import.py with
// the user's device type + firmware, as a job the modal polls; the bridge's
// narration streams into the job log.

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const IMPORT_SCRIPT = 'acrtac_import.py';

/** This action's own wording for the failure classes runStdinBridge shapes. */
const EXPLAIN = {
  python: 'Python was not found on PATH — install Python and the selacrtac package to import into AcRTAC.',
  selacrtac: 'Python is installed but the selacrtac package is missing, so projects cannot be imported into AcRTAC.',
};

function requireField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

class AcrtacImportService {
  constructor({ jobs }) {
    this.jobs = jobs;
  }

  /**
   * Import one tree entry into the AcRTAC database, as a job.
   * payload: { path, name, deviceType, firmware } — `name` is what the
   * database project will be called.
   */
  async start(files, payload) {
    const name = requireField(payload?.name, 'name');
    const deviceType = requireField(payload?.deviceType, 'device type');
    const firmware = requireField(payload?.firmware, 'firmware');
    const treePath = requireField(payload?.path, 'path');
    const { absolute, isDirectory } = await files.identify(treePath);
    if (!isDirectory) {
      throw httpError(400, `${treePath} is not an RTAC export folder`);
    }

    const job = this.jobs.start(`AcRTAC import: ${name}`, async (handle) => {
      handle.log(`Importing ${name} into AcRTAC as ${deviceType} ${firmware}…`);
      const { results } = await runStdinBridge(IMPORT_SCRIPT, {
        items: [{ path: absolute, name, type: deviceType, version: firmware }],
      }, { onStderrLine: handle.log, explain: EXPLAIN });
      const outcome = results?.[0];
      if (!outcome?.success) {
        throw new Error(outcome?.error ?? 'AcRTAC reported no result for the import');
      }
      handle.log(`✓ ${name}`);
      return { name };
    });
    return { job: job.id };
  }
}

export { AcrtacImportService };
