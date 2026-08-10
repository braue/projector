// Purview projects — the top-level container everything now lives in. A
// project is a folder under DATA_DIR/projects/<name>/ holding that project's
// own sources and canvas:
//
//   <name>/rtac/<rtacProject>/   RTAC exports the user pulled into this project
//   <name>/rdb/<uploadId>/       relay database uploads
//   <name>/scd/<uploadId>/       SCL/SCD uploads
//   <name>/sw/<uploadId>/        switch settings uploads
//   <name>/canvas.json           placements + manual links
//
// Each project gets its own service bundle (rtac, rdb, scd, sw, canvas,
// compare), built lazily on first touch and cached; the AcRTAC database
// catalog is the one machine-global piece, shared across bundles.

import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { attachmentWarning, augmentProfile, extractScdProfile } from '../lib/comm/extract/scd.js';
import { extractRdbProfile } from '../lib/comm/extract/rdb.js';
import { extractRtacProfile } from '../lib/comm/extract/rtac.js';
import { extractSwProfile } from '../lib/comm/extract/sw.js';
import { httpError, resolveChild } from '../lib/http.js';
import { replaceRefFile } from '../lib/refs.js';
import { CanvasService } from './canvas.js';
import { CompareService } from './compare.js';
import { FilesService } from './files.js';
import { NotesService } from './notes.js';
import { SearchService } from './search.js';
import { RdbService } from './rdb.js';
import { RtacService } from './rtac.js';
import { ScdService } from './scd.js';
import { SwService } from './sw.js';

class ProjectsService {
  constructor({ dataDir, catalog, selDevicesDir }) {
    this.root = path.join(dataDir, 'projects');
    this.catalog = catalog;
    this.selDevicesDir = selDevicesDir;
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

  async create(name) {
    const trimmed = name?.trim();
    if (!trimmed) throw httpError(400, 'project name required');
    const projectDir = this.dir(trimmed);
    if ((await this.list()).includes(trimmed)) {
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
    if (!(await this.list()).includes(name)) {
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

    const rtac = new RtacService({ catalog: this.catalog, dataDir: path.join(projectDir, 'rtac') });
    const rdb = new RdbService({ dataDir: projectDir, selDevicesDir: this.selDevicesDir, apiBase });
    const scd = new ScdService({ dataDir: projectDir });
    const sw = new SwService({ dataDir: projectDir });

    const canvas = new CanvasService({
      file: path.join(projectDir, 'canvas.json'),
      resolvers: {
        rtac: async (ref) => extractRtacProfile(await rtac.model(ref), ref),
        rdb: async (ref) => extractRdbProfile(rdb.profile(ref).profile, ref),
        scd: async (ref) => extractScdProfile(scd.profile(ref), ref),
        sw: async (ref) => extractSwProfile(sw.profile(ref), ref),
      },
      augment: async (baseProfile, ref) => {
        const scdProfile = extractScdProfile(scd.profile(ref), ref);
        return {
          profile: augmentProfile(baseProfile, scdProfile),
          warning: attachmentWarning(baseProfile, scdProfile),
        };
      },
    });

    // Compare and search consume the same per-type adapter: every parsed
    // item of a source, in the shared inspect shape.
    const adapters = {
      rtac: (ref) => rtac.comparable(ref),
      rdb: (ref) => rdb.comparable(ref),
      scd: (ref) => scd.comparable(ref),
      sw: (ref) => sw.comparable(ref),
    };
    const compare = new CompareService({ adapters });
    const search = new SearchService({
      adapters,
      // Everything searchable in the project right now: ready RTAC exports
      // and every profile of every upload.
      sources: async () => [
        ...rtac.list().projects
          .filter((entry) => entry.status === 'ready')
          .map((entry) => ({ type: 'rtac', ref: entry.name })),
        ...[['rdb', rdb], ['scd', scd], ['sw', sw]].flatMap(([type, service]) =>
          service.list().flatMap((file) =>
            file.profiles.map((profile) => ({ type, ref: profile.ref })))),
      ],
    });

    const notes = new NotesService({ file: path.join(projectDir, 'notes.json') });
    const files = new FilesService({ dataDir: projectDir });

    // A renamed source must drag its canvas refs along: the rename lives in
    // the service, the rewrite in the canvas, and this bundle is where the
    // two meet (the same pattern as `augment`).
    rtac.onRenamed = (from, to) =>
      canvas.renameRefs('rtac', (ref) => (ref === from ? to : ref));
    for (const [type, service] of Object.entries({ rdb, scd, sw })) {
      service.onRenamed = (fromId, toId) =>
        canvas.renameRefs(type, (ref) => replaceRefFile(ref, fromId, toId));
    }

    await Promise.all([rtac.init(), rdb.init(), scd.init(), sw.init(), canvas.init(), files.init()]);
    return { rtac, rdb, scd, sw, canvas, compare, search, notes, files };
  }
}

export { ProjectsService };
