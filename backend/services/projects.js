// Project service — owns the lifecycle every sidebar entry moves through:
//
//   available --double-click--> exporting --> ready --click--> tree/preview
//                                   \--> error (kept, shown, retryable)
//
// Exports land under DATA_DIR/exports/<project>/ as the folder-of-XML format
// cli.exportxml produces. A project already on disk is 'ready' at startup, so
// restarts don't force a re-download. Parsed models are cached per project and
// invalidated by a fresh export.
//
// On top of browsing, two analysis features work across the cached models:
// compare (two projects, file statuses + per-item structured diff) and
// aggregate (one project, a list of setting names pivoted across objects).

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveChild } from '../lib/http.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { moduleBaseName } from '../lib/parsers/rtac/project.js';
import { foldTree } from '../lib/tree.js';

const EXPORTABLE = /\.xml$/i;

class ProjectService {
  constructor({ client, dataDir }) {
    this.client = client;
    this.exportsDir = path.join(dataDir, 'exports');
    // name -> { status: 'available'|'exporting'|'ready'|'error', error? }
    this.state = new Map();
    // name -> { model, byFile: Map<file, item>, hashes: Map<file, sha1> }
    this.parseCache = new Map();
    this.names = [];
    // Last listprojects failure, or null; served beside the list.
    this.listError = null;
  }

  // Local state only — the (possibly slow) database list is refreshed
  // separately so startup never blocks on the database.
  async init() {
    await mkdir(this.exportsDir, { recursive: true });

    // Anything already exported in a previous run is immediately browsable —
    // even if the database turns out to be unreachable.
    const onDisk = await readdir(this.exportsDir, { withFileTypes: true });
    for (const entry of onDisk) {
      if (entry.isDirectory()) this.state.set(entry.name, { status: 'ready' });
    }
    this.names = [...this.state.keys()];
  }

  // (Re-)query the database's project list. Never throws: a failure lands in
  // `listError`, which the API returns beside the (possibly disk-only) list,
  // and the UI offers a retry that calls this again.
  async refreshList() {
    try {
      const projects = await this.client.listProjects();
      this.listError = null;

      const dbNames = projects.map((p) => p.name);
      for (const name of dbNames) {
        if (!this.state.has(name)) this.state.set(name, { status: 'available' });
      }
      // Database order first; exports on disk that the database no longer
      // lists stay visible after it (they are still browsable).
      const dbSet = new Set(dbNames);
      const extras = [...this.state.keys()].filter((name) => !dbSet.has(name));
      this.names = [...dbNames, ...extras];
    } catch (err) {
      this.listError = err?.message ?? String(err);
    }
    return this.listError;
  }

  list() {
    return {
      projects: this.names.map((name) => ({ name, ...this.state.get(name) })),
      error: this.listError ?? null,
    };
  }

