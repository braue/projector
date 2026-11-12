// QuickSet Extract — read a QuickSet database backup without restoring it.
//
// A Device Manager backup is an AES-encrypted ZIP of pg_dump files; only
// DMData.dump is read. Restoring a big one into QuickSet takes hours, and
// most of its size is load-profile history this tool never needs.
//
// Two ways in:
//   - a file in a project's tree: read in place from disk;
//   - a file from disk via the browser: the page posts the ZIP's tail
//     (locate), the backend names the byte range DMData.dump occupies, and
//     the page streams just that slice (start + feed). Nothing is copied
//     to disk and the 256 MB upload cap does not apply.
// A bare DMData.dump (already extracted) works the same way, unencrypted.
//
// The job streams the entry through AES and inflate into the dump parser,
// then builds the device tree, connections, newest settings per device, the
// CSVs and the standalone device browser. The password lives only in the
// job's memory.

import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';

import { toCsv } from '../../../lib/csv.js';
import { httpError } from '../../../lib/http.js';
import { parseDump } from './dump.js';
import { buildModel } from './model.js';
import { collectSettings, pivotSettings } from './parsers.js';
import { writeViewer } from './viewer.js';
import { NeedBytes, entryContent, entryRange, readDirectory } from './zip.js';

const TOOL = 'quickset';
const DUMP_NAME = /(^|[\\/])DMData\.dump$/i;
const FEED_TIMEOUT_MS = 60_000;

const REPORTS = [
  { path: 'QuickSet viewer.zip', label: 'Device browser (ZIP)' },
  { path: 'devices.csv', label: 'Devices' },
  { path: 'network.csv', label: 'Network settings' },
  { path: 'collection.csv', label: 'Event, SER and load profile settings' },
  { path: 'folders.csv', label: 'Folders' },
  { path: 'revisions.csv', label: 'Settings revisions' },
  { path: 'settings.csv', label: 'All settings' },
  { path: 'Settings files.zip', label: 'Settings files (ZIP)' },
];

// What the tool's table shows per device.
const TABLE_FIELDS = ['deviceId', 'folder', 'device', 'viaParent', 'deviceType', 'firmware', 'inService',
  'commType', 'ipAddress', 'telnetPort', 'settingsDate'];

const isDump = (name) => /\.dump$/i.test(String(name));

/** readAt over byte ranges the browser sent; asks for more when short. */
function rangesReader(ranges) {
  return async (start, length) => {
    const hit = ranges.find((r) => start >= r.start && start + length <= r.start + r.buffer.length);
    if (!hit) throw new NeedBytes(start, start + length);
    return hit.buffer.subarray(start - hit.start, start - hit.start + length);
  };
}

async function fileReader(absolute) {
  const handle = await open(absolute, 'r');
  const readAt = async (start, length) => {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  };
  return { readAt, close: () => handle.close() };
}

function findDump(entries) {
  const entry = entries.find((e) => DUMP_NAME.test(e.name));
  if (!entry) throw httpError(400, 'no DMData.dump in this ZIP — is it a QuickSet database backup?');
  return entry;
}

class QuicksetService {
  // run -> { resolve(stream), reject(err) } while a job waits for its bytes.
  #feeds = new Map();

  constructor({ workspace, jobs }) {
    this.workspace = workspace;
    this.jobs = jobs;
  }

  /**
   * Browser path, step 1. `size` is the file's size, `ranges` the byte
   * ranges sent ([{ start, buffer }], the tail first). Returns { need } when
   * the directory reaches outside them, else the slice to stream.
   */
  async locate({ name, size, ranges }) {
    if (isDump(name)) return { kind: 'dump', range: { start: 0, end: size } };
    let entries;
    try {
      entries = await readDirectory(rangesReader(ranges), size);
    } catch (err) {
      if (err instanceof NeedBytes) return { need: err.range };
      throw err;
    }
    const entry = findDump(entries);
    return {
      kind: 'zip',
      entry,
      encrypted: Boolean(entry.flags & 1),
      range: entryRange(entry, size),
    };
  }

