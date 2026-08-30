// QuickSet Extract — the tool facade: get a tree of exported relay configs
// into a run (database dump as a job, or an uploaded ZIP), then run the
// inventory and settings extraction over it. Results render in the UI and
// land in the run as CSVs for download / save-to-project.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toCsv } from '../../../lib/csv.js';
import { httpError } from '../../../lib/http.js';
import { dumpQuicksetDatabase } from './dump.js';
import { collectDeviceInfo, collectSettings, pivotSettings } from './parsers.js';

// The exported tree lives under this subdir of the run, so reports written
// beside it never mix with device folders.
const CONFIGS = 'configs';

class QuicksetService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /** Stage 1 as a job: dump the QuickSet Postgres database into a new run. */
  async startDump(config) {
    if (!config?.dbname) throw httpError(400, 'database name required');
    const { runId, dir } = await this.workspace.createRun('quickset');
    const configsDir = path.join(dir, CONFIGS);
    await mkdir(configsDir, { recursive: true });
    const job = this.jobs.start(`QuickSet dump: ${config.dbname}`, async (handle) => {
      const tallies = await dumpQuicksetDatabase(config, configsDir, handle);
      return { run: runId, ...tallies };
    });
    return { job: job.id, run: runId };
  }

  /** Alternative stage 1: an uploaded ZIP of an exported_configs tree. */
  async uploadConfigs(upload) {
    const { unzipSync } = await import('fflate');
    let entries;
    try {
      entries = unzipSync(new Uint8Array(upload.buffer));
    } catch {
      throw httpError(400, 'not a readable ZIP file');
    }
    const { runId, dir } = await this.workspace.createRun('quickset');
    const configsDir = path.join(dir, CONFIGS);
    // The ZIP may wrap the tree in one top folder (how archivers usually
    // export a directory) — detect that and strip it.
    const paths = Object.keys(entries).filter((p) => !p.endsWith('/'));
    if (!paths.length) throw httpError(400, 'the ZIP is empty');
    const tops = new Set(paths.map((p) => p.split('/')[0]));
    const strip = tops.size === 1 && paths.every((p) => p.includes('/')) ? 1 : 0;
    for (const entryPath of paths) {
      const parts = entryPath.split('/').slice(strip);
      if (!parts.length) continue;
      const target = path.join(configsDir, ...parts);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entries[entryPath]);
    }
    return { run: runId };
  }

  /** Stage 2: the relay inventory, rendered and written as CSV. */
  async inventory(runId) {
    const dir = await this.workspace.runDir('quickset', runId);
    const rows = await collectDeviceInfo(path.join(dir, CONFIGS));
    const report = { path: 'relay inventory.csv', label: 'Relay inventory CSV' };
    await writeFile(path.join(dir, report.path), toCsv(
      ['Location', 'Device', 'Relay type', 'Firmware'],
      rows.map((r) => [r.location, r.device, r.relayType, r.firmware]),
    ));
    return { tool: 'quickset', run: runId, rows, reports: [report] };
  }

  /** Stage 3: extract chosen settings across the fleet, pivoted. */
  async extract(runId, targetSettings) {
    const targets = [...new Set((targetSettings ?? []).map((s) => String(s).trim()).filter(Boolean))];
    if (!targets.length) throw httpError(400, 'no setting names given');
    const dir = await this.workspace.runDir('quickset', runId);
    const { rows, filesChecked } = await collectSettings(path.join(dir, CONFIGS), targets);
    const pivot = pivotSettings(rows, targets);
    const report = { path: 'settings extract.csv', label: 'Settings extract CSV' };
    await writeFile(path.join(dir, report.path), toCsv(
      pivot.columns,
      pivot.rows.map((row) => pivot.columns.map((c) => row[c] ?? '')),
    ));
    return {
      tool: 'quickset',
      run: runId,
      filesChecked,
      hits: rows.length,
      columns: pivot.columns,
      rows: pivot.rows,
      reports: [report],
    };
  }
}

export { QuicksetService };
