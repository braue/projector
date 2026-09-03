// Project files — THE folder tree a project is. Settings artifacts, PDFs,
// and plain-text notes all live here as entries the engineer organizes; the
// artifacts service (lib/artifacts.js) layers meaning on top.
//
// The user's folder tree IS a real directory tree under <project>/files/:
// folders are directories, files keep their names, and every operation is a
// plain filesystem operation. That is what makes "open with the default
// app" honest — the backend runs on the same machine as the browser
// (loopback-only), so opening hands the OS a real path.
//
// VERSIONS. Adding a name that already exists in a folder does not
// unique-ify it into "name-2.pdf" — it stacks: the live entry stays the
// newest version under its plain name (what someone browsing the folder in
// the OS expects), and the bytes it replaced move into the folder's hidden
// `.versions/` directory. This applies to directories too — an RTAC export
// (`<name>.rtac/`) versions exactly like a file. Two dot-prefixed artifacts
// per folder carry this, both invisible to the tree:
//
//   .versions/          the archived bytes of every superseded version
//   .versions.json      { [liveName]: { at, note, history: [
//                           { storedName, at, note }, ...oldest-first ] } }
//
// Every version carries a mandatory NOTE — the one-line account of what it
// changed — and a timestamp; both ride the sidecar, because file mtimes do
// not survive copies between machines. An entry with no sidecar record
// (added before versioning, or dropped into the folder by hand) is simply
// one whose story starts at its mtime.
//
// Paths in the API are forward-slash relative paths inside the store
// ('' = the root); every one is resolved through resolveWithin so nothing
// escapes the project. Archived versions are addressed by their real
// relative path ("dir/.versions/169...-name.pdf") for read/open/inspect,
// which is exactly why read/open do NOT filter dot-segments while tree()
// hides them.

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveWithin } from '../lib/http.js';
import { openWithOs, revealWithOs } from '../lib/openWithOs.js';
import { uniqueName } from '../lib/names.js';
import { treeOrder } from '../lib/tree.js';

// Windows-invalid filename characters (also covers the path separators).
const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/g;

const SIDECAR = '.versions.json';
const ARCHIVE_DIR = '.versions';
// The committed copy — for FILES, `.committed/<name>` holds the bytes of the
// entry's CURRENT version as they arrived. The live file is the WORKING COPY
// (an Excel save edits it in place), so this hidden copy is what lets
// "record those edits as a new version" archive the bytes the edit replaced
// — even for edits made entirely outside the app — and "discard" restore
// them. Refreshed on every arrival; directories never need one (an RTAC
// export only ever changes by a whole new arrival, never an in-place edit).
const COMMITTED_DIR = '.committed';

function cleanName(raw) {
  const name = String(raw ?? '').replace(INVALID_NAME, '').trim();
  if (!name || name === '.' || name === '..') throw httpError(400, `invalid name: ${raw}`);
  // The dot prefix is the store's own namespace (.versions, .versions.json),
  // and a dot-named file would be invisible to the tree anyway.
  if (name.startsWith('.')) throw httpError(400, `names may not start with ".": ${raw}`);
  return name;
}

function requireNote(note) {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (!trimmed) throw httpError(400, 'a version note is required');
  return trimmed;
}

/** Mutations may not reach into the store's own dot-namespace: renaming the
 *  sidecar, rewriting archived bytes, or moving something INTO `.versions/`
 *  would corrupt history. Reads deliberately still address archived paths. */
function assertMutable(relPath) {
  const segments = String(relPath ?? '').split('/');
  // '.'/'..' are resolveWithin's problem (escape), not this guard's — and a
  // path cannot reach a dot-entry without naming it in a literal segment.
  if (segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
    throw httpError(400, `the version archive is read-only: ${relPath}`);
  }
}

class FilesService {
  // Mutations serialize through one chain: sidecar updates are whole-file
  // read-modify-writes, and two in flight would silently drop one side.
  #queue = Promise.resolve();