  /**
   * Start a read. `source` is { project file: absolute } (read in place) or
   * { upload: located } from locate — then the bytes arrive through feed().
   * Returns { run, job }.
   */
  async start({ name, password, absolute = null, located = null }) {
    let entry = null;
    let range = null;
    if (absolute) {
      const size = (await stat(absolute)).size;
      if (isDump(name)) {
        range = { start: 0, end: size };
      } else {
        const reader = await fileReader(absolute);
        try {
          entry = findDump(await readDirectory(reader.readAt, size));
        } finally {
          await reader.close();
        }
        range = entryRange(entry, size);
      }
    } else if (located) {
      entry = located.kind === 'zip' ? located.entry : null;
      range = located.range;
    } else {
      throw httpError(400, 'nothing to read');
    }
    if (entry && entry.flags & 1 && !password) throw httpError(400, 'this backup is encrypted — enter its password');

    const { runId, dir } = await this.workspace.createRun(TOOL);
    const bytes = new Promise((resolve, reject) => {
      if (absolute) {
        resolve(createReadStream(absolute, { start: range.start, end: Math.max(range.start, range.end - 1) }));
        return;
      }
      const timer = setTimeout(() => {
        this.#feeds.delete(runId);
        reject(new Error('the file never arrived'));
      }, FEED_TIMEOUT_MS);
      this.#feeds.set(runId, {
        resolve: (stream) => { clearTimeout(timer); resolve(stream); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
    bytes.catch(() => {});
    const total = range.end - range.start;
    const job = this.jobs.start(`QuickSet backup: ${name}`, (handle) =>
      this.#read({ dir, runId, entry, password, bytes, total, handle }));
    return { run: runId, job: job.id };
  }

  /** Browser path, step 2: the request body carries the located slice.
   *  Resolves once the job has consumed it. */
  async feed(runId, stream) {
    const waiting = this.#feeds.get(runId);
    if (!waiting) throw httpError(404, `no read waiting for run ${runId}`);
    this.#feeds.delete(runId);
    const done = new Promise((resolve) => {
      stream.on('end', resolve);
      stream.on('close', resolve);
      stream.on('error', resolve);
    });
    waiting.resolve(stream);
    await done;
    return { ok: true };
  }

  async #read({ dir, runId, entry, password, bytes, total, handle }) {
    const size = entry ? entry.size : total;
    handle.log(`Reading DMData.dump (${size >= 1e9 ? `${(size / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(size / 1e6))} MB`})`);
    const blobDir = path.join(dir, '.blobs');
    await mkdir(blobDir, { recursive: true });
    const raw = await bytes;
    const stop = () => raw.destroy(new Error('Aborted'));
    handle.signal.addEventListener('abort', stop, { once: true });
    // Progress counts the raw bytes in a pass-through, piped in the same tick
    // the stream is handed over: a 'data' listener would set it flowing and
    // drop whatever arrived before the parser started reading.
    let seen = 0;
    let last = 0;
    const counted = new Transform({
      transform(chunk, _enc, done) {
        seen += chunk.length;
        if (seen - last > 8 * 1024 * 1024) {
          last = seen;
          handle.progress(Math.min(0.99, seen / total) * 0.9);
        }
        done(null, chunk);
      },
    });
    raw.on('error', (err) => counted.destroy(err));
    raw.pipe(counted);

    let content = counted;
    let decrypt = null;
    if (entry) {
      const { input, output } = entryContent(entry, password);
      counted.on('error', (err) => input.destroy(err));
      counted.pipe(input);
      content = output;
      decrypt = input;
    }
    try {
      let tables;
      try {
        ({ tables } = await parseDump(content, { blobDir, signal: handle.signal }));
        // The slice runs a little past the entry; let it drain so the
        // decryptor reaches its end and checks the authentication code.
        if (decrypt && decrypt !== content) await finished(decrypt);
      } catch (err) {
        raw.destroy();
        throw err;
      }
      handle.log(`Read ${tables['public.device'].rows.length} device records`);
      const { unzipSync } = await import('fflate');
      const model = await buildModel(tables, {
        dir,
        blobDir,
        unzip: (buffer) => unzipSync(new Uint8Array(buffer)),
        log: (line) => handle.log(line),
      });
      await writeViewer(dir, model);
      handle.progress(0.95);
      await this.workspace.zipRun(TOOL, runId, 'QuickSet viewer.zip', (f) => f.path.startsWith('viewer/'));
      await this.workspace.zipRun(TOOL, runId, 'Settings files.zip', (f) => f.path.startsWith('configs/'));
      await writeFile(path.join(dir, 'devices.json'), JSON.stringify({ folders: model.folders.length, devices: model.devices }));
      const withSettings = model.devices.filter((d) => d.settingsFolder).length;
      handle.log(`${model.devices.length} devices, ${model.folders.length} folders, ${withSettings} with settings`);
      return { run: runId };
    } finally {
      handle.signal.removeEventListener('abort', stop);
      await rm(blobDir, { recursive: true, force: true });
    }
  }

  async #devices(runId) {
    const dir = await this.workspace.runDir(TOOL, runId);
    try {
      const saved = JSON.parse(await readFile(path.join(dir, 'devices.json'), 'utf8'));
      return { dir, devices: saved.devices, folders: saved.folders };
    } catch {
      throw httpError(404, `run ${runId} has no finished read`);
    }
  }

  /** The finished read: the device table and the outputs. */
  async result(runId) {
    const { devices, folders } = await this.#devices(runId);
    const rows = devices.map((d) => Object.fromEntries(TABLE_FIELDS.map((k) => [k, d[k] ?? ''])));
    return {
      tool: TOOL,
      run: runId,
      rows,
      folders,
      withSettings: devices.filter((d) => d.settingsFolder).length,
      reports: REPORTS,
    };
  }

  /** The device browser's files, for opening it in a browser. */
  async viewerFile(runId, relPath) {
    return this.workspace.filePath(TOOL, runId, `viewer/${relPath}`);
  }

  /** Extract chosen settings across the fleet, pivoted. */
  async extract(runId, targetSettings) {
    const targets = [...new Set((targetSettings ?? []).map((s) => String(s).trim()).filter(Boolean))];
    if (!targets.length) throw httpError(400, 'no setting names given');
    const { dir, devices } = await this.#devices(runId);
    const { rows, filesChecked } = await collectSettings(dir, devices, targets);
    const pivot = pivotSettings(rows, targets);
    const report = { path: 'settings extract.csv', label: 'Settings extract' };
    await writeFile(path.join(dir, report.path), toCsv(
      pivot.columns,
      pivot.rows.map((row) => pivot.columns.map((c) => row[c] ?? '')),
    ));
    return {
      tool: TOOL,
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
