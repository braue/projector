// Artifacts — the settings files living inside a project's ONE folder tree.
//
// The files store (services/files.js) owns the bytes: settings artifacts are
// ordinary entries in the user's own folder structure, versioned by the same
// sidecar every file uses. This service owns MEANING: which entries are
// settings artifacts, parsing them on demand, and serving the inspect /
// compare / search shapes over them.
//
// An artifact is addressed by its TREE PATH (an archived version by its real
// `dir/.versions/<storedName>` path — old versions inspect and compare like
// any other artifact). A profile inside one is "<path>::<profileName>"
// (':' is invalid in file names — services/files.js strips it — so the
// separator cannot occur in the path half).
//
// KINDS are per-type classes (services/rdb.js, scd.js, sw.js, and RtacKind
// below) plugged into a registry here. Detection is by extension — cheap
// enough for tree annotation, no parsing:
//
//   .rdb                        QuickSet relay database
//   .scd .ssd .sed .cid .icd    IEC 61850 SCL
//   .xml .cfg .bin              SEL managed-switch settings export
//   <name>.rtac/  (a FOLDER)    an RTAC project export (folder-of-XML)
//
// MEMORY is the reason this service exists as one place. A large RTAC export
// parses into a model of a gigabyte and more, and the old per-store caches
// held every parsed model forever — inspecting a handful of big exports was
// enough to blow past V8's heap ceiling and take the whole app down (the
// packaged app hosts this backend in the Electron main process). Two rules
// keep that bounded:
//
//   - the parse cache is LRU with a hard cap per weight class (RTAC exports
//     count heavy; single-file artifacts light) — compare needs two models
//     live, so heavy keeps 2;
//   - RTAC exports parse ONE FILE AT A TIME, reading each XML, parsing it,
//     and dropping the string before the next — never the whole 500 MB of
//     XML and the growing model at once.

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { modelSignature } from './compare.js';
import { INVALID_NAME } from './fs.js';
import { httpError } from './http.js';
import { itemSummary } from './inspect.js';
import { parseRtacModule } from './parsers/rtac/parseModule.js';
import { buildProject, moduleBaseName } from './parsers/rtac/project.js';
import { foldTree } from './tree.js';

const REF_SEPARATOR = '::';
const RTAC_SUFFIX = /\.rtac$/i;
const EXPORTABLE = /\.xml$/i;
const RTAC_MODEL_VERSION = 2;

// How many parsed models stay live per weight class. Heavy (RTAC) models run
// to a gigabyte-plus each; two is exactly a comparison. Light models are a
// few MB and a dozen covers a busy session.
const CACHE_CAP = { heavy: 2, light: 12 };

/** The kind of artifact a tree entry is, or null for a plain file. */
function kindOfName(name, isDirectory) {
  if (isDirectory) return RTAC_SUFFIX.test(name) ? 'rtac' : null;
  if (/\.rdb$/i.test(name)) return 'rdb';
  if (/\.(scd|ssd|sed|cid|icd)$/i.test(name)) return 'scd';
  if (/\.(xml|cfg|bin)$/i.test(name)) return 'sw';
  return null;
}

function splitArtifactRef(ref) {
  const at = (ref ?? '').indexOf(REF_SEPARATOR);
  if (at === -1) return { path: ref, profileName: null };
  return { path: ref.slice(0, at), profileName: ref.slice(at + REF_SEPARATOR.length) };
}

/** What to call an artifact on screen: its entry name, with the archive
 *  stamp an old version's stored name carries shed. */
function entryLabel(treePath) {
  return path.basename(treePath).replace(/^\d{10,}-/, '');
}

function requireNote(note) {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (!trimmed) throw httpError(400, 'a version note is required');
  return trimmed;
}

// --- kind base ---------------------------------------------------------------

/**
 * What every artifact kind supplies on top of this base:
 *
 *   parse(buffer, name) -> model       (throw on unreadable input)
 *   profilesOf(model, path) -> [{ name, deviceType }]
 *   findProfile(model, name, path) -> the profile object, or null
 *   tree(ref) / item(ref, key)         the inspect sections
 *
 * The base owns profile resolution and the compare/search adapter, built on
 * the artifacts service's bounded model cache.
 */