  constructor({ dataDir, onChanged }) {
    this.root = path.join(dataDir, 'files');
    // Fired with a tree path whose meaning changed (deleted, renamed away,
    // replaced by a new version) — the artifacts service drops its cache.
    this.onChanged = onChanged ?? null;
  }

  async init() {
    await mkdir(this.root, { recursive: true });
  }

  #serialized(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #changed(relPath) {
    try {
      this.onChanged?.(relPath);
    } catch {
      // A cache drop must never fail the operation that caused it.
    }
  }

  #resolve(relPath) {
    return resolveWithin(this.root, relPath, `invalid file path: ${relPath}`);
  }

  async #statOrNull(absolute) {
    try {
      return await stat(absolute);
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Stat identity of one entry, for cache keying: a new version under the
   * same path yields a new key. Directories key on the path + record time
   * (their mtime moves when anything inside is touched, which would
   * re-parse for no reason).
   */
  async identify(relPath) {
    const absolute = this.#resolve(relPath);
    const info = await this.#statOrNull(absolute);
    if (!info) throw httpError(404, `no such entry: ${relPath}`);
    const record = (await this.#loadRecords(path.dirname(absolute)))[path.basename(absolute)];
    const key = info.isDirectory()
      ? `dir:${record?.at ?? Math.round(info.birthtimeMs || info.mtimeMs)}`
      : `file:${info.mtimeMs}:${info.size}`;
    return { absolute, key, isDirectory: info.isDirectory() };
  }

  // --- the sidecar -----------------------------------------------------------

  /** One directory's version records. Only a missing sidecar means "no
   *  versions here". A corrupt one fails a WRITE (`forWrite`) — the next
   *  save would overwrite every note and history pointer in the folder —
   *  but READS degrade to "no records": one hand-mangled sidecar must not
   *  take the whole tree (and every artifact in the folder) down. */
  async #loadRecords(dir, { forWrite = false } = {}) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, SIDECAR), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      if (!forWrite) {
        console.warn(`skipping unreadable version records in ${dir}: ${err?.message ?? err}`);
        return {};
      }
      throw httpError(500, `could not read version records: ${err?.message ?? err}`);
    }
  }

  async #saveRecords(dir, records) {
    const file = path.join(dir, SIDECAR);
    if (!Object.keys(records).length) {
      await rm(file, { force: true });
      return;
    }
    await writeFile(file, JSON.stringify(records, null, 2));
  }

  // --- reads -----------------------------------------------------------------

  /**
   * The whole tree, folders first, name-sorted — the sidebar renders this
   * directly. `path` is the store-relative forward-slash path. Dot-entries
   * (the version archive and its sidecar) never list.
   *
   * `annotate(name, isDirectory)` names the artifact kind of an entry (or
   * null). A DIRECTORY with a kind (an RTAC export) lists as a single
   * artifact leaf — its insides are the artifact's own format, not the
   * user's tree.
   */
  async tree(annotate = () => null) {
    const walk = async (dir, rel) => {
      const [entries, records] = await Promise.all([
        readdir(dir, { withFileTypes: true }),
        this.#loadRecords(dir),
      ]);
      const nodes = await Promise.all(entries
        .filter((entry) => !entry.name.startsWith('.'))
        .map(async (entry) => {
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          // Dirent answers for the LINK on a symlink; follow it, so a linked
          // export or folder reads as what it points at.
          const isDirectory = entry.isSymbolicLink()
            ? (await this.#statOrNull(path.join(dir, entry.name)))?.isDirectory() ?? false
            : entry.isDirectory();
          const kind = annotate(entry.name, isDirectory);
          if (isDirectory && !kind) {
            return {
              type: 'folder',
              name: entry.name,
              path: relPath,
              children: await walk(path.join(dir, entry.name), relPath),
            };
          }
          // Null-safe: a dangling symlink, or an entry deleted between the
          // readdir and this stat, drops from the listing instead of failing
          // the entire tree.
          const info = await this.#statOrNull(path.join(dir, entry.name));
          if (!info) return null;
          const record = records[entry.name];
          return {
            type: 'file',
            name: entry.name,
            path: relPath,
            kind,
            size: isDirectory ? null : info.size,
            modifiedAt: info.mtime.toISOString(),
            // The version time from the sidecar when there is one — mtime
            // does not survive copies between machines.
            uploadedAt: record?.at ?? (Math.round(info.birthtimeMs || info.mtimeMs) || null),
            note: record?.note ?? null,
            // The live bytes no longer match the recorded version: the file
            // was edited in place (Excel, an external tool) — the working
            // copy has uncommitted changes.
            edited: Boolean(!isDirectory && record?.stat
              && (record.stat.mtimeMs !== info.mtimeMs || record.stat.size !== info.size)),
            versions: await this.#versionNodes(dir, relPath, record),
          };
        }));
      return nodes.filter(Boolean).sort(treeOrder);
    };
    return walk(this.root, '');
  }

  /** The archived versions of one live entry, newest first, each addressable
   *  by its real relative path. An archived entry missing on disk (deleted
   *  by hand) is skipped rather than breaking the whole tree. */
  async #versionNodes(dir, relPath, record) {
    if (!record?.history?.length) return [];
    const parentRel = path.dirname(relPath) === '.' ? '' : path.dirname(relPath);
    const nodes = await Promise.all([...record.history].reverse().map(async (entry) => {
      const info = await this.#statOrNull(path.join(dir, ARCHIVE_DIR, entry.storedName));
      if (!info) return null;
      return {
        path: parentRel
          ? `${parentRel}/${ARCHIVE_DIR}/${entry.storedName}`
          : `${ARCHIVE_DIR}/${entry.storedName}`,
        size: info.isDirectory() ? null : info.size,
        at: entry.at ?? null,
        note: entry.note ?? null,
      };
    }));
    return nodes.filter(Boolean);
  }

  // --- mutations -------------------------------------------------------------

  // Store uploaded files into `dirPath` ('' = root), each stamped with the
  // shared version note. A name already present becomes a NEW VERSION of
  // that entry: the previous bytes are archived, never overwritten.
  upload(dirPath, files, note) {
    const trimmedNote = requireNote(note);
    return this.#serialized(async () => {
      const added = [];
      for (const file of files) {
        const name = cleanName(file.originalname);
        await this.#place(dirPath, name, trimmedNote, (target) => writeFile(target, file.buffer));
        added.push(dirPath ? `${dirPath}/${name}` : name);
      }
      return { added };
    });
  }

  /**
   * Version-aware placement of one entry (file or directory): archive the
   * live entry if the name is taken, let `writer(absoluteTarget)` produce
   * the new one, record the note. The seam the RTAC export/upload flows
   * share with plain uploads.
   */
  placeEntry(dirPath, name, note, writer, options) {
    const trimmedNote = requireNote(note);
    return this.#serialized(() => this.#place(dirPath, cleanName(name), trimmedNote, writer, options));
  }

  async #place(dirPath, name, note, writer, { directory = false } = {}) {
    assertMutable(dirPath);
    const dir = this.#resolve(dirPath);
    if (!(await this.#statOrNull(dir))?.isDirectory()) {
      throw httpError(404, `no such folder: ${dirPath || '/'}`);
    }
    const records = await this.#loadRecords(dir, { forWrite: true });
    const live = path.join(dir, name);
    const previous = await this.#statOrNull(live);
    // Versions stack same-shaped things only. A file arriving under the name
    // of an existing FOLDER (or a folder under a file's name) is a mistake —
    // archiving the folder would bury its whole subtree behind a version row
    // that cannot even open.
    if (previous && previous.isDirectory() !== directory) {
      throw httpError(409, previous.isDirectory()
        ? `a folder is named that: ${name}`
        : `a file is named that: ${name}`);
    }
    let archived = null;
    if (previous) {
      const record = records[name]
        ?? { at: Math.round(previous.birthtimeMs || previous.mtimeMs) || null, note: null, history: [] };
      records[name] = record;
      record.history ??= [];
      archived = await this.#archive(dir, name, record);
    }
    try {
      await writer(live);
    } catch (err) {
      // The write failed AFTER the live entry moved into the archive: put it
      // back. A failed arrival must never cost the version that was there.
      if (archived) {
        await rm(live, { recursive: true, force: true }).catch(() => {});
        try {
          await rename(path.join(dir, ARCHIVE_DIR, archived.storedName), live);
          records[name].history.pop();
        } catch {
          // Restore failed too — persist the record so the archived bytes at
          // least stay referenced for recovery instead of orphaned.
          await this.#saveRecords(dir, records).catch(() => {});
        }
      }
      throw err;
    }
    const placed = await this.#statOrNull(live);
    records[name] = {
      at: Date.now(),
      note,
      history: records[name]?.history ?? [],
      // For files, the stat of the bytes as committed — an in-place edit
      // (Excel saving over the working copy) is detected by divergence
      // from this.
      ...(placed?.isFile() ? { stat: { mtimeMs: placed.mtimeMs, size: placed.size } } : {}),
    };
    if (placed?.isFile()) {
      // Refresh the committed copy to back the NEW current version. Best
      // effort: a failed copy degrades edit protection, not the arrival.
      try {
        await mkdir(path.join(dir, COMMITTED_DIR), { recursive: true });
        await copyFile(live, path.join(dir, COMMITTED_DIR, name));
      } catch (err) {
        console.warn(`could not keep a committed copy of ${name}: ${err?.message ?? err}`);
      }
    } else {
      await rm(path.join(dir, COMMITTED_DIR, name), { force: true }).catch(() => {});
    }
    await this.#saveRecords(dir, records);
    this.#changed(dirPath ? `${dirPath}/${name}` : name);
  }

  /** Move the superseded version of `name` — the live copy, or `source`
   *  when its bytes live elsewhere (a pre-edit snapshot) — into the archive
   *  and append it to the record's history; returns the history entry. The
   *  stored name is prefixed with the version's own timestamp so archives
   *  sort chronologically on disk and never collide across versions of one
   *  name. */
  async #archive(dir, name, record, source = null) {
    const archiveDir = path.join(dir, ARCHIVE_DIR);
    await mkdir(archiveDir, { recursive: true });
    const taken = new Set(await readdir(archiveDir));
    const storedName = uniqueName(`${record.at ?? Date.now()}-${name}`, (candidate) => taken.has(candidate));
    await rename(source ?? path.join(dir, name), path.join(archiveDir, storedName));
    const entry = { storedName, at: record.at ?? null, note: record.note ?? null };
    record.history.push(entry);
    return entry;
  }

  createFolder(dirPath, name) {
    return this.#serialized(async () => {
      assertMutable(dirPath);
      const parent = this.#resolve(dirPath);
      const folder = path.join(parent, cleanName(name));
      this.#resolve(path.relative(this.root, folder));
      if (await this.#statOrNull(folder)) throw httpError(409, `already exists: ${name}`);
      await mkdir(folder, { recursive: false });
    });
  }

  renameEntry(relPath, nextName) {
    return this.#serialized(async () => {
      assertMutable(relPath);
      const from = this.#resolve(relPath);
      if (from === this.root) throw httpError(400, 'cannot rename the root');
      if (!(await this.#statOrNull(from))) throw httpError(404, `no such entry: ${relPath}`);
      const cleaned = cleanName(nextName);
      const to = path.join(path.dirname(from), cleaned);
      if (to === from) return;
      if (await this.#statOrNull(to)) throw httpError(409, `already exists: ${nextName}`);
      await rename(from, to);
      // An entry's versions follow its name; the archived bytes stay put
      // (they are addressed through the record, not through the live name).
      const dir = path.dirname(from);
      const records = await this.#loadRecords(dir, { forWrite: true });
      const previousName = path.basename(from);
      if (records[previousName]) {
        records[cleaned] = records[previousName];
        delete records[previousName];
        await this.#saveRecords(dir, records);
      }
      // The committed copy follows the name too.
      await this.#moveCommitted(dir, previousName, dir, cleaned);
      this.#changed(relPath);
    });
  }

  // Move a file or folder into another folder ('' = root).
  moveEntry(relPath, toDir) {
    return this.#serialized(async () => {
      assertMutable(relPath);
      assertMutable(toDir);
      const from = this.#resolve(relPath);
      if (from === this.root) throw httpError(400, 'cannot move the root');
      const info = await this.#statOrNull(from);
      if (!info) throw httpError(404, `no such entry: ${relPath}`);
      const target = this.#resolve(toDir);
      if (!(await this.#statOrNull(target))?.isDirectory()) {
        throw httpError(404, `no such folder: ${toDir || '/'}`);
      }
      // A folder cannot move into itself or a descendant.
      if (target === from || target.startsWith(from + path.sep)) {
        throw httpError(400, 'cannot move a folder into itself');
      }
      const name = path.basename(from);
      const to = path.join(target, name);
      if (to === from) return;
      if (await this.#statOrNull(to)) {
        throw httpError(409, `already exists there: ${name}`);
      }
      await rename(from, to);
      // A plain folder carries its own sidecar and archive inside it; any
      // OTHER entry's record and archived versions live in the directory it
      // left, so they move with it. (Artifact directories look like leaves
      // to the UI but are still directories — their versions ride the
      // record like a file's.)
      await this.#moveRecord(path.dirname(from), target, name);
      await this.#moveCommitted(path.dirname(from), name, target, name);
      this.#changed(relPath);
    });
  }

  /** Carry one entry's committed copy between directories/names (no-op when
   *  there is none). */
  async #moveCommitted(fromDir, fromName, toDir, toName) {
    const from = path.join(fromDir, COMMITTED_DIR, fromName);
    if (!(await this.#statOrNull(from))) return;
    await mkdir(path.join(toDir, COMMITTED_DIR), { recursive: true });
    await rename(from, path.join(toDir, COMMITTED_DIR, toName));
  }

  /** Carry one entry's version record — and its archived bytes — from one
   *  directory's bookkeeping to another's. */
  async #moveRecord(fromDir, toDir, name) {
    if (fromDir === toDir) return;
    const fromRecords = await this.#loadRecords(fromDir, { forWrite: true });
    const record = fromRecords[name];
    if (!record) return;
    const toRecords = await this.#loadRecords(toDir, { forWrite: true });
    if (record.history?.length) {
      const archiveDir = path.join(toDir, ARCHIVE_DIR);
      await mkdir(archiveDir, { recursive: true });
      const taken = new Set(await readdir(archiveDir));
      for (const entry of record.history) {
        const storedName = uniqueName(entry.storedName, (candidate) => taken.has(candidate));
        await rename(
          path.join(fromDir, ARCHIVE_DIR, entry.storedName),
          path.join(archiveDir, storedName),
        );
        taken.add(storedName);
        entry.storedName = storedName;
      }
    }
    toRecords[name] = record;
    delete fromRecords[name];
    await this.#saveRecords(fromDir, fromRecords);
    await this.#saveRecords(toDir, toRecords);
  }

  removeEntry(relPath) {
    return this.#serialized(async () => {
      assertMutable(relPath);
      const absolute = this.#resolve(relPath);
      if (absolute === this.root) throw httpError(400, 'cannot delete the root');
      const info = await this.#statOrNull(absolute);
      if (!info) throw httpError(404, `no such entry: ${relPath}`);
      await rm(absolute, { recursive: true, force: true });
      // Deleting an entry deletes its history with it — the versions were
      // versions OF the thing just removed.
      const dir = path.dirname(absolute);
      const records = await this.#loadRecords(dir, { forWrite: true });
      const record = records[path.basename(absolute)];
      if (record) {
        for (const entry of record.history ?? []) {
          await rm(path.join(dir, ARCHIVE_DIR, entry.storedName), { recursive: true, force: true });
        }
        delete records[path.basename(absolute)];
        await this.#saveRecords(dir, records);
      }
      await rm(path.join(dir, COMMITTED_DIR, path.basename(absolute)), { force: true }).catch(() => {});
      this.#changed(relPath);
    });
  }

  // --- content ---------------------------------------------------------------

  // One file's content — how the Tools pane sources an input from the
  // project instead of a fresh upload.
  async read(relPath) {
    const absolute = this.#resolve(relPath);
    if (!(await this.#statOrNull(absolute))?.isFile()) {
      throw httpError(404, `no such file: ${relPath}`);
    }
    return readFile(absolute);
  }

  /** A text file's content, for the built-in editor. */
  async readText(relPath) {
    return (await this.read(relPath)).toString('utf8');
  }

  /**
   * Save a text file (the notes editor's write path). Editing text in place
   * is NOT a new version — versions mark deliberate arrivals, and an editor
   * autosaving on every pause would bury them. Creating a brand-new file
   * here is fine (that is how a note is born).
   */
  writeText(relPath, text) {
    if (typeof text !== 'string') throw httpError(400, 'text must be a string');
    return this.#serialized(async () => {
      // Archived bytes are immutable — the editor's read-only rendering of a
      // version is a promise this write path has to keep.
      assertMutable(relPath);
      const absolute = this.#resolve(relPath);
      const base = path.basename(absolute);
      // ENFORCE the name rule, not just sanitize: a stripped-and-different
      // name means the caller asked for characters no entry may carry (':'
      // would collide with the "path::profile" ref separator).
      if (cleanName(base) !== base) throw httpError(400, `invalid name: ${base}`);
      const existing = await this.#statOrNull(absolute);
      if (existing?.isDirectory()) throw httpError(409, `a folder is named that: ${relPath}`);
      if (!(await this.#statOrNull(path.dirname(absolute)))?.isDirectory()) {
        throw httpError(404, 'no such folder');
      }
      await writeFile(absolute, text);
      // The built-in editor IS the app: its save updates the recorded stat
      // AND the committed copy — in-place text edits deliberately mutate the
      // current version rather than making a new one, so the committed state
      // moves with them and a note never flags as "edited outside".
      // (Read-mode load: a corrupt sidecar has no record to refresh, and
      // must not be clobbered by saving over it.)
      const dir = path.dirname(absolute);
      const records = await this.#loadRecords(dir);
      const record = records[base];
      if (record) {
        const info = await stat(absolute);
        record.stat = { mtimeMs: info.mtimeMs, size: info.size };
        const committed = path.join(dir, COMMITTED_DIR, base);
        if (await this.#statOrNull(committed)) {
          await copyFile(absolute, committed).catch(() => {});
        }
        await this.#saveRecords(dir, records);
      }
      this.#changed(relPath);
    });
  }

  // Hand the file to the OS default app. Loopback deployment makes this the
  // user's own machine; the path is store-confined by #resolve. Archived
  // versions open too — their paths point into `.versions/`.
  //
  // The live file is the WORKING COPY: the default app edits it in place
  // (that is what makes open honest). Its committed bytes already sit in
  // `.committed/` from the arrival; opening backfills one for entries that
  // predate committed copies (dropped in by hand, or before the feature).
  async open(relPath) {
    const absolute = this.#resolve(relPath);
    const info = await this.#statOrNull(absolute);
    if (!info?.isFile()) throw httpError(404, `no such file: ${relPath}`);
    await this.ensureCommittedCopy(relPath);
    openWithOs(absolute);
  }

  /**
   * Backfill the committed copy for a live file that predates them: its
   * current bytes become the recorded state, so in-place edits can be
   * detected, recorded, and discarded. Skipped when a copy already exists,
   * when the file has already diverged (the copy would capture edits, not
   * the committed state), and for archived paths (history is immutable,
   * never a working copy). Best-effort on a degraded (corrupt-sidecar)
   * folder: never blocks open.
   */
  ensureCommittedCopy(relPath) {
    const segments = String(relPath ?? '').split('/');
    if (segments.some((segment) => segment.startsWith('.'))) return Promise.resolve();
    return this.#serialized(async () => {
      const absolute = this.#resolve(relPath);
      const info = await this.#statOrNull(absolute);
      if (!info?.isFile()) return;
      const dir = path.dirname(absolute);
      const name = path.basename(absolute);
      let records;
      try {
        records = await this.#loadRecords(dir, { forWrite: true });
      } catch {
        return; // Degraded folder — open still works, just unprotected.
      }
      const record = records[name]
        ??= { at: Math.round(info.birthtimeMs || info.mtimeMs) || null, note: null, history: [] };
      const diverged = record.stat
        && (record.stat.mtimeMs !== info.mtimeMs || record.stat.size !== info.size);
      if (diverged) return;
      const committed = path.join(dir, COMMITTED_DIR, name);
      if (!(await this.#statOrNull(committed))) {
        await mkdir(path.join(dir, COMMITTED_DIR), { recursive: true });
        await copyFile(absolute, committed);
      }
      if (!record.stat) {
        record.stat = { mtimeMs: info.mtimeMs, size: info.size };
        await this.#saveRecords(dir, records);
      }
    });
  }

  /**
   * Commit a working copy's in-place edits as a NEW VERSION: the committed
   * copy (when one exists — only entries that predate committed copies lack
   * one) archives as the superseded version, the live bytes become the
   * current version under the mandatory note, and a fresh committed copy
   * backs them.
   */
  recordEdit(relPath, note) {
    const trimmedNote = requireNote(note);
    return this.#serialized(async () => {
      assertMutable(relPath);
      const absolute = this.#resolve(relPath);
      const info = await this.#statOrNull(absolute);
      if (!info?.isFile()) throw httpError(404, `no such file: ${relPath}`);
      const dir = path.dirname(absolute);
      const name = path.basename(absolute);
      const records = await this.#loadRecords(dir, { forWrite: true });
      const record = records[name];
      const diverged = record?.stat
        && (record.stat.mtimeMs !== info.mtimeMs || record.stat.size !== info.size);
      if (!diverged) throw httpError(409, `no on-disk edits to record: ${relPath}`);
      record.history ??= [];
      const committed = path.join(dir, COMMITTED_DIR, name);
      if (await this.#statOrNull(committed)) {
        await this.#archive(dir, name, record, committed);
      }
      records[name] = {
        at: Date.now(),
        note: trimmedNote,
        history: record.history,
        stat: { mtimeMs: info.mtimeMs, size: info.size },
      };
      try {
        await mkdir(path.join(dir, COMMITTED_DIR), { recursive: true });
        await copyFile(absolute, committed);
      } catch (err) {
        console.warn(`could not keep a committed copy of ${name}: ${err?.message ?? err}`);
      }
      await this.#saveRecords(dir, records);
      this.#changed(relPath);
    });
  }

  /** Throw away a working copy's in-place edits: restore the committed copy
   *  over the live file — the checkout to recordEdit's commit. The copy
   *  stays put, still backing the current version. */
  discardEdit(relPath) {
    return this.#serialized(async () => {
      assertMutable(relPath);
      const absolute = this.#resolve(relPath);
      const dir = path.dirname(absolute);
      const name = path.basename(absolute);
      const committed = path.join(dir, COMMITTED_DIR, name);
      if (!(await this.#statOrNull(committed))) {
        throw httpError(404, `no committed copy to restore: ${relPath}`);
      }
      await copyFile(committed, absolute);
      // The restore is a fresh write: re-record the stat so the entry reads
      // clean again.
      const records = await this.#loadRecords(dir, { forWrite: true });
      const record = records[name];
      if (record) {
        const info = await stat(absolute);
        record.stat = { mtimeMs: info.mtimeMs, size: info.size };
        await this.#saveRecords(dir, records);
      }
      this.#changed(relPath);
    });
  }

  // Show an entry in the OS file manager ('' = the store root) — the real
  // on-disk location, for handing files to anything outside the app (a cloud
  // upload page, a USB stick). A directory opens as a folder; a file opens
  // its folder with the file selected where the platform can.
  async reveal(relPath) {
    const absolute = this.#resolve(relPath);
    const info = await this.#statOrNull(absolute);
    if (!info) throw httpError(404, `no such entry: ${relPath || '/'}`);
    revealWithOs(absolute, info.isDirectory());
  }
}

export { FilesService };
