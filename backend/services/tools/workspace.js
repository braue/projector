// Tool run workspaces — the disk home of the Tools pane.
//
// Tools are global (not project-scoped), so their inputs and outputs live
// beside the projects rather than inside one: <dataDir>/tools/<tool>/<run>/.
// Each invocation of a tool gets its own run directory; results stay there
// until the run is deleted, downloadable at any time, and copyable into a
// project's Files store when the user wants to keep one.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

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
    const info = await this.#statOrNull(dir);
    if (!info?.isDirectory()) throw httpError(404, `no such run: ${runId}`);
    return dir;
  }

  async #statOrNull(absolute) {
    try {
      return await stat(absolute);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
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
    if (!(await this.#statOrNull(absolute))?.isFile()) {
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
}

export { ToolsWorkspace };
