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

import { compareHashes, diffItems, STATUS } from '../lib/compare.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';

const EXPORTABLE = /\.xml$/i;

class ProjectService {
  constructor({ client, dataDir }) {
    this.client = client;
    this.exportsDir = path.join(dataDir, 'exports');
    // name -> { status: 'available'|'exporting'|'ready'|'error', error? }
    this.state = new Map();
    // name -> { model, hashes: Map<file, sha1> }
    this.parseCache = new Map();
    this.names = [];
    // Last listprojects failure, or null; served beside the list.
    this.listError = null;
  }

  async init() {
    await mkdir(this.exportsDir, { recursive: true });

    // Anything already exported in a previous run is immediately browsable —
    // even if the database turns out to be unreachable below.
    const onDisk = await readdir(this.exportsDir, { withFileTypes: true });
    for (const entry of onDisk) {
      if (entry.isDirectory()) this.state.set(entry.name, { status: 'ready' });
    }
    this.names = [...this.state.keys()];

    await this.refreshList();
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
      const extras = [...this.state.keys()].filter((name) => !dbNames.includes(name));
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

  #dir(name) {
    // Names come from the AcRTAC database, but they become a path segment
    // here — refuse anything that would escape the exports directory.
    const dir = path.resolve(this.exportsDir, name);
    if (path.dirname(dir) !== path.resolve(this.exportsDir)) {
      throw Object.assign(new Error(`invalid project name: ${name}`), { status: 400 });
    }
    return dir;
  }

  #known(name) {
    const state = this.state.get(name);
    if (!state) throw Object.assign(new Error(`unknown project: ${name}`), { status: 404 });
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

  // Parse the exported folder into { model, hashes } (cached until the next
  // export). Reads every .xml under the export root, keyed by forward-slash
  // relative path — the identity the parser, the diff, and the UI all share.
  // The hash is of the raw bytes: it decides edited/unchanged in a compare,
  // so it must see changes the parser doesn't model (e.g. CFC blobs).
  async #parsed(name) {
    const state = this.#known(name);
    if (state.status !== 'ready') {
      throw Object.assign(new Error(`project ${name} is not exported yet`), { status: 409 });
    }

    const cached = this.parseCache.get(name);
    if (cached) return cached;

