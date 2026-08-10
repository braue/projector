// RTAC export service — one instance per purview project, owning the
// lifecycle every sidebar entry moves through:
//
//   available --double-click--> exporting --> ready --click--> tree/preview
//                                   \--> error (kept, shown, retryable)
//
// The AcRTAC database list is machine-global (services/rtacCatalog.js, one
// shared instance); what is PER PROJECT is which of those RTAC projects the
// user exported into it. Exports land under <project>/rtac/<name>/ as the
// folder-of-XML format cli.exportxml produces. An export already on disk is
// 'ready' at startup, so restarts don't force a re-download. Parsed models
// are cached per name and invalidated by a fresh export.
//
// On top of browsing, an analysis feature works across the cached models:
// aggregate (a list of setting names pivoted across objects). Compare rides
// the standard comparable() adapter.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveChild } from '../lib/http.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { moduleBaseName } from '../lib/parsers/rtac/project.js';
import { foldTree } from '../lib/tree.js';

const EXPORTABLE = /\.xml$/i;

class RtacService {
  constructor({ catalog, dataDir }) {
    this.catalog = catalog;
    this.exportsDir = dataDir;
    // name -> { status: 'exporting'|'ready'|'error', error? } — only names
    // this project has touched; everything else in the catalog is 'available'.
    this.state = new Map();
    // name -> { model, byFile: Map<file, item>, hashes: Map<file, sha1> }
    this.parseCache = new Map();
  }

  // Local state only — the (possibly slow) database list is the catalog's
  // concern, so opening a project never blocks on the database.
  async init() {
    await mkdir(this.exportsDir, { recursive: true });

    // Anything already exported in a previous run is immediately browsable —
    // even if the database turns out to be unreachable.
    const onDisk = await readdir(this.exportsDir, { withFileTypes: true });
    for (const entry of onDisk) {
      if (entry.isDirectory()) this.state.set(entry.name, { status: 'ready' });
    }
  }

  // Only what this project holds (or is fetching right now) — the sidebar
  // list. The full catalog lives behind available(), for the database
  // browser.
  list() {
    return {
      projects: [...this.state.entries()]
        .map(([name, state]) => ({ name, ...state }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // The machine-global AcRTAC catalog, flagged with what is already in this
  // project — the database-browser modal's list.
  available() {
    return {
      projects: this.catalog.names.map((name) => ({
        name,
        inProject: this.state.has(name),
      })),
      error: this.catalog.error ?? null,
    };
  }

  // Names come from the AcRTAC database, but they become a path segment here.
  #dir(name) {
    return resolveChild(this.exportsDir, name, `invalid project name: ${name}`);
  }

  #known(name) {
    const state = this.state.get(name);
    if (state) return state;
    if (this.catalog.names.includes(name)) return { status: 'available' };
    throw httpError(404, `unknown RTAC project: ${name}`);
  }

  // Kick off (or restart, after an error / for a refresh) an export into
  // this project. Returns the new state immediately; completion is observed
  // by polling list().
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
        await this.catalog.client.exportXml({ name, directory });
        this.state.set(name, { status: 'ready' });
      } catch (err) {
        this.state.set(name, { status: 'error', error: err?.message ?? String(err) });
      }
    })();

    return this.state.get(name);
  }

  // An exported folder uploaded straight from disk — the no-database path.
  // Files arrive with folder-relative paths as their names
  // ("Export1/SEL_RTAC/Devices.xml"); the top segment names the export and
  // the .xml files land under it, replacing any previous export of the same
  // name. Multiple top-level folders in one upload become multiple exports.
  async uploadFolder(files) {
    const groups = new Map();
    for (const file of files) {
      const segments = String(file.path)
        .split(/[\\/]/)
        .filter((segment) => segment && segment !== '.' && segment !== '..');
      if (segments.length < 2 || !EXPORTABLE.test(segments[segments.length - 1])) continue;
      const [name, ...rest] = segments;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ rest, buffer: file.buffer });
    }
    if (!groups.size) {
      throw httpError(400, 'no .xml files found — upload the exported RTAC project folder itself');
    }

    const added = [];
    for (const [name, entries] of groups) {
      const dir = this.#dir(name);
      await rm(dir, { recursive: true, force: true });
      for (const entry of entries) {
        const target = path.join(dir, ...entry.rest);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.buffer);
      }
      this.state.set(name, { status: 'ready' });
      this.parseCache.delete(name);
      added.push({ name, files: entries.length });
    }
    return { added };
  }

  // Take an export out of this project (the database copy, if any, is
  // untouched — it can be downloaded again).
  async remove(name) {
    if (!this.state.has(name)) {
      throw httpError(404, `not in this project: ${name}`);
    }
    await rm(this.#dir(name), { recursive: true, force: true });
    this.state.delete(name);
    this.parseCache.delete(name);
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
      throw httpError(409, `RTAC project ${name} is not exported into this purview project yet`);
    }

    // The cache holds the in-flight promise, not the settled result, so two
    // concurrent readers of an uncached project (canvas graph racing an
    // Inspect fetch) share one parse instead of each walking every XML file.
    if (!this.parseCache.has(name)) {
      const pending = this.#parse(name);
      this.parseCache.set(name, pending);
      pending.catch(() => this.parseCache.delete(name));
    }
    return this.parseCache.get(name);
  }

  async #parse(name) {
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
        // The export vanished from disk (deleted by hand): it is no longer
        // in this project — download or upload it again.
        this.state.delete(name);
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
    return { model, byFile: new Map(model.items.map((item) => [item.file, item])), hashes };
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
    const nodes = model.items.map((item) => RtacService.#itemNode(item));

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

export { RtacService };
