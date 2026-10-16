// Automatic FAT → Excel — fills a FAT workbook's Fault Test, Open Phase,
// Miscoordination and Abnormal Condition checkout sheets from the DAC
// simulator's automatic-FAT HTML report, in the workbook's own style.
//
// Inputs are a FAT workbook and a report, each either a file in a project's
// tree or an upload. The converted workbook keeps the input's name, so when
// the workbook came from a project, Save lands it as a NEW VERSION of that
// same entry (nothing touches the tree before Save); an uploaded workbook's
// result goes out through the usual Download / Save to project.
//
// The conversion itself is fatsheets/ (pure buffers in and out).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { convertAutoFat } from './fatsheets/index.js';

const MANIFEST = '.fatsheets-manifest.json';
const WORKBOOK_EXT = /\.(xlsm|xlsx)$/i;
const LABEL = {
  fault: 'fault', openPhase: 'open phase', miscoordination: 'miscoordination', abnormal: 'abnormal',
};

function versionNote(sheets, reportName) {
  const counts = sheets.map((s) => `${s.count} ${LABEL[s.kind]}`).join(', ');
  return `Automatic FAT sheets: ${counts} from ${reportName}`;
}

class FatSheetsService {
  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /**
   * inputs: { workbook, report } — each { name, buffer } (an upload) or
   * { project, path } (a project file, read through `filesFor(project)`).
   * Returns { job, run }; the job's result describes what was written.
   */
  async generate(filesFor, { workbook, report, engineer = '' }) {
    if (!workbook) throw httpError(400, 'pick the FAT workbook (.xlsm or .xlsx)');
    if (!report) throw httpError(400, 'pick the automatic FAT report (.html)');
    const workbookName = workbook.name ?? path.basename(String(workbook.path ?? ''));
    if (!WORKBOOK_EXT.test(workbookName)) throw httpError(400, `${workbookName} is not an .xlsm or .xlsx workbook`);
    const reportName = report.name ?? path.basename(String(report.path ?? ''));

    const read = async (input) => (input.buffer ?? (await filesFor(input.project)).read(input.path));
    const { runId, dir: runDir } = await this.workspace.createRun('fatsheets');
    const source = workbook.project ? { project: workbook.project, path: workbook.path } : null;

    const job = this.jobs.start(`Automatic FAT → ${workbookName}`, async (handle) => {
      const [workbookBytes, reportBytes] = await Promise.all([read(workbook), read(report)]);
      handle.log(`Reading ${reportName}`);
      const result = await convertAutoFat({
        workbook: workbookBytes,
        html: reportBytes.toString('utf8'),
        engineer: String(engineer).trim(),
      });
      for (const sheet of result.sheets) {
        handle.log(`${sheet.name}: ${sheet.count} test${sheet.count === 1 ? '' : 's'}${sheet.replaced ? ' (replaced the existing sheet)' : ''}`);
      }
      if (result.bands.unbanded.length) {
        handle.log(`No substation band found for ${result.bands.unbanded.join(', ')} — banded by feeder`);
      }
      await writeFile(path.join(runDir, workbookName), result.buffer);
      const note = versionNote(result.sheets, reportName);
      await writeFile(path.join(runDir, MANIFEST), JSON.stringify({ source, workbookName, note }, null, 2));
      return {
        run: runId,
        workbookName,
        reportName,
        reportTitle: result.title,
        source,
        sheets: result.sheets,
        bands: result.bands,
        flagged: result.flagged,
        note,
        reports: [{ path: workbookName, label: workbookName }],
      };
    });
    return { job: job.id, run: runId };
  }

  /**
   * Land the converted workbook as a new version of the entry it was made
   * from. placeEntry archives the current bytes first, so the workbook as it
   * was before the conversion stays one click away in its history.
   */
  async save(filesFor, runId) {
    const runDir = await this.workspace.runDir('fatsheets', runId);
    const manifest = JSON.parse(
      (await this.workspace.readFile('fatsheets', runId, MANIFEST)).toString(),
    );
    const { source, workbookName, note } = manifest;
    if (!source) {
      throw httpError(409, 'this workbook was uploaded, not picked from a project — use Save to project instead');
    }
    const files = await filesFor(source.project);
    const dir = path.posix.dirname(source.path) === '.' ? '' : path.posix.dirname(source.path);
    const bytes = await readFile(path.join(runDir, workbookName));
    await files.placeEntry(dir, path.posix.basename(source.path), note, (target) => writeFile(target, bytes));
    return { project: source.project, placed: source.path, note };
  }
}

export { FatSheetsService };
