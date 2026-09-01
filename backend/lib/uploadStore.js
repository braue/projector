// The storage lifecycle every upload-backed source shares (RDB, SCD): an
// upload lands under DATA_DIR/<subdir>/<id>/ as the original bytes plus
// parsed.json, restarts rehydrate from parsed.json, and the id is the
// sanitized upload name, unique-ified. Services own parsing and shaping —
// this store owns the disk.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveChild } from './http.js';
import { folderBirthTime } from './fsTime.js';
import { idBase, uniqueName } from './names.js';

class UploadStore {
  constructor({ dataDir, label, extension, originalName }) {
    this.root = path.join(dataDir, label);
    this.label = label;
    this.extension = extension;
    this.originalName = originalName;
    // fileId -> stored (the parsed.json contents; shape is the service's)
    this.files = new Map();
    // Ids evicted pending a background re-parse: not served, but still
    // reserved so a concurrent upload cannot claim the name.
    this.evicted = new Set();
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    const entries = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    await Promise.all(entries.map(async (entry) => {
      const dir = path.join(this.root, entry.name);
      try {
        const stored = JSON.parse(await readFile(path.join(dir, 'parsed.json'), 'utf8'));
        // Uploads that predate the timestamp fall back to when their folder
        // was created — the upload wrote it, and birthtime rides the inode,
        // so a later rename does not move it. Derived on every start rather
        // than written back: it is the same answer each time, and startup
        // has no business rewriting files it only meant to read.
        stored.uploadedAt ??= await folderBirthTime(dir);
        this.files.set(entry.name, stored);
      } catch (err) {
        console.warn(`skipping unreadable ${this.label} upload ${entry.name}: ${err?.message ?? err}`);
      }
    }));
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

  // A display name reduced to a directory-safe id base.
  #idBase(name) {
    return idBase(name.replace(this.extension, ''), 'upload');
  }

  // Store a new upload (original bytes + parsed.json); returns the new id.
  async add(fileName, buffer, stored) {
    const id = uniqueName(this.#idBase(fileName),
      (candidate) => this.files.has(candidate) || this.evicted.has(candidate));
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, this.originalName), buffer),
      writeFile(path.join(dir, 'parsed.json'), JSON.stringify(stored)),
    ]);
    this.files.set(id, stored);
    return id;
  }

  // Move an entry to an id derived from a new display name; returns the new
  // id (unchanged when the name already reduces to the current id).
  async rename(fileId, nextName) {
    const stored = this.files.get(fileId);
    if (!stored) throw httpError(404, `unknown ${this.label} file: ${fileId}`);
    const id = uniqueName(this.#idBase(nextName),
      (candidate) => candidate !== fileId && (this.files.has(candidate) || this.evicted.has(candidate)));
    if (id !== fileId) {
      await rename(this.dir(fileId), this.dir(id));
      this.files.set(id, stored);
      this.files.delete(fileId);
    }
    return id;
  }

  // Pull an entry from service (stale shape awaiting re-parse) without
  // touching disk; saveParsed brings it back.
  evict(fileId) {
    this.files.delete(fileId);
    this.evicted.add(fileId);
  }

  // Re-persist an entry the service enriched after add (e.g. drawings).
  async saveParsed(fileId, stored) {
    this.files.set(fileId, stored);
    this.evicted.delete(fileId);
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
