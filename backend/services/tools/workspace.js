// Tool run workspaces — the disk home of the Tools pane.
//
// Tools are global (not project-scoped), so their inputs and outputs live
// beside the projects rather than inside one: <dataDir>/tools/<tool>/<run>/.
// Each invocation of a tool gets its own run directory; results stay there
// until the run is deleted, downloadable at any time, and copyable into a
// project's Files store when the user wants to keep one.

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { statOrNull } from '../../lib/fs.js';
import { httpError, resolveChild, resolveWithin } from '../../lib/http.js';

class ToolsWorkspace {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, 'tools');
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  /** New run directory for one tool invocation. */
  async createRun(tool) {
    const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const dir = path.join(this.#toolDir(tool), runId);
    await mkdir(dir, { recursive: true });
    return { runId, dir };
  }

  #toolDir(tool) {
    return resolveChild(this.root, String(tool ?? ''), `invalid tool id: ${tool}`);
  }

  /** The run's directory; 404 when it does not exist. */
  async runDir(tool, runId) {
    const dir = resolveChild(this.#toolDir(tool), String(runId ?? ''), `invalid run id: ${runId}`);
    const info = await statOrNull(dir);
    if (!info?.isDirectory()) throw httpError(404, `no such run: ${runId}`);
    return dir;
  }

  /** Every file in the run, as forward-slash relative paths. */
  async listFiles(tool, runId) {
    const dir = await this.runDir(tool, runId);
    const walk = async (current, rel) => {
      const entries = await readdir(current, { withFileTypes: true });
      const files = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(...await walk(path.join(current, entry.name), relPath));
        } else {
          const info = await stat(path.join(current, entry.name));
          files.push({ path: relPath, size: info.size, modifiedAt: info.mtime.toISOString() });
        }
      }
      return files;
    };
    return walk(dir, '');
  }

  /** Absolute path of one run file (for downloads); 404 unless it is a file. */
  async filePath(tool, runId, relPath) {
    const dir = await this.runDir(tool, runId);
    const absolute = resolveWithin(dir, relPath, `invalid file path: ${relPath}`);
    if (!(await statOrNull(absolute))?.isFile()) {
      throw httpError(404, `no such file: ${relPath}`);
    }
    return absolute;
  }

  async readFile(tool, runId, relPath) {
    return readFile(await this.filePath(tool, runId, relPath));
  }

  async removeRun(tool, runId) {
    await rm(await this.runDir(tool, runId), { recursive: true, force: true });
  }

  /**
   * Zip the run's files (those `include` accepts) into `zipName` at the run's
   * root, for download / save-to-project. Streams file-by-file: a bulk export
   * runs to hundreds of MB, and holding every file plus the compressed copy
   * in the heap at once is the OOM class the parse cache exists to prevent.
   * Returns how many files went in (0 = nothing matched, no zip written).
   */
  async zipRun(tool, runId, zipName, include = () => true) {
    const files = (await this.listFiles(tool, runId))
      .filter((file) => file.path !== zipName && include(file));
    if (!files.length) return 0;
    const dir = await this.runDir(tool, runId);
    const { Zip, ZipDeflate } = await import('fflate');
    const out = createWriteStream(path.join(dir, zipName));
    await new Promise((resolve, reject) => {
      const zip = new Zip();
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        reject(err);
      };
      zip.ondata = (err, chunk, final) => {
        if (err) return fail(err);
        out.write(chunk);
        if (final) out.end();
      };
      out.on('error', fail);
      out.on('close', () => {
        if (!failed) resolve();
      });
      (async () => {
        for (const file of files) {
          const entry = new ZipDeflate(file.path);
          zip.add(entry);
          for await (const chunk of createReadStream(path.join(dir, file.path))) {
            entry.push(chunk, false);
            // ondata writes synchronously as we push; honouring the write
            // stream's backpressure here keeps the buffered output bounded.
            if (out.writableNeedDrain) await once(out, 'drain');
          }
          entry.push(new Uint8Array(0), true);
        }
        zip.end();
      })().catch(fail);
    });
    return files.length;
  }
}

export { ToolsWorkspace };
