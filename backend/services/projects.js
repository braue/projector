// Projector projects — the top-level container everything lives in. A
// project is a folder under DATA_DIR/projects/<name>/ whose heart is ONE
// user-organized file tree:
//
//   <name>/files/         the folder tree — settings artifacts, documents,
//                         and .txt notes side by side, versioned in place
//   <name>/drawings/      generated RDB panel drawings, keyed by content hash
//
// Each project gets its own service bundle (files, artifacts, compare,
// search), built lazily on first touch and cached; the AcRTAC database
// catalog is the one machine-global piece, shared across bundles.

import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactsService } from '../lib/artifacts.js';
import { httpError, resolveChild } from '../lib/http.js';
import { CompareService } from './compare.js';
import { FilesService } from './files.js';
import { SearchService } from './search.js';
import { RdbKind } from './rdb.js';
import { ScdKind } from './scd.js';
import { SwKind } from './sw.js';

class ProjectsService {
  constructor({ dataDir, catalog }) {
    this.root = path.join(dataDir, 'projects');
    this.catalog = catalog;
    // name -> Promise<bundle> — built once per project per process.
    this.bundles = new Map();
  }

  // No default project: the UI makes the user name their first one before
  // any work starts.
  async init() {
    await mkdir(this.root, { recursive: true });
  }

  dir(name) {
    return resolveChild(this.root, name, `invalid project name: ${name}`);
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async #exists(name) {
    return (await this.list()).includes(name);
  }

  async create(name) {
    const trimmed = name?.trim();
    if (!trimmed) throw httpError(400, 'project name required');
    const projectDir = this.dir(trimmed);
    if (await this.#exists(trimmed)) {
      throw httpError(409, `project already exists: ${trimmed}`);
    }
    await mkdir(projectDir, { recursive: true });
    return { name: trimmed };
  }

  async remove(name) {
    await rm(this.dir(name), { recursive: true, force: true });
    this.bundles.delete(name);
  }

  // Rename = move the folder. The old bundle is dropped (its services point
  // at the old directory and its RDB drawing URLs bake in the old name); the
  // new one builds lazily on first touch.
  async rename(name, nextName) {
    const trimmed = nextName?.trim();
    if (!trimmed) throw httpError(400, 'project name required');
    const names = await this.list();
    if (!names.includes(name)) throw httpError(404, `unknown project: ${name}`);
    if (trimmed === name) return { name: trimmed };
    if (names.includes(trimmed)) throw httpError(409, `project already exists: ${trimmed}`);
    const to = this.dir(trimmed);
    this.bundles.delete(name);
    await rename(this.dir(name), to);
    return { name: trimmed };
  }

  // The project's service bundle, built on first touch. 404s for a project
  // folder that does not exist — refs must never mint directories.
  async bundle(name) {
    if (!(await this.#exists(name))) {
      throw httpError(404, `unknown project: ${name}`);
    }
    if (!this.bundles.has(name)) {
      const pending = this.#build(name);
      this.bundles.set(name, pending);
      pending.catch(() => this.bundles.delete(name));
    }
    return this.bundles.get(name);
  }

  async #build(name) {
    const projectDir = this.dir(name);
    const apiBase = `/api/projects/${encodeURIComponent(name)}`;

    // Files own the bytes; artifacts own the meaning. A changed entry must
    // drop its cached model, so the two point at each other — the box breaks
    // the construction cycle.
    let artifacts;
    const files = new FilesService({
      dataDir: projectDir,
      onChanged: (relPath) => artifacts?.invalidate(relPath),
    });
    artifacts = new ArtifactsService({ files, catalog: this.catalog, projectDir });
    artifacts.register('rdb', new RdbKind({ artifacts, projectDir, apiBase }));
    artifacts.register('scd', new ScdKind({ artifacts }));
    artifacts.register('sw', new SwKind({ artifacts }));

    // Compare and search consume the same loader: every parsed item of an
    // artifact, in the shared inspect shape.
    const load = (ref) => artifacts.comparable(ref);
    const compare = new CompareService({ load });
    const search = new SearchService({ load });

    await files.init();
    return { files, artifacts, compare, search };
  }
}

export { ProjectsService };
