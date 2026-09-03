// The project tree's generic AcRTAC actions on an RTAC export entry (the
// sidebar's right-click / double-click, not a Tools-pane tool), each a job
// the frontend polls with the bridge's narration streaming into the log:
//   import — the entry's folder-of-XML goes into the AcRTAC database via
//            py/acrtac_import.py with the user's device type + firmware.
//   open   — launch the AcSELerator RTAC GUI on the database project with
//            the entry's name via py/acrtac_open.py (the GUI outlives the
//            bridge; nothing is read back).

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const IMPORT_SCRIPT = 'acrtac_import.py';
const OPEN_SCRIPT = 'acrtac_open.py';

/** These actions' own wording for the failure classes runStdinBridge shapes. */
const EXPLAIN = {
  python: 'Python was not found on PATH — install Python and the selacrtac package to use AcRTAC from here.',
  selacrtac: 'Python is installed but the selacrtac package is missing, so AcRTAC cannot be reached from here.',
};

function requireField(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

class AcrtacService {
  constructor({ jobs }) {
    this.jobs = jobs;
  }

  /**
   * Import one tree entry into the AcRTAC database, as a job.
   * payload: { path, name, deviceType, firmware } — `name` is what the
   * database project will be called.
   */
  async import(files, payload) {
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
      // The entry now mirrors database project `name` — record it so "Open
      // in AcRTAC" stops guessing from the (renameable) entry name. Best
      // effort: the import itself already succeeded.
      await files.recordDatabase(treePath, name).catch(() => {});
      return { name };
    });
    return { job: job.id };
  }

  /**
   * Open the database project called `name` in the AcSELerator RTAC GUI, as
   * a job. The tree entry's bytes play no part — the NAME must exist in the
   * database (the bridge says to import first when it does not).
   */
  open(payload) {
    const name = requireField(payload?.name, 'name');
    const job = this.jobs.start(`Open in AcRTAC: ${name}`, (handle) =>
      // settleOnExit: the GUI this bridge starts outlives it holding the
      // stdio pipes — waiting for 'close' would never settle the job.
      runStdinBridge(OPEN_SCRIPT, { name }, {
        onStderrLine: handle.log,
        explain: EXPLAIN,
        settleOnExit: true,
      }));
    return { job: job.id };
  }
}

export { AcrtacService };
