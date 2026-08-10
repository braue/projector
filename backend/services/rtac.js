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
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { modelSignature } from '../lib/compare.js';
import { httpError, resolveChild } from '../lib/http.js';
import { itemSummary } from '../lib/inspect.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { moduleBaseName } from '../lib/parsers/rtac/project.js';
import { foldTree } from '../lib/tree.js';

const EXPORTABLE = /\.xml$/i;

// True when the parser captured no content-ful fields from an item — its
// canonical signature would be constant however the file changes. Items with
// kind-specific structure (EtherCAT nodes, navigator layout) may also match;
// the raw fallback only ADDS sensitivity on top of the modeled signature.
function modelBlind(item) {
  return !Object.keys(item.settings).length
    && !item.points.length
    && !item.pages.length
    && item.code == null
    && item.archivedContentHash == null;
}

class RtacService {
  constructor({ catalog, dataDir }) {
    this.catalog = catalog;
    this.exportsDir = dataDir;
    // name -> { status: 'exporting'|'ready'|'error', error? } — only names
    // this project has touched; everything else in the catalog is 'available'.
    this.state = new Map();
    // name -> { model, byFile: Map<file, item>, rawHashes: Map<file, sha1>,
    // signatures?: Map<file, sha1> — filled lazily by comparable() }
    this.parseCache = new Map();
  }

  // Local state only — the (possibly slow) database list is the catalog's
  // concern, so opening a project never blocks on the database.
  async init() {
    await mkdir(this.exportsDir, { recursive: true });

    // Anything already exported in a previous run is immediately browsable —
    // even if the database turns out to be unreachable. Parsing is LAZY: the
    // first read of an export pays the parse (promise-cached, so concurrent
    // readers share it) — no background pre-warm.
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

  // Rename an export within this project (folder move + caches). The caller
  // rewrites canvas refs — the ref IS the name. A renamed export keeps no tie
  // to its database identity: re-exporting from the database lands under the
  // original catalog name as a separate entry.
  async rename(name, nextName) {
    const trimmed = nextName?.trim();
    if (!trimmed) throw httpError(400, 'name required');
    const state = this.state.get(name);
    if (!state) throw httpError(404, `not in this project: ${name}`);
    if (state.status === 'exporting') {
      throw httpError(409, 'wait for the export to finish before renaming');
    }
    if (trimmed === name) return { name: trimmed };
    if (this.state.has(trimmed)) throw httpError(409, `already in this project: ${trimmed}`);
    const to = this.#dir(trimmed);
    try {
      await rename(this.#dir(name), to);
    } catch (err) {
      // EPERM/EBUSY (a read mid-walk, an AV scan): fail cleanly, and never
      // leak raw filesystem paths in the response.
      throw httpError(409, `could not rename ${name} — the export is busy, retry in a moment`);
    }
    this.state.delete(name);
    this.state.set(trimmed, state);
    // Never carry the cached parse across: it may be an IN-FLIGHT promise
    // that the folder move just doomed, and its eviction handler is keyed to
    // the old name. Re-parse under the new name on its next read.
    this.parseCache.delete(name);
    // The name is the canvas ref — the project bundle wires this hook to
    // rewrite placements. The rename is already committed above, so a failed
    // rewrite must not report failure; a canvas too broken to rewrite will
    // surface on its next read.
    try {
      await this.onRenamed?.(name, trimmed);
    } catch (err) {
      console.warn(`canvas refs not rewritten for rename ${name} -> ${trimmed}: ${err?.message ?? err}`);
    }
    return { name: trimmed };
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

  // Parse the exported folder into { model, byFile } (cached until the next
  // export). Reads every .xml under the export root, keyed by forward-slash
  // relative path — the identity the parser, the diff, and the UI all share.
  async #parsed(name) {
    const state = this.#known(name);
    if (state.status !== 'ready') {
      throw httpError(409, `RTAC project ${name} is not exported into this purview project yet`);
    }

    // A hand-deleted export must drop out of the project even when a parsed
    // model is cached, so an existence check per read is the only reliable
    // tell.
    // ONLY a missing folder means deleted: a transient EPERM/EBUSY (AV scan,
    // network share) must fail this one read, never remove the export.
    try {
      await access(this.#dir(name));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      this.state.delete(name);
      this.parseCache.delete(name);
      throw httpError(409, `the export of ${name} is missing on disk — download it again`);
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

    const model = parseRtacProject(files);
    // Raw-byte hashes for MODEL-BLIND items only: a file the parser models
    // nothing content-ful from (Main Controller task config, a future object
    // type) would otherwise carry a constant signature and its real edits
    // could never read as edited. Folding the raw bytes in exactly there
    // keeps noise-immunity everywhere the model can see, and the old
    // raw-hash guarantee where it is blind. (ExportSource carries only
    // Schema/DeviceMOT — no volatile metadata to churn on.)
    const rawHashes = new Map();
    const xmlByFile = new Map(files.map((f) => [f.file, f.xml]));
    const byFile = new Map();
    for (const item of model.items) {
      byFile.set(item.file, item);
      if (modelBlind(item)) {
        const xml = xmlByFile.get(item.file) ?? '';
        rawHashes.set(item.file, createHash('sha1').update(xml).digest('hex'));
      }
    }
    return { model, byFile, rawHashes };
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
      ...itemSummary(item),
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

  // Compare adapter entries: one per export file, signature = digest of the
  // canonical parsed item (plus the raw hash for model-blind files — see
  // #parse). Signatures are expensive (canonical JSON + sha1 over full point
  // maps), so each is computed on first READ and memoized on the parse-cache
  // entry — search shares these entries but never touches signatures, and
  // pre-warms never pay for a compare nobody opens.
  async comparable(name) {
    const parsed = await this.#parsed(name);
    parsed.signatures ??= new Map();
    const signatureOf = (item) => {
      let signature = parsed.signatures.get(item.file);
      if (!signature) {
        const hash = createHash('sha1').update(modelSignature(item));
        const raw = parsed.rawHashes.get(item.file);
        if (raw) hash.update(raw);
        signature = hash.digest('hex');
        parsed.signatures.set(item.file, signature);
      }
      return signature;
    };
    return {
      label: parsed.model.name ?? name,
      entries: parsed.model.items.map((item) => ({
        path: item.file,
        name: item.name ?? moduleBaseName(item.file),
        item,
        get signature() {
          return signatureOf(item);
        },
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
          ...itemSummary(item),
          values,
        });
      }
    }

    return { terms: wanted, scoped: Boolean(scope), rows };
  }
}

export { RtacService };