class ArtifactKind {
  constructor({ artifacts, label, weight = 'light' }) {
    this.artifacts = artifacts;
    this.label = label;
    this.weight = weight;
  }

  /** One addressed profile with its context: { path, fileName, model, profile }. */
  async profile(ref) {
    const { path: treePath, profileName } = splitArtifactRef(ref);
    const { model } = await this.artifacts.entry(treePath);
    const profile = profileName === null ? null : this.findProfile(model, profileName, treePath);
    if (!profile) throw httpError(404, `unknown ${this.label} profile: ${ref}`);
    return { path: treePath, fileName: path.basename(treePath), model, profile };
  }

  async profiles(treePath) {
    const { model } = await this.artifacts.entry(treePath);
    return this.profilesOf(model, treePath).map((profile) => ({
      ...profile,
      ref: `${treePath}${REF_SEPARATOR}${profile.name}`,
    }));
  }

  // Compare adapter entries at either granularity, chosen by the ref:
  //   "<path>::<profile>"  one profile's items
  //   "<path>"             the whole file, items namespaced "<profile>/<path>"
  // Memoized on the cache entry, so the adapters die with the model; kinds
  // with their own adapter shape override buildComparable, not this.
  async comparable(ref) {
    const { path: treePath, profileName } = splitArtifactRef(ref);
    const entry = await this.artifacts.entry(treePath);
    entry.comparable ??= new Map();
    if (!entry.comparable.has(ref)) {
      entry.comparable.set(ref, await this.buildComparable(ref, treePath, profileName, entry));
    }
    return entry.comparable.get(ref);
  }

  async buildComparable(ref, treePath, profileName, entry) {
    if (profileName === null) {
      const wholeEntries = [];
      for (const profile of this.profilesOf(entry.model, treePath)) {
        const profileRef = `${treePath}${REF_SEPARATOR}${profile.name}`;
        wholeEntries.push(...await this.#entries(profileRef, `${profile.name}/`));
      }
      return { label: entryLabel(treePath), entries: wholeEntries };
    }
    return {
      label: `${entryLabel(treePath)} · ${profileName}`,
      entries: await this.#entries(ref),
    };
  }

  // One profile's top-level inspect items, signature = canonical (key-sorted)
  // JSON of the WHOLE item, computed lazily — search shares these entries and
  // never reads signatures.
  async #entries(ref, prefix = '') {
    const { tree } = await this.tree(ref);
    const entries = [];
    for (const node of tree) {
      if (node.type !== 'item') continue;
      const item = await this.item(ref, node.path);
      let signature;
      entries.push({
        path: `${prefix}${node.path}`,
        name: node.name,
        item,
        get signature() {
          return (signature ??= modelSignature(item));
        },
      });
    }
    return entries;
  }
}

// --- the RTAC kind -----------------------------------------------------------

// True when the parser captured no content-ful fields from an item — its
// canonical signature would be constant however the file changes; the raw
// hash adds sensitivity exactly there.
function modelBlind(item) {
  return !Object.keys(item.settings).length
    && !item.points.length
    && !item.pages.length
    && item.code == null
    && item.archivedContentHash == null;
}

class RtacKind extends ArtifactKind {
  constructor(options) {
    super({ ...options, label: 'rtac', weight: 'heavy' });
  }