  // Names come from the AcRTAC database, but they become a path segment here.
  #dir(name) {
    return resolveChild(this.exportsDir, name, `invalid project name: ${name}`);
  }

  #known(name) {
    const state = this.state.get(name);
    if (!state) throw httpError(404, `unknown project: ${name}`);
    return state;
  }

  // Kick off (or restart, after an error / for a refresh) an export. Returns
  // the new state immediately; completion is observed by polling list().
  startExport(name) {
    const state = this.#known(name);
    if (state.status === 'exporting') return state;

    const directory = this.#dir(name);
    this.state.set(name, { status: 'exporting' });
    this.parseCache.delete(name);

    // Fire-and-forget on purpose: the request returns 202 and the sidebar
    // spinner polls. Failures land in state as 'error' rather than throwing.
    (async () => {
      try {
        await rm(directory, { recursive: true, force: true });
        await this.client.exportXml({ name, directory });
        this.state.set(name, { status: 'ready' });
      } catch (err) {
        this.state.set(name, { status: 'error', error: err?.message ?? String(err) });
      }
    })();

    return this.state.get(name);
  }

  // Parse the exported folder into { model, byFile, hashes } (cached until the
  // next export). Reads every .xml under the export root, keyed by
  // forward-slash relative path — the identity the parser, the diff, and the
  // UI all share. The hash is of the raw bytes: it decides edited/unchanged in
  // a compare, so it must see changes the parser doesn't model (e.g. CFC
  // blobs).
  async #parsed(name) {
    const state = this.#known(name);
    if (state.status !== 'ready') {
      throw httpError(409, `project ${name} is not exported yet`);
    }

    const cached = this.parseCache.get(name);
    if (cached) return cached;

    const root = this.#dir(name);
    const files = [];
    const walk = async (dir, rel) => {
      const entries = await readdir(dir, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
        else if (EXPORTABLE.test(entry.name)) {
          const xml = await readFile(path.join(dir, entry.name), 'utf8');
          files.push({ file: relPath, xml });
        }
      }));
    };
    try {
      await walk(root, '');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // The export vanished from disk (deleted by hand). Drop back to
        // 'available' so the sidebar greys it out for a fresh download.
        this.state.set(name, { status: 'available' });
        throw httpError(409, `the export of ${name} is missing on disk — download it again`);
      }
      throw err;
    }

    // Reads run concurrently, so impose a stable order before parsing.
    files.sort((a, b) => a.file.localeCompare(b.file));
    const hashes = new Map(
      files.map(({ file, xml }) => [file, createHash('sha1').update(xml).digest('hex')]),
    );

    const model = parseRtacProject(files);
    const parsed = { model, byFile: new Map(model.items.map((item) => [item.file, item])), hashes };
    this.parseCache.set(name, parsed);
    return parsed;
  }

  // Public read of the parsed project model — the comm extractors consume it.
  async model(name) {
    return (await this.#parsed(name)).model;
  }

  // --- tree ------------------------------------------------------------------

  // A light tree node for one item; the heavy body stays behind item().
  static #itemNode(item, extra = {}) {
    return {
      type: 'item',
      name: item.name ?? moduleBaseName(item.file),
      path: item.file,
      kind: item.kind,
      kindLabel: item.kindLabel,
      category: item.category,
      protocol: item.protocol ?? null,
      connectionType: item.connectionType ?? null,
      pointCount: item.pointCount,
      ...extra,
    };
  }

  // The full export as a nested tree — folders, programs, connections, all of
  // it.
  async tree(name) {
    const model = await this.model(name);
    const nodes = model.items.map((item) => ProjectService.#itemNode(item));

    return {
      name: model.name ?? name,
      schema: model.schema,
      deviceLabel: model.deviceMOT ? `SEL-${model.deviceMOT}` : null,
      summary: model.summary,
      errors: model.errors,
      tree: foldTree(nodes, model.errors),
    };
  }

  // Full parsed body of one export file, for the preview pane.
  async item(name, file) {
    const item = (await this.#parsed(name)).byFile.get(file);
    if (!item) throw httpError(404, `no such item in ${name}: ${file}`);
    return item;
  }

  // --- compare ---------------------------------------------------------------

  // Compare adapter entries: one per export file, signature = raw content
  // hash so an edit the parser doesn't model (a CFC blob) still reads edited.
  async comparable(name) {
    const { model, hashes } = await this.#parsed(name);
    return {
      label: model.name ?? name,
      entries: model.items.map((item) => ({
        path: item.file,
        name: item.name ?? moduleBaseName(item.file),
        item,
        signature: hashes.get(item.file),
      })),
    };
  }

  // --- aggregate -------------------------------------------------------------

  // Pivot a list of setting names across a range of objects: for each object
  // in scope, the value of every setting whose name matches each term
  // (case-insensitive; exact name or substring). Only objects with at least
  // one match make a row — the table answers "what is X set to, everywhere".
  async aggregate(name, { terms = [], files = [] } = {}) {
    const model = await this.model(name);
    const wanted = terms.map((term) => String(term).trim()).filter(Boolean);
    if (!wanted.length) {
      throw httpError(400, 'at least one setting name is required');
    }
    const lowered = wanted.map((term) => term.toLowerCase());

    const scope = files.length ? new Set(files) : null;
    const rows = [];

    for (const item of model.items) {
      if (scope && !scope.has(item.file)) continue;

      const entries = Object.entries(item.settings).map(
        ([key, value]) => [key.toLowerCase(), key, value],
      );
      const values = {};
      let matched = false;
      for (const [index, term] of wanted.entries()) {
        const lower = lowered[index];
        const matches = entries
          .filter(([keyLower]) => keyLower.includes(lower))
          .map(([, key, value]) => ({ name: key, value }));
        if (matches.length) matched = true;
        values[term] = matches;
      }

      if (matched) {
        rows.push({
          file: item.file,
          name: item.name ?? item.file,
          kindLabel: item.kindLabel,
          category: item.category,
          protocol: item.protocol ?? null,
          values,
        });
      }
    }

    return { terms: wanted, scoped: Boolean(scope), rows };
  }
}

export { ProjectService };
