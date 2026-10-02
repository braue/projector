// The project tree's generic AcRTAC actions on an RTAC export entry (the
// sidebar's right-click / double-click, not a Tools-pane tool), each a job
// in the app's registry with the bridge's narration streaming into its log:
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
  constructor({ jobs, catalog = null }) {
    this.jobs = jobs;
    // Imports add database projects: re-read the shared list after one.
    this.catalog = catalog;
  }

  /**
   * Import tree entries into the AcRTAC database, as ONE job — the bridge
   * runs them in order through a single AcRTAC session, so a batch never
   * races itself for the database.
   * payload: { items: [{ path, name }], deviceType, firmware } — each `name`
   * is what that database project will be called; the hardware applies to
   * the whole batch.
   */
  async import(files, payload) {
    const deviceType = requireField(payload?.deviceType, 'device type');
    const firmware = requireField(payload?.firmware, 'firmware');
    const raw = Array.isArray(payload?.items) ? payload.items : [];
    if (!raw.length) throw httpError(400, 'pick at least one RTAC entry to import');

    const items = [];
    const names = new Set();
    for (const item of raw) {
      const name = requireField(item?.name, 'name');
      const treePath = requireField(item?.path, 'path');
      if (names.has(name.toLowerCase())) {
        throw httpError(400, `two imports would both be called ${name} in AcRTAC`);
      }
      names.add(name.toLowerCase());
      const { absolute, isDirectory } = await files.identify(treePath);
      if (!isDirectory) {
        throw httpError(400, `${treePath} is not an RTAC export folder`);
      }
      items.push({ treePath, absolute, name });
    }

    const label = items.length === 1 ? items[0].name : `${items.length} projects`;
    const job = this.jobs.start(`AcRTAC import: ${label}`, async (handle) => {
      handle.log(`Importing ${label} into AcRTAC as ${deviceType} ${firmware}…`);
      const { results } = await runStdinBridge(IMPORT_SCRIPT, {
        items: items.map((item) => ({
          path: item.absolute,
          name: item.name,
          type: deviceType,
          version: firmware,
        })),
      }, { job: handle, explain: EXPLAIN });
      const failed = [];
      for (const [index, item] of items.entries()) {
        const outcome = results?.[index];
        if (!outcome?.success) {
          const reason = outcome?.error ?? 'AcRTAC reported no result';
          handle.log(`✗ ${item.name}: ${reason}`);
          failed.push(items.length === 1 ? reason : `${item.name}: ${reason}`);
          continue;
        }
        handle.log(`✓ ${item.name}`);
        // The entry now mirrors database project `name` — record it so "Open
        // in AcRTAC" stops guessing from the (renameable) entry name. Best
        // effort: the import itself already succeeded.
        await files.recordDatabase(item.treePath, item.name).catch(() => {});
      }
      if (failed.length < items.length) this.catalog?.refresh();
      if (failed.length) {
        const done = items.length - failed.length;
        throw new Error(items.length === 1
          ? failed[0]
          : `${done} of ${items.length} imported — failed: ${failed.join('; ')}`);
      }
      return { names: items.map((item) => item.name) };
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
        job: handle,
        explain: EXPLAIN,
        settleOnExit: true,
      }));
    return { job: job.id };
  }
}

export { AcrtacService };
