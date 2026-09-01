// RTAC export service — one instance per projector project, owning the
// lifecycle every sidebar entry moves through:
//
//   available --double-click--> exporting --> ready --click--> tree/preview
//                                   \--> error (kept, shown, retryable)
//
// The AcRTAC database list is machine-global (services/rtacCatalog.js, one
// shared instance); what is PER PROJECT is which of those RTAC projects the
// user exported into it. Exports land under <project>/rtac/<id>/ as the
// folder-of-XML format cli.exportxml produces. An export already on disk is
// 'ready' at startup, so restarts don't force a re-download. Parsed models
// are cached per id and invalidated by a fresh export.
//
// IDENTITY vs DISPLAY NAME. The same database project is downloaded again
// whenever its settings change, and both copies are kept — comparing a
// project against its earlier self is the point of having them. So the two
// jobs the name used to do are split:
//
//   id           the folder on disk AND the canvas ref. Unique, minted from
//                the display name (SUB_1, then SUB_1-2). Never changes, so
//                placements and comparisons survive anything the user does.
//   displayName  what the sidebar shows. Two copies of one project share it;
//                the hover date tells them apart, and a rename moves only
//                this — no folder move, no refs to rewrite.
//
// The pairing lives in <project>/rtac/.exports.json, reconciled against the
// folders on disk at startup: a folder with no entry falls back to its own
// name and time, an entry with no folder is forgotten.
//
// Beside the folders rather than inside them — which is where the upload
// family keeps the same metadata (lib/uploadStore.js). Two reasons it differs
// here: an export folder is cleared with rm -rf before the bridge rewrites
// it, so anything inside would have to be re-created on every download and
// would be lost by a download that failed; and the folder is foreign data the
// user may zip up and hand to a colleague, which our bookkeeping has no
// business riding along in.
//
// On top of browsing, an analysis feature works across the cached models:
// aggregate (a list of setting names pivoted across objects). Compare rides
// the standard comparable() adapter.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { modelSignature } from '../lib/compare.js';
import { folderBirthTime } from '../lib/fsTime.js';
import { httpError, resolveChild } from '../lib/http.js';
import { idBase, uniqueName } from '../lib/names.js';
import { itemSummary } from '../lib/inspect.js';
import { parseRtacProject } from '../lib/parsers/rtac/index.js';
import { moduleBaseName } from '../lib/parsers/rtac/project.js';
import { foldTree } from '../lib/tree.js';

const EXPORTABLE = /\.xml$/i;

