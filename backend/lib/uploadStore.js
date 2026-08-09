// The storage lifecycle every upload-backed source shares (RDB, SCD): an
// upload lands under DATA_DIR/<subdir>/<id>/ as the original bytes plus
// parsed.json, restarts rehydrate from parsed.json, and the id is the
// sanitized upload name, unique-ified. Services own parsing and shaping —
// this store owns the disk.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveChild } from './http.js';
import { uniqueName } from './names.js';

class UploadStore {
  constructor({ dataDir, label, extension, originalName }) {
    this.root = path.join(dataDir, label);
    this.label = label;
    this.extension = extension;
    this.originalName = originalName;
    // fileId -> stored (the parsed.json contents; shape is the service's)
    this.files = new Map();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        this.files.set(entry.name, JSON.parse(
          await readFile(path.join(this.root, entry.name, 'parsed.json'), 'utf8'),
        ));
      } catch (err) {
        console.warn(`skipping unreadable ${this.label} upload ${entry.name}: ${err?.message ?? err}`);
      }
    }
  }

  dir(fileId) {
    return resolveChild(this.root, fileId, `invalid ${this.label} id: ${fileId}`);
  }

  get(fileId) {
    return this.files.get(fileId);
  }

  entries() {
    return this.files.entries();
  }

  // Store a new upload (original bytes + parsed.json); returns the new id.
  async add(fileName, buffer, stored) {
    const base = fileName.replace(this.extension, '').replace(/[^\w.-]+/g, '_') || 'upload';
    const id = uniqueName(base, (candidate) => this.files.has(candidate));
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, this.originalName), buffer),
      writeFile(path.join(dir, 'parsed.json'), JSON.stringify(stored)),
    ]);
    this.files.set(id, stored);
    return id;
  }

  // Re-persist an entry the service enriched after add (e.g. drawings).
  async saveParsed(fileId, stored) {
    this.files.set(fileId, stored);
    await writeFile(path.join(this.dir(fileId), 'parsed.json'), JSON.stringify(stored));
  }

  async remove(fileId) {
    if (!this.files.has(fileId)) {
      throw httpError(404, `unknown ${this.label} file: ${fileId}`);
    }
    await rm(this.dir(fileId), { recursive: true, force: true });
    this.files.delete(fileId);
  }
}

export { UploadStore };