    const root = this.#dir(name);
    const files = [];
    const hashes = new Map();
    const walk = async (dir, rel) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
        else if (EXPORTABLE.test(entry.name)) {
          const xml = await readFile(path.join(dir, entry.name), 'utf8');
          files.push({ file: relPath, xml });
          hashes.set(relPath, createHash('sha1').update(xml).digest('hex'));
        }
      }
    };
    try {
      await walk(root, '');
    } catch (err) {
      if (err?.code === 'ENOENT') {
        // The export vanished from disk (deleted by hand). Drop back to
        // 'available' so the sidebar greys it out for a fresh download.
        this.state.set(name, { status: 'available' });
        throw Object.assign(
          new Error(`the export of ${name} is missing on disk — download it again`),
          { status: 409 },
        );
      }
      throw err;
    }

    const parsed = { model: parseRtacProject(files), hashes };
    this.parseCache.set(name, parsed);
    return parsed;
  }

  async #model(name) {
    return (await this.#parsed(name)).model;
  }

  // Public read of the parsed project model — the comm extractors consume it.
  async model(name) {
    return this.#model(name);
  }

  // --- tree ------------------------------------------------------------------

  // A light tree node for one item; the heavy body stays behind item().
  static #itemNode(item, extra = {}) {
    return {
      type: 'item',
      name: item.name ?? item.file.split('/').pop().replace(EXPORTABLE, ''),
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

  // Fold item nodes (plus parse errors) into a nested folder tree.
  static #foldTree(nodes, errors) {
    const root = { type: 'folder', name: '', path: '', children: [] };
    const folders = new Map([['', root]]);

    const folderFor = (dirPath) => {
      const existing = folders.get(dirPath);
      if (existing) return existing;
      const parent = folderFor(dirPath.split('/').slice(0, -1).join('/'));
      const folder = {
        type: 'folder',
        name: dirPath.split('/').pop(),
        path: dirPath,
        children: [],
      };
      parent.children.push(folder);
      folders.set(dirPath, folder);
      return folder;
    };

    const place = (node) => {
      const dir = node.path.split('/').slice(0, -1).join('/');
      folderFor(dir).children.push(node);
    };

    for (const node of nodes) place(node);

    // Files the parser rejected still appear — visibility beats silently
    // shrinking the tree.
    for (const { file, error } of errors) {
      place({
        type: 'item',
        name: file.split('/').pop(),
        path: file,
        kind: 'ParseError',
        kindLabel: 'Unparseable file',
        category: 'other',
        error,
      });
    }

    const sortTree = (node) => {
      node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      for (const child of node.children) if (child.type === 'folder') sortTree(child);
    };
    sortTree(root);
    return root.children;
  }

  // The full export as a nested tree — folders, programs, connections, all of
  // it.
  async tree(name) {
    const model = await this.#model(name);
    const nodes = model.items.map((item) => ProjectService.#itemNode(item));

    return {
      name: model.name ?? name,
      schema: model.schema,
      deviceMOT: model.deviceMOT,
      summary: model.summary,
      errors: model.errors,
      tree: ProjectService.#foldTree(nodes, model.errors),
    };
  }

  // Full parsed body of one export file, for the preview pane.
  async item(name, file) {
    const model = await this.#model(name);
    const item = model.items.find((candidate) => candidate.file === file);
    if (!item) {
      throw Object.assign(new Error(`no such item in ${name}: ${file}`), { status: 404 });
    }
    return item;
  }

  // --- compare ---------------------------------------------------------------

  // The union of both projects' trees, each item row carrying its status:
  // added / removed / edited / unchanged. Removed files render from the
  // original's item summary; everything else from the updated project's.
  async compare(originalName, updatedName) {
    const [original, updated] = await Promise.all([
      this.#parsed(originalName),
      this.#parsed(updatedName),
    ]);
    const status = compareHashes(original.hashes, updated.hashes);

    const originalByFile = new Map(original.model.items.map((item) => [item.file, item]));
    const nodes = [];
    for (const item of updated.model.items) {
      nodes.push(ProjectService.#itemNode(item, { status: status.get(item.file) }));
    }
    for (const item of original.model.items) {
      if (status.get(item.file) === STATUS.REMOVED) {
        nodes.push(ProjectService.#itemNode(item, { status: STATUS.REMOVED }));
      }
    }

    const count = (wanted) =>
      [...status.values()].filter((value) => value === wanted).length;

    // Parse errors from both sides; a file that fails on either side still
    // needs a row for its status to hang on.
    const errors = [...updated.model.errors];
    const seen = new Set(errors.map((e) => e.file));
    for (const error of original.model.errors) {
      if (!seen.has(error.file) && !originalByFile.has(error.file)) errors.push(error);
    }

    return {
      original: { name: original.model.name ?? originalName },
      updated: { name: updated.model.name ?? updatedName },
      summary: {
        added: count(STATUS.ADDED),
        removed: count(STATUS.REMOVED),
        edited: count(STATUS.EDITED),
        unchanged: count(STATUS.UNCHANGED),
      },
      tree: ProjectService.#foldTree(nodes, []),
    };
  }

  // Structured diff of one file across the two projects.
  async compareItem(originalName, updatedName, file) {
    const [original, updated] = await Promise.all([
      this.#parsed(originalName),
      this.#parsed(updatedName),
    ]);
    const originalItem = original.model.items.find((item) => item.file === file) ?? null;
    const updatedItem = updated.model.items.find((item) => item.file === file) ?? null;
    if (!originalItem && !updatedItem) {
      throw Object.assign(new Error(`no such item: ${file}`), { status: 404 });
    }

    const status = compareHashes(original.hashes, updated.hashes).get(file) ?? STATUS.UNCHANGED;

    return {
      file,
      status,
      original: originalItem,
      updated: updatedItem,
      diff: diffItems(originalItem, updatedItem),
    };
  }

  // --- aggregate -------------------------------------------------------------

  // Pivot a list of setting names across a range of objects: for each object
  // in scope, the value of every setting whose name matches each term
  // (case-insensitive; exact name or substring). Only objects with at least
  // one match make a row — the table answers "what is X set to, everywhere".
  async aggregate(name, { terms = [], files = [] } = {}) {
    const model = await this.#model(name);
    const wanted = terms.map((term) => String(term).trim()).filter(Boolean);
    if (!wanted.length) {
      throw Object.assign(new Error('at least one setting name is required'), { status: 400 });
    }

    const scope = files.length ? new Set(files) : null;
    const rows = [];

    for (const item of model.items) {
      if (scope && !scope.has(item.file)) continue;

      const values = {};
      let matched = false;
      for (const term of wanted) {
        const lower = term.toLowerCase();
        const matches = Object.entries(item.settings)
          .filter(([key]) => key.toLowerCase().includes(lower))
          .map(([key, value]) => ({ name: key, value }));
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
