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
// catalog and the job registry are machine-global, shared across bundles.
//
// A built bundle also WATCHES its files/ folder and publishes `tree` on the
// event hub when anything in it changes — an upload, a tool saving a result,
// Excel saving over a working copy — so the window's tree follows the disk
// without polling or every caller remembering to reload it.

import { watch } from 'node:fs';
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

// A burst of changes (an export placing hundreds of files) is one event.
const TREE_SETTLE_MS = 250;

class ProjectsService {
  constructor({ dataDir, catalog, jobs = null, events = null }) {
    this.root = path.join(dataDir, 'projects');
    this.catalog = catalog;
    this.jobs = jobs;
    this.events = events;
    // name -> Promise<bundle> — built once per project per process.
    this.bundles = new Map();
    // name -> fs.FSWatcher over that project's files/.
    this.watchers = new Map();
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
    this.events?.publish('projects', {});
    return { name: trimmed };
  }

  async remove(name) {
    // Unwatch first: on Windows a watched folder can't be deleted or moved.
    this.#unwatch(name);
    this.bundles.delete(name);
    await rm(this.dir(name), { recursive: true, force: true });
    this.events?.publish('projects', {});
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
    this.#unwatch(name);
    this.bundles.delete(name);
    await rename(this.dir(name), to);
    this.events?.publish('projects', {});
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
    artifacts = new ArtifactsService({
      files, catalog: this.catalog, projectDir, jobs: this.jobs, project: name,
    });
    artifacts.register('rdb', new RdbKind({ artifacts, projectDir, apiBase }));
    artifacts.register('scd', new ScdKind({ artifacts }));
    artifacts.register('sw', new SwKind({ artifacts }));

    // Compare and search consume the same loader: every parsed item of an
    // artifact, in the shared inspect shape.
    const load = (ref) => artifacts.comparable(ref);
    const compare = new CompareService({ load });
    const search = new SearchService({ load });

    await files.init();
    this.#watch(name, files.root);
    return { files, artifacts, compare, search };
  }

  #watch(name, dir) {
    if (!this.events || this.watchers.has(name)) return;
    let timer = null;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.events.publish('tree', { project: name }), TREE_SETTLE_MS);
    };
    try {
      const watcher = watch(dir, { recursive: true }, changed);
      // A watcher that dies (the folder vanished, the OS ran out of watches)
      // only costs live updates; the tree still reloads after in-app actions.
      watcher.on('error', () => this.#unwatch(name));
      this.watchers.set(name, watcher);
    } catch (err) {
      console.warn(`not watching ${name} for changes: ${err?.message ?? err}`);
    }
  }

  #unwatch(name) {
    this.watchers.get(name)?.close();
    this.watchers.delete(name);
  }

  /** Stop every watcher (server shutdown). */
  close() {
    for (const name of [...this.watchers.keys()]) this.#unwatch(name);
  }
}

export { ProjectsService };
