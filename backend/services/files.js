// Project files — generic documents (PDFs, Word, Excel, anything) the
// engineer keeps beside the evidence, one store per project.
//
// The user's folder tree IS a real directory tree under <project>/files/:
// folders are directories, files keep their names, and every operation is a
// plain filesystem operation. That is what makes "open with the default
// app" honest — the backend runs on the same machine as the browser
// (loopback-only), so opening hands the OS a real path.
//
// Paths in the API are forward-slash relative paths inside the store
// ('' = the root); every one is resolved through resolveWithin so nothing
// escapes the project.

import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveWithin } from '../lib/http.js';
import { uniqueName } from '../lib/names.js';
import { treeOrder } from '../lib/tree.js';

// Windows-invalid filename characters (also covers the path separators).
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/g;

function cleanName(raw) {
  const name = String(raw ?? '').replace(INVALID_NAME, '').trim();
  if (!name || name === '.' || name === '..') throw httpError(400, `invalid name: ${raw}`);
  return name;
}

class FilesService {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, 'files');
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  #resolve(relPath) {
    return resolveWithin(this.root, relPath, `invalid file path: ${relPath}`);
  }

  async #statOrNull(absolute) {
    try {
      return await stat(absolute);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  // The whole tree, folders first, name-sorted — the sidebar renders this
  // directly. `path` is the store-relative forward-slash path.
  async tree() {
    const walk = async (dir, rel) => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nodes = await Promise.all(entries.map(async (entry) => {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return {
            type: 'folder',
            name: entry.name,
            path: relPath,
            children: await walk(path.join(dir, entry.name), relPath),
          };
        }
        const info = await stat(path.join(dir, entry.name));
        return {
          type: 'file',
          name: entry.name,
          path: relPath,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }));
      return nodes.sort(treeOrder);
    };
    return walk(this.root, '');
  }

  // Store uploaded files into `dirPath` ('' = root). Same-name uploads are
  // unique-ified (name-2.pdf), never overwritten.
  async upload(dirPath, files) {
    const dir = this.#resolve(dirPath);
    if (!(await this.#statOrNull(dir))?.isDirectory()) {
      throw httpError(404, `no such folder: ${dirPath || '/'}`);
    }
    const added = [];
    const existing = new Set(await readdir(dir));
    for (const file of files) {
      const name = cleanName(file.originalname);
      const extension = path.extname(name);
      const base = name.slice(0, name.length - extension.length);
      const unique = uniqueName(base, (candidate) => existing.has(`${candidate}${extension}`));
      const finalName = `${unique}${extension}`;
      await writeFile(path.join(dir, finalName), file.buffer);
      existing.add(finalName);
      added.push(dirPath ? `${dirPath}/${finalName}` : finalName);
    }
    return { added };
  }

  async createFolder(dirPath, name) {
    const parent = this.#resolve(dirPath);
    const folder = path.join(parent, cleanName(name));
    this.#resolve(path.relative(this.root, folder));
    if (await this.#statOrNull(folder)) throw httpError(409, `already exists: ${name}`);
    await mkdir(folder, { recursive: false });
  }

  async renameEntry(relPath, nextName) {
    const from = this.#resolve(relPath);
    if (from === this.root) throw httpError(400, 'cannot rename the root');
    if (!(await this.#statOrNull(from))) throw httpError(404, `no such entry: ${relPath}`);
    const to = path.join(path.dirname(from), cleanName(nextName));
    if (to === from) return;
    if (await this.#statOrNull(to)) throw httpError(409, `already exists: ${nextName}`);
    await rename(from, to);
  }

  // Move a file or folder into another folder ('' = root).
  async moveEntry(relPath, toDir) {
    const from = this.#resolve(relPath);
    if (from === this.root) throw httpError(400, 'cannot move the root');
    if (!(await this.#statOrNull(from))) throw httpError(404, `no such entry: ${relPath}`);
    const target = this.#resolve(toDir);
    if (!(await this.#statOrNull(target))?.isDirectory()) {
      throw httpError(404, `no such folder: ${toDir || '/'}`);
    }
    // A folder cannot move into itself or a descendant.
    if (target === from || target.startsWith(from + path.sep)) {
      throw httpError(400, 'cannot move a folder into itself');
    }
    const to = path.join(target, path.basename(from));
    if (to === from) return;
    if (await this.#statOrNull(to)) {
      throw httpError(409, `already exists there: ${path.basename(from)}`);
    }
    await rename(from, to);
  }

  async removeEntry(relPath) {
    const absolute = this.#resolve(relPath);
    if (absolute === this.root) throw httpError(400, 'cannot delete the root');
    if (!(await this.#statOrNull(absolute))) throw httpError(404, `no such entry: ${relPath}`);
    await rm(absolute, { recursive: true, force: true });
  }

  // Hand the file to the OS default app. Loopback deployment makes this the
  // user's own machine; the path is store-confined by #resolve.
  async open(relPath) {
    const absolute = this.#resolve(relPath);
    const info = await this.#statOrNull(absolute);
    if (!info?.isFile()) throw httpError(404, `no such file: ${relPath}`);
    if (process.platform === 'win32') {
      // `start` resolves file associations; the empty "" is the window title
      // slot, so paths with spaces survive.
      spawn('cmd', ['/c', 'start', '', absolute], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [absolute], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  }
}

export { FilesService };