  // An RTAC artifact is a FOLDER of XML — parse() takes its absolute dir.
  // One file at a time: read, parse, hash, drop the string. The old
  // all-strings-then-parse shape held ~600 MB of XML beside the growing
  // model and was half the reason big exports OOMed the app.
  async parseDir(root) {
    const files = [];
    const walk = async (dir, rel) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
        else if (EXPORTABLE.test(entry.name)) files.push({ file: relPath, abs: path.join(dir, entry.name) });
      }
    };
    await walk(root, '');
    files.sort((a, b) => a.file.localeCompare(b.file));

    const modules = [];
    const errors = [];
    const hashes = new Map();
    for (const { file, abs } of files) {
      let xml;
      try {
        xml = await readFile(abs, 'utf8');
      } catch (err) {
        errors.push({ file, error: err?.message ?? String(err) });
        continue;
      }
      hashes.set(file, createHash('sha1').update(xml).digest('hex'));
      try {
        modules.push(parseRtacModule(xml, file));
      } catch (err) {
        errors.push({ file, error: err?.message ?? String(err) });
      }
      // parseRtacModule is synchronous, and a big export runs a minute of it.
      // Yield between files so the event loop breathes — this backend shares
      // the Electron main process, and sixty seconds of solid parse would
      // freeze every other request (and the app's own plumbing) with it.
      await new Promise((resolve) => setImmediate(resolve));
    }

    const model = {
      modelVersion: RTAC_MODEL_VERSION,
      fileCount: files.length,
      errors,
      ...buildProject(modules),
    };
    // Raw-byte hashes for MODEL-BLIND items only (see modelBlind) — computed
    // for every file above because the strings are gone by now, kept only
    // where they add signature sensitivity.
    const byFile = new Map();
    const rawHashes = new Map();
    for (const item of model.items) {
      byFile.set(item.file, item);
      if (modelBlind(item)) rawHashes.set(item.file, hashes.get(item.file) ?? '');
    }
    return { model, byFile, rawHashes };
  }

  profilesOf() {
    // An RTAC export is one device; inspect addresses the whole artifact.
    return [];
  }

  findProfile() {
    return null;
  }

  static #itemNode(item, extra = {}) {
    return {
      type: 'item',
      name: item.name ?? moduleBaseName(item.file),
      path: item.file,
      ...itemSummary(item),
      ...extra,
    };
  }

  async tree(ref) {
    const { path: treePath } = splitArtifactRef(ref);
    const { model } = await this.artifacts.entry(treePath);
    return {
      name: entryLabel(treePath).replace(RTAC_SUFFIX, ''),
      schema: model.schema,
      deviceLabel: model.deviceMOT ? `SEL-${model.deviceMOT}` : null,
      summary: model.summary,
      errors: model.errors,
      tree: foldTree(model.items.map((item) => RtacKind.#itemNode(item)), model.errors),
    };
  }

  async item(ref, file) {
    const { path: treePath } = splitArtifactRef(ref);
    const entry = await this.artifacts.entry(treePath);
    const item = entry.byFile.get(file);
    if (!item) throw httpError(404, `no such item in ${treePath}: ${file}`);
    return item;
  }

  // Signatures fold the raw hash back in for model-blind files.
  buildComparable(ref, treePath, _profileName, entry) {
    const signatures = new Map();
    const signatureOf = (item) => {
      let signature = signatures.get(item.file);
      if (!signature) {
        const hash = createHash('sha1').update(modelSignature(item));
        const raw = entry.rawHashes.get(item.file);
        if (raw) hash.update(raw);
        signature = hash.digest('hex');
        signatures.set(item.file, signature);
      }
      return signature;
    };
    return {
      label: entryLabel(treePath).replace(RTAC_SUFFIX, ''),
      entries: entry.model.items.map((item) => ({
        path: item.file,
        name: item.name ?? moduleBaseName(item.file),
        item,
        get signature() {
          return signatureOf(item);
        },
      })),
    };
  }

  // Pivot a list of setting names across a range of objects: for each object
  // in scope, the value of every setting whose name matches each term
  // (case-insensitive; exact name or substring).
  async aggregate(treePath, { terms = [], files = [] } = {}) {
    const { model } = await this.artifacts.entry(treePath);
    const wanted = terms.map((term) => String(term).trim()).filter(Boolean);
    if (!wanted.length) throw httpError(400, 'at least one setting name is required');
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

// --- the service -------------------------------------------------------------

class ArtifactsService {
  // treePath -> { key, weight, model, ... } — the bounded model cache. Order
  // is LRU: Map iteration is insertion order, and every hit re-inserts.
  #cache = new Map();
  // treePath being exported from AcRTAC right now, or holding a failure the
  // UI should show: relDir/name.rtac -> { status, at, note, database, error? }.
  #pendingExports = new Map();
  // In-flight parses per weight class. Evicting a cache entry cannot stop a
  // parse already running, so ADMISSION is what actually bounds concurrent
  // parse memory: a second heavy compare queues behind the first instead of
  // quadrupling the gigabyte-scale models in flight.
  #parseSlots = new Map();

  constructor({ files, catalog, projectDir }) {
    this.files = files;
    this.catalog = catalog;
    this.projectDir = projectDir;
    this.kinds = { rtac: new RtacKind({ artifacts: this }) };
  }

  /** services/rdb.js etc. register themselves here (they need constructor
   *  options of their own, so they are built by the project bundle). */
  register(name, kind) {
    this.kinds[name] = kind;
  }

  kindOf(name, isDirectory) {
    return kindOfName(name, isDirectory);
  }

  /** The kind for a ref/path, from the name alone. */
  #kindFor(treePath) {
    const base = path.basename(treePath);
    const kind = kindOfName(base, false) ?? kindOfName(base, true);
    if (!kind || !this.kinds[kind]) {
      throw httpError(400, `not a settings artifact: ${treePath}`);
    }
    return this.kinds[kind];
  }

  /**
   * The parse-cache entry for a tree path: { model, ... } plus whatever the
   * kind's parse attached (byFile, rawHashes) and lazy per-entry memos
   * (comparable, drawings). Keyed by path + stat identity so a new version
   * under the same name re-parses; LRU-evicted per weight class.
   *
   * The cache holds the IN-FLIGHT PROMISE, not the settled result: a big
   * RTAC export parses for a minute, and the tree fetch racing the compare
   * adapter must share one parse — two concurrent parses of a 550 MB export
   * is exactly the memory spike this cache exists to prevent.
   */
  async entry(treePath) {
    const { absolute, key, isDirectory } = await this.files.identify(treePath);
    const kindName = kindOfName(path.basename(treePath), isDirectory);
    const kind = kindName ? this.kinds[kindName] : null;
    if (!kind) throw httpError(400, `not a settings artifact: ${treePath}`);

    const cached = this.#cache.get(treePath);
    if (cached?.key === key) {
      // Re-insert = mark most recently used.
      this.#cache.delete(treePath);
      this.#cache.set(treePath, cached);
      return cached.promise;
    }
    this.#cache.delete(treePath);

    const promise = this.#withParseSlot(kind.weight, () => isDirectory
      ? kind.parseDir(absolute)
      : (async () => {
        const buffer = await readFile(absolute);
        let model;
        try {
          model = kind.parse(buffer, path.basename(treePath));
        } catch (err) {
          throw httpError(400, `${kind.uploadErrorLabel ?? `not a readable ${kind.label} file`}: ${err?.message ?? err}`);
        }
        kind.validate?.(model);
        return { model, hash: createHash('sha1').update(buffer).digest('hex') };
      })());

    this.#cache.set(treePath, { key, weight: kind.weight, promise });
    promise.catch(() => {
      // A failed parse must not pin a rejected promise in the cache.
      if (this.#cache.get(treePath)?.promise === promise) this.#cache.delete(treePath);
    });
    this.#evict(kind.weight);
    return promise;
  }

  /** Run one parse, holding a per-weight slot: at most CACHE_CAP[weight]
   *  parses of that class run at once, everything else waits its turn. The
   *  waiting promise sits in the cache, so concurrent requests still share
   *  one parse. */
  async #withParseSlot(weight, work) {
    const cap = CACHE_CAP[weight] ?? CACHE_CAP.light;
    let slot = this.#parseSlots.get(weight);
    if (!slot) this.#parseSlots.set(weight, (slot = { active: 0, waiters: [] }));
    while (slot.active >= cap) {
      await new Promise((resolve) => slot.waiters.push(resolve));
    }
    slot.active += 1;
    try {
      return await work();
    } finally {
      slot.active -= 1;
      slot.waiters.shift()?.();
    }
  }

  #evict(weight) {
    const cap = CACHE_CAP[weight] ?? CACHE_CAP.light;
    const same = [...this.#cache.entries()].filter(([, entry]) => entry.weight === weight);
    for (const [treePath] of same.slice(0, Math.max(0, same.length - cap))) {
      this.#cache.delete(treePath);
    }
  }

  /** Drop any cached model for a path (called by the files store on delete/
   *  rename/move — the path no longer means what it meant). */
  invalidate(treePath) {
    for (const key of [...this.#cache.keys()]) {
      if (key === treePath || key.startsWith(`${treePath}/`)) this.#cache.delete(key);
    }
  }

  // --- the inspect/compare/search surface ------------------------------------

  async tree(ref) {
    return this.#kindFor(splitArtifactRef(ref).path).tree(ref);
  }

  async item(ref, key) {
    return this.#kindFor(splitArtifactRef(ref).path).item(ref, key);
  }

  async profiles(treePath) {
    return this.#kindFor(treePath).profiles(treePath);
  }

  async comparable(ref) {
    const treePath = splitArtifactRef(ref).path;
    const kind = this.#kindFor(treePath);
    return { kind: kind.label, ...(await kind.comparable(ref)) };
  }

  async aggregate(treePath, options) {
    // Any kind that implements the hook aggregates; today that is RTAC only.
    const kind = this.#kindFor(treePath);
    if (typeof kind.aggregate !== 'function') {
      throw httpError(400, `aggregate is not available for ${kind.label} artifacts`);
    }
    return kind.aggregate(treePath, options);
  }

  // --- RTAC intake -------------------------------------------------------------

  /** The AcRTAC catalog for the database browser. */
  available() {
    return {
      projects: this.catalog.names.map((name) => ({ name })),
      error: this.catalog.error ?? null,
    };
  }

  /** Pending / failed AcRTAC exports, for the sidebar to overlay. */
  exportStatus() {
    return [...this.#pendingExports.entries()].map(([treePath, state]) => ({
      path: treePath,
      ...state,
    }));
  }

  dismissExportError(treePath) {
    const state = this.#pendingExports.get(treePath);
    if (state?.status === 'error') this.#pendingExports.delete(treePath);
  }

  /**
   * Download a database project into `dirPath` as `<name>.rtac`. If that
   * entry already exists there, the download lands as its NEW VERSION (the
   * old bytes archive with their note). The export writes into a hidden
   * temp folder first, so a half-written export can never look ready.
   *
   * `into` names an EXISTING entry this download supersedes — "new version
   * from AcRTAC". The entry always ends up named after the DATABASE project:
   * when `into` carries a different name, the arrival renames the entry and
   * its history rides along (files.placeEntry's versionOf).
   */
  async startExport(dirPath, displayName, note, into = null) {
    const trimmedNote = requireNote(note);
    if (!this.catalog.names.includes(displayName)) {
      throw httpError(404, `unknown RTAC project: ${displayName}`);
    }
    const entryName = `${displayName.replace(INVALID_NAME, '_')}.rtac`;
    const versionOf = into && String(into) !== entryName
      ? String(into).replace(INVALID_NAME, '_')
      : null;
    if (versionOf && !RTAC_SUFFIX.test(versionOf)) {
      throw httpError(400, `not an RTAC entry: ${into}`);
    }
    const treePath = dirPath ? `${dirPath}/${entryName}` : entryName;
    if (this.#pendingExports.get(treePath)?.status === 'exporting') {
      throw httpError(409, `already exporting: ${treePath}`);
    }
    if (versionOf) {
      // A doomed rename must fail HERE, not after the multi-minute export:
      // the superseded entry must exist, and the database-derived name must
      // be free — unless it differs from the old name only by case, which
      // resolves to the same entry on the shipped (Windows) filesystem and
      // is the rename itself, not a collision (files.#place agrees).
      const supersededPath = dirPath ? `${dirPath}/${versionOf}` : versionOf;
      await this.files.identify(supersededPath);
      if (versionOf.toLowerCase() !== entryName.toLowerCase()
        && await this.files.identify(treePath).then(() => true, () => false)) {
        throw httpError(409, `already exists: ${entryName} — the download would rename ${versionOf} onto it`);
      }
      // Two concurrent downloads superseding the SAME entry key differently
      // here (by database name) but collide at placement — refuse the second.
      for (const [pending, state] of this.#pendingExports) {
        const pendingDir = pending.includes('/') ? pending.slice(0, pending.lastIndexOf('/')) : '';
        if (state.status === 'exporting' && state.into === versionOf && pendingDir === dirPath) {
          throw httpError(409, `already exporting a new version of ${versionOf}`);
        }
      }
    }
    // `database` rides the state so a failed export can RETRY with the real
    // database name — the tree path alone cannot reproduce it (the entry may
    // be renamed, and invalid characters were sanitized away). `into` rides
    // for the same reason: the retry must still supersede the same entry.
    this.#pendingExports.set(treePath, {
      status: 'exporting',
      at: Date.now(),
      note: trimmedNote,
      database: displayName,
      into: versionOf,
    });

    // Fire-and-forget: the request returns 202 and the sidebar polls
    // exportStatus(). Failures land as 'error' rather than throwing.
    (async () => {
      const staging = path.join(this.projectDir, `.rtac-staging-${Date.now()}`);
      try {
        await rm(staging, { recursive: true, force: true });
        await this.catalog.client.exportXml({ name: displayName, directory: staging });
        await this.files.placeEntry(dirPath, entryName, trimmedNote, async (target) => {
          await rename(staging, target);
        }, { directory: true, versionOf, database: displayName });
        this.invalidate(treePath);
        this.#pendingExports.delete(treePath);
      } catch (err) {
        this.#pendingExports.set(treePath, {
          status: 'error',
          at: Date.now(),
          note: trimmedNote,
          database: displayName,
          into: versionOf,
          error: err?.message ?? String(err),
        });
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    })();

    return { path: treePath, status: 'exporting' };
  }

  /**
   * An exported folder uploaded straight from disk — the no-database path.
   * Files arrive with folder-relative paths ("Export1/SEL_RTAC/Devices.xml");
   * the top segment names the export. Same versioning as a download. Each
   * file carries either `buffer` (bytes in hand) or `source` (a temp file on
   * disk) — the route streams big uploads through temp files so a 500 MB
   * export never sits in main-process memory whole.
   */
  async uploadFolder(dirPath, files, note) {
    const trimmedNote = requireNote(note);
    const groups = new Map();
    for (const file of files) {
      const segments = String(file.path)
        .split(/[\\/]/)
        .filter((segment) => segment && segment !== '.' && segment !== '..');
      if (segments.length < 2 || !EXPORTABLE.test(segments[segments.length - 1])) continue;
      const [name, ...rest] = segments;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ rest, buffer: file.buffer ?? null, source: file.source ?? null });
    }
    if (!groups.size) {
      throw httpError(400, 'no .xml files found — upload the exported RTAC project folder itself');
    }

    const added = [];
    for (const [name, entries] of groups) {
      const entryName = `${name.replace(INVALID_NAME, '_')}.rtac`;
      const treePath = dirPath ? `${dirPath}/${entryName}` : entryName;
      await this.files.placeEntry(dirPath, entryName, trimmedNote, async (target) => {
        for (const entry of entries) {
          const file = path.join(target, ...entry.rest);
          await mkdir(path.dirname(file), { recursive: true });
          if (entry.buffer) await writeFile(file, entry.buffer);
          else await copyFile(entry.source, file);
        }
      }, { directory: true });
      this.invalidate(treePath);
      added.push({ path: treePath, files: entries.length });
    }
    return { added };
  }
}

export { ArtifactKind, ArtifactsService, splitArtifactRef };