// The id -> { name, at } pairing, beside the export folders. Dot-prefixed so
// it reads as bookkeeping, and skipped by the isDirectory() scan either way.
const INDEX_FILE = '.exports.json';

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
    // id -> { status: 'exporting'|'ready'|'error', displayName, at?, error? }.
    // Only exports this project holds; the rest of the catalog is not here.
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
    const [index, onDisk] = await Promise.all([
      this.#loadIndex(),
      readdir(this.exportsDir, { withFileTypes: true }),
    ]);
    await Promise.all(onDisk.map(async (entry) => {
      if (!entry.isDirectory()) return;
      // The folders on disk are the truth; the index only supplies the
      // display name and the download time. An export written by a build
      // that predates the index (or restored by hand) falls back to its own
      // folder name and time — exactly what it used to show. This is the ONE
      // place the fallback belongs: past here, every entry has a name.
      const stored = index[entry.name];
      this.state.set(entry.name, {
        status: 'ready',
        displayName: stored?.name ?? entry.name,
        at: stored?.at ?? await folderBirthTime(path.join(this.exportsDir, entry.name)),
      });
    }));
  }

  // Only what this project holds (or is fetching right now) — the sidebar
  // list. The full catalog lives behind available(), for the database
  // browser.
  /** The wire shape of one export. `name` is the id — the folder on disk and
   *  the canvas ref; `displayName` is what the sidebar reads. */
  #entry(id) {
    return { ...this.state.get(id), name: id };
  }

  // Sorted by display name, so the list still reads alphabetically — then
  // newest first WITHIN a name, because copies of one project share a name
  // and only their date sets them apart.
  list() {
    return {
      projects: [...this.state.keys()]
        .map((id) => this.#entry(id))
        .sort((a, b) =>
          a.displayName.localeCompare(b.displayName)
          || (b.at ?? 0) - (a.at ?? 0)
          || a.name.localeCompare(b.name)),
    };
  }

  // The machine-global AcRTAC catalog, flagged with what is already in this
  // project — the database-browser modal's list.
  available() {
    // How many copies of each database project this projector project already
    // holds. Purely informational now — downloading again adds another copy
    // rather than replacing one, so nothing here blocks a download.
    const copies = new Map();
    for (const { displayName } of this.state.values()) {
      copies.set(displayName, (copies.get(displayName) ?? 0) + 1);
    }
    return {
      projects: this.catalog.names.map((name) => ({
        name,
        copies: copies.get(name) ?? 0,
      })),
      error: this.catalog.error ?? null,
    };
  }

  #indexPath() {
    return path.join(this.exportsDir, INDEX_FILE);
  }

  /** id -> { name, at }. A missing or unreadable index is simply no pairing:
   *  every export still lists, under its own folder name. */
  async #loadIndex() {
    try {
      const parsed = JSON.parse(await readFile(this.#indexPath(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Rewrite the index from live state. Called after anything that adds,
   *  renames, or removes an export; a failure is logged, never thrown — it
   *  costs a display name, not an export. Written via a temp file and renamed
   *  the way canvas.js saves, so a crash mid-write cannot leave a truncated
   *  index that loses every display name at once. */
  async #saveIndex() {
    const index = {};
    for (const [id, state] of this.state) {
      // 'exporting' is transient — a folder only earns an entry once it has
      // something in it.
      if (state.status !== 'exporting') index[id] = { name: state.displayName, at: state.at ?? null };
    }
    const file = this.#indexPath();
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(index, null, 2));
      await rename(`${file}.tmp`, file);
    } catch (err) {
      console.warn(`could not write the RTAC export index: ${err?.message ?? err}`);
    }
  }

  /** A free folder name for a new copy: SUB_1, then SUB_1-2, SUB_1-3.
   *
   *  Checked against the folders on disk as well as against state: state is
   *  reconciled with disk only at init(), so an export dropped into the
   *  folder while the app runs is invisible to it — and #run() clears the
   *  directory it picks. Nothing may ever be replaced, so the check has to
   *  hold continuously, not just at startup. */
  #freeId(displayName) {
    return uniqueName(idBase(displayName, 'export'), (candidate) =>
      this.state.has(candidate) || existsSync(path.join(this.exportsDir, candidate)));
  }

  // #freeId already sanitizes, but ids also arrive from the URL — so every
  // one of them is confined to the exports folder before it touches disk.
  #dir(name) {
    return resolveChild(this.exportsDir, name, `invalid project name: ${name}`);
  }

  // Resolves an EXPORT id — reads address a copy in this project, never a
  // database name (which no longer identifies anything on its own).
  #known(id) {
    const state = this.state.get(id);
    if (state) return state;
    throw httpError(404, `not in this project: ${id}`);
  }

  // Download a database project into this project, ALWAYS as a new copy.
  // Downloading one that is already here is how a newer revision arrives, and
  // the copy already on disk is what it gets compared against — so nothing is
  // replaced and nothing is prompted for. Returns the new entry immediately;
  // completion is observed by polling list().
  startExport(displayName) {
    if (!this.catalog.names.includes(displayName)) {
      throw httpError(404, `unknown RTAC project: ${displayName}`);
    }
    return this.#run(this.#freeId(displayName), displayName);
  }

  // Re-run an export that failed, in place. The id is kept, so a placement
  // already pointing at it survives — this is the same copy trying again,
  // not a new one.
  retryExport(id) {
    const state = this.#known(id);
    if (state.status === 'exporting') return this.#entry(id);
    return this.#run(id, state.displayName);
  }

  /** The export itself, for a known id and database name. */
  #run(id, displayName) {
    const directory = this.#dir(id);
    // Stamped now, not on completion: the row the user just created has to
    // sort as the newest copy of its name while the spinner runs, or it
    // appears below the copy it supersedes and jumps when it finishes.
    this.state.set(id, { status: 'exporting', displayName, at: Date.now() });
    this.parseCache.delete(id);

    // Fire-and-forget on purpose: the request returns 202 and the sidebar
    // spinner polls. Failures land in state as 'error' rather than throwing.
    (async () => {
      try {
        await rm(directory, { recursive: true, force: true });
        await this.catalog.client.exportXml({ name: displayName, directory });
        this.state.set(id, { status: 'ready', displayName, at: Date.now() });
        await this.#saveIndex();
      } catch (err) {
        this.state.set(id, {
          status: 'error',
          displayName,
          error: err?.message ?? String(err),
        });
      }
    })();

    return this.#entry(id);
  }

  // An exported folder uploaded straight from disk — the no-database path.
  // Files arrive with folder-relative paths as their names
  // ("Export1/SEL_RTAC/Devices.xml"); the top segment names the export and
  // the .xml files land under it. Like a database download, a folder whose
  // name is already here lands as ANOTHER copy rather than replacing one.
  // Multiple top-level folders in one upload become multiple exports.
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
      const id = this.#freeId(name);
      const dir = this.#dir(id);
      await rm(dir, { recursive: true, force: true });
      for (const entry of entries) {
        const target = path.join(dir, ...entry.rest);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.buffer);
      }
      this.state.set(id, { status: 'ready', displayName: name, at: Date.now() });
      this.parseCache.delete(id);
      added.push({ name, id, files: entries.length });
    }
    await this.#saveIndex();
    return { added };
  }

  // Rename an export within this project. Only the DISPLAY name moves: the
  // folder and the canvas ref are the id, which never changes. That makes a
  // rename pure bookkeeping — no folder move to fail on a locked file, no
  // placements to rewrite, and no reason to reject a name another copy is
  // already using (two copies of one project are meant to share a name).
  async rename(id, nextName) {
    const trimmed = nextName?.trim();
    if (!trimmed) throw httpError(400, 'name required');
    const state = this.#known(id);
    if (state.status === 'exporting') {
      throw httpError(409, 'wait for the export to finish before renaming');
    }
    state.displayName = trimmed;
    await this.#saveIndex();
    return this.#entry(id);
  }

  // Take an export out of this project (the database copy, if any, is
  // untouched — it can be downloaded again).
  async remove(name) {
    this.#known(name);
    await rm(this.#dir(name), { recursive: true, force: true });
    this.state.delete(name);
    this.parseCache.delete(name);
    await this.#saveIndex();
  }

  // Parse the exported folder into { model, byFile } (cached until the next
  // export). Reads every .xml under the export root, keyed by forward-slash
  // relative path — the identity the parser, the diff, and the UI all share.
  async #parsed(name) {
    const state = this.#known(name);
    if (state.status !== 'ready') {
      throw httpError(409, `RTAC project ${name} is not exported into this projector project yet`);
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
      // What the sidebar calls this copy, so the pane heading and the row
      // agree — the name inside the XML is the same for every copy of one
      // project, and ignores a rename.
      name: this.state.get(name)?.displayName ?? model.name ?? name,
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
      label: this.state.get(name)?.displayName ?? parsed.model.name ?? name,
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
