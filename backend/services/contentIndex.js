// The project's full-text index — what the tree's filter box searches when
// it looks inside files rather than at their names.
//
// Every live file of a readable format (lib/extract) is read once and its
// text kept: in memory for searching, and on disk beside the project's
// files/ folder so a restart does not re-read (or re-OCR) anything.
//
//   <project>/text-index/manifest.json   { [treePath]: { key, hash } }
//   <project>/text-index/archived.json   { [treePath]: hash } (versions opened)
//   <project>/text-index/<sha1>.json     { v, parts, wantsOcr, ocrDone, meta, error }
//
// Text is stored by CONTENT HASH, so a renamed or moved file finds its text
// again without reading it, and two copies of one PDF share one read. The
// manifest's `key` (mtime + size) decides when a path must be hashed again.
//
// Two lanes. Every file's text layer is read first; then whatever needs OCR
// (images, scanned PDF pages, either inside a zip or an email) is read in
// the background, one file at a time, most recently changed first. The
// window hears progress as `index` events: { project, reading, ocr }.
//
// Archived versions are not indexed (they would echo every hit of the live
// entry), but `partsOf` reads any path on demand for the preview panes. Their
// blobs are kept (archived.json) while the version exists.
//
// A failed OCR pass keeps the text layer. It counts as done for this session
// and is not written down, so the next session tries again.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EXTRACT_VERSION, extract, formatOf } from '../lib/extract/index.js';
import { flatten } from '../lib/extract/text.js';

/** Files larger than this are listed by name only. */
const MAX_FILE_BYTES = 768 * 1024 * 1024;

/** A burst of tree changes is one rescan. */
const SCAN_SETTLE_MS = 400;

/** Search payload guards. */
const MAX_FILES = 200;
const MAX_HITS_PER_FILE = 6;
const CONTEXT = 56;

/** Progress events at most this often. */
const STATUS_EVERY_MS = 300;

/** Content hashes remembered by stat identity, for the preview panes. */
const MAX_HASHES = 256;

function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Live file leaves of the tree (no folders, no RTAC exports). */
function liveFiles(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === 'folder') liveFiles(node.children, out);
    else if (node.size !== null) out.push(node);
  }
  return out;
}

/** The searchable form of a part: lowercase alongside the original. */
function prepare(parts) {
  return parts.map((part) => ({ ...part, lower: part.text.toLowerCase() }));
}

/** What a hit inside one part reads as: its location and a snippet. */
function hitAt(part, at, length) {
  let where = part.where;
  let text = part.text;
  let offset = at;
  if (part.unit === 'line') {
    const start = part.text.lastIndexOf('\n', at - 1) + 1;
    const endAt = part.text.indexOf('\n', at + length);
    const end = endAt === -1 ? part.text.length : endAt;
    let line = 1;
    for (let i = part.text.indexOf('\n'); i !== -1 && i < start; i = part.text.indexOf('\n', i + 1)) line += 1;
    where = where ? `${where} · line ${line}` : `line ${line}`;
    text = part.text.slice(start, end);
    offset = at - start;
  }
  // Runs of whitespace collapse in the snippet (PDF and cell text is full
  // of them); the match itself is shown exactly as the file has it.
  const collapse = (value) => value.replace(/\s+/g, ' ');
  const from = Math.max(0, offset - CONTEXT);
  const to = Math.min(text.length, offset + length + CONTEXT);
  return {
    where,
    before: (from > 0 ? '…' : '') + collapse(text.slice(from, offset)).trimStart(),
    match: text.slice(offset, offset + length),
    after: collapse(text.slice(offset + length, to)).trimEnd() + (to < text.length ? '…' : ''),
  };
}

class ContentIndex {
  /** `extractor` stands in for lib/extract's extract() in tests. */
  constructor({ files, kindOf, cacheDir, events = null, project = '', extractor = extract }) {
    this.files = files;
    this.extractor = extractor;
    this.kindOf = kindOf;
    this.dir = cacheDir;
    this.events = events;
    this.project = project;
    /** treePath -> { key, hash } (persisted). */
    this.manifest = {};
    /** treePath -> { key, hash, parts (prepared), wantsOcr, ocrDone, meta, error } */
    this.entries = new Map();
    this.textQueue = [];
    this.ocrQueue = [];
    this.inFlight = { text: null, ocr: null };
    this.closed = false;
    this.scanTimer = null;
    this.statusTimer = null;
    this.lastStatus = '';
    this.saveTimer = null;
    this.ready = null;
    this.scanning = null;
    this.rescan = false;
    /** Blobs read on demand for paths outside the index (archived versions). */
    this.side = new Map();
    /** treePath -> hash of archived versions read on demand (persisted). */
    this.archived = {};
    /** absolute path -> { key: mtime + size, hash }, so a reread is a stat. */
    this.hashes = new Map();
    /** treePath -> key of every indexed file as of the latest scan. */
    this.livePaths = new Map();
  }

  // --- lifecycle -------------------------------------------------------------

  start() {
    // A failed start is forgotten, so the next call tries again.
    this.ready ??= this.#load().then(() => this.#scan()).catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** The tree changed: rescan once things settle. */
  schedule() {
    if (this.closed) return;
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.#scan().catch((err) => console.warn(`text index scan failed: ${err?.message ?? err}`));
    }, SCAN_SETTLE_MS);
  }

  close() {
    this.closed = true;
    clearTimeout(this.scanTimer);
    clearTimeout(this.statusTimer);
    clearTimeout(this.saveTimer);
    this.textQueue = [];
    this.ocrQueue = [];
  }

  status() {
    return {
      reading: this.textQueue.length + (this.inFlight.text ? 1 : 0),
      ocr: this.ocrQueue.length + (this.inFlight.ocr ? 1 : 0),
      files: this.entries.size,
    };
  }

  // --- disk ----------------------------------------------------------------

  async #load() {
    await mkdir(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, 'manifest.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') this.manifest = parsed;
    } catch {
      this.manifest = {};
    }
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, 'archived.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') this.archived = parsed;
    } catch {
      this.archived = {};
    }
  }

  #saveSoon() {
    if (this.closed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.closed) return;
      for (const [name, value] of [['manifest.json', this.manifest], ['archived.json', this.archived]]) {
        const file = path.join(this.dir, name);
        const temp = `${file}.${randomUUID()}.tmp`;
        writeFile(temp, JSON.stringify(value))
          .then(() => rename(temp, file))
          .catch((err) => console.warn(`text index ${name} not saved: ${err?.message ?? err}`));
      }
    }, 1000);
  }

  #blobPath(hash) {
    return path.join(this.dir, `${hash}.json`);
  }

  async #readBlob(hash) {
    try {
      const blob = JSON.parse(await readFile(this.#blobPath(hash), 'utf8'));
      return blob?.v === EXTRACT_VERSION ? blob : null;
    } catch {
      return null;
    }
  }

  /** Written whole, then renamed into place. Each write has its own temp
   *  file: the preview pane and the lanes can save the same hash at once. */
  async #writeBlob(hash, blob) {
    const file = this.#blobPath(hash);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ v: EXTRACT_VERSION, ...blob }));
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  /** Blobs nothing points at any more (deleted files, deleted versions). */
  async #sweep() {
    let pruned = false;
    for (const treePath of Object.keys(this.archived)) {
      const exists = await Promise.resolve()
        .then(() => this.files.rawPath(treePath))
        .then(stat)
        .then(() => true, () => false);
      if (!exists) {
        delete this.archived[treePath];
        pruned = true;
      }
    }
    if (this.closed) return;
    if (pruned) this.#saveSoon();
    const live = new Set([...Object.values(this.manifest).map((m) => m.hash), ...Object.values(this.archived)]);
    const names = await readdir(this.dir).catch(() => []);
    await Promise.all(names
      .filter((name) => /^[0-9a-f]{40}\.json$/.test(name) && !live.has(name.slice(0, 40)))
      .map((name) => rm(path.join(this.dir, name), { force: true }).catch(() => {})));
  }

  // --- scanning ------------------------------------------------------------

  /** One scan at a time; a change during a scan earns exactly one more. */
  #scan() {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = this.#scanOnce().finally(() => {
      this.scanning = null;
      if (this.rescan) {
        this.rescan = false;
        this.schedule();
      }
    });
    return this.scanning;
  }

  async #scanOnce() {
    if (this.closed) return;
    const tree = await this.files.tree(this.kindOf);
    const leaves = liveFiles(tree).filter((leaf) => formatOf(leaf.name));
    this.livePaths = new Map(leaves.map((leaf) => [leaf.path, `${leaf.modifiedAt}:${leaf.size}`]));
    const seen = new Set();
    const stale = [];
    for (const leaf of leaves) {
      seen.add(leaf.path);
      const key = `${leaf.modifiedAt}:${leaf.size}`;
      const known = this.entries.get(leaf.path);
      if (known?.key === key) continue;
      const recorded = this.manifest[leaf.path];
      if (recorded?.key === key) {
        // Known on disk from a previous run: load without reading the file.
        const blob = await this.#readBlob(recorded.hash);
        if (blob) {
          this.#adopt(leaf.path, key, recorded.hash, blob);
          continue;
        }
      }
      stale.push({ path: leaf.path, key, size: leaf.size, modifiedAt: leaf.modifiedAt });
    }
    for (const treePath of [...this.entries.keys()]) {
      if (!seen.has(treePath)) this.entries.delete(treePath);
    }
    for (const treePath of Object.keys(this.manifest)) {
      if (!seen.has(treePath)) delete this.manifest[treePath];
    }
    // Newest first: what was just dropped in is what is about to be looked for.
    stale.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    const queued = new Set(this.textQueue.map((item) => item.path));
    for (const item of stale) if (!queued.has(item.path)) this.textQueue.push(item);
    this.ocrQueue = this.ocrQueue.filter((item) => seen.has(item.path));
    this.#saveSoon();
    this.#status();
    this.#pump();
    if (!stale.length) this.#sweep();
  }

  #adopt(treePath, key, hash, blob) {
    this.entries.set(treePath, {
      key,
      hash,
      parts: prepare(blob.parts ?? []),
      wantsOcr: Boolean(blob.wantsOcr),
      ocrDone: Boolean(blob.ocrDone),
      meta: blob.meta ?? null,
      error: blob.error ?? null,
      ocrError: blob.ocrError ?? null,
    });
    this.manifest[treePath] = { key, hash };
    // One OCR read per content: it lands on every entry with that hash.
    if (blob.wantsOcr && !blob.ocrDone && !this.ocrQueue.some((item) => item.hash === hash)) {
      this.ocrQueue.push({ path: treePath, key, hash });
    }
  }

  // --- the two lanes ---------------------------------------------------------

  #pump() {
    if (this.closed) return;
    if (!this.inFlight.text && this.textQueue.length) {
      const item = this.textQueue.shift();
      this.inFlight.text = this.#readText(item)
        .catch((err) => console.warn(`text index: ${item.path}: ${err?.message ?? err}`))
        .finally(() => {
          this.inFlight.text = null;
          this.#status();
          this.#pump();
        });
    }
    // OCR waits for every text layer: it is minutes of work, the rest is not.
    if (!this.inFlight.ocr && !this.inFlight.text && !this.textQueue.length && this.ocrQueue.length) {
      const item = this.ocrQueue.shift();
      this.inFlight.ocr = this.#readOcr(item)
        .catch((err) => console.warn(`text index OCR: ${item.path}: ${err?.message ?? err}`))
        .finally(() => {
          this.inFlight.ocr = null;
          this.#status();
          this.#pump();
        });
    }
    this.#status();
  }

  async #bytesOf(treePath) {
    const absolute = await this.files.rawPath(treePath);
    const info = await stat(absolute);
    if (info.size > MAX_FILE_BYTES) return { bytes: null, absolute };
    return { bytes: await readFile(absolute), absolute };
  }

  async #readText(item) {
    const { bytes } = await this.#bytesOf(item.path);
    if (!bytes) {
      this.#adopt(item.path, item.key, sha1(item.path), { parts: [], error: 'too large to read' });
      return;
    }
    const hash = sha1(bytes);
    let blob = await this.#readBlob(hash);
    if (!blob) {
      blob = await this.#extract(item.path, bytes, false);
      await this.#writeBlob(hash, blob);
    }
    // Deleted or changed while it was read: the scan that saw it has it.
    if (this.closed || this.livePaths.get(item.path) !== item.key) return;
    this.#adopt(item.path, item.key, hash, blob);
    this.#saveSoon();
  }

  async #readOcr(item) {
    const waiting = [...this.entries]
      .filter(([, entry]) => entry.hash === item.hash && !entry.ocrDone)
      .map(([treePath]) => treePath);
    const sideWaiting = this.side.get(item.hash)?.ocrDone === false;
    if (!waiting.length && !(item.side && sideWaiting)) return;
    // Read from the queued path while it still holds this content.
    const source = item.side || waiting.includes(item.path) ? item.path : waiting[0];
    const { bytes } = await this.#bytesOf(source);
    if (!bytes || sha1(bytes) !== item.hash) return; // changed underneath; the rescan has it
    const read = await this.#extract(source, bytes, true);
    if (this.closed) return;
    let blob = read;
    if (read.error) {
      // Keep what the text layer gave; try OCR again next session.
      console.warn(`text index OCR failed: ${source}: ${read.error}`);
      const base = this.side.get(item.hash) ?? this.entries.get(waiting[0]) ?? await this.#readBlob(item.hash);
      blob = {
        parts: (base?.parts ?? []).map(({ lower, ...part }) => part),
        wantsOcr: true,
        ocrDone: true,
        meta: base?.meta ?? null,
        error: base?.error ?? null,
        ocrError: read.error,
      };
    } else {
      await this.#writeBlob(item.hash, blob);
    }
    if (this.closed) return;
    for (const [treePath, entry] of this.entries) {
      if (entry.hash === item.hash) this.#adopt(treePath, entry.key, item.hash, blob);
    }
    if (this.side.has(item.hash)) this.side.set(item.hash, { ...blob, parts: prepare(blob.parts ?? []) });
    this.#saveSoon();
  }

  async #extract(treePath, bytes, ocr) {
    try {
      const { parts, wantsOcr, meta } = await this.extractor(path.basename(treePath), bytes, { ocr });
      return { parts, wantsOcr: ocr ? true : wantsOcr, ocrDone: ocr, meta };
    } catch (err) {
      // Recorded, not retried: a corrupt workbook stays corrupt until a new
      // version (new bytes, new hash) arrives.
      return { parts: [], wantsOcr: false, ocrDone: false, meta: null, error: String(err?.message ?? err) };
    }
  }

  #status() {
    if (!this.events) return;
    const status = this.status();
    const signature = `${status.reading}:${status.ocr}`;
    if (signature === this.lastStatus || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      const now = this.status();
      const sig = `${now.reading}:${now.ocr}`;
      if (sig === this.lastStatus) return;
      this.lastStatus = sig;
      this.events.publish('index', { project: this.project, ...now });
    }, STATUS_EVERY_MS);
  }

  // --- reading -------------------------------------------------------------

  /**
   * The parts of any file — live or archived — for the preview panes. Live
   * files come from the index; anything else is read now (text layer only)
   * and queued for OCR when it needs it.
   *
   * Returns { parts, meta, ocr: 'none' | 'pending' | 'done', error }.
   */
  async partsOf(treePath) {
    await this.start();
    const absolute = await this.files.rawPath(treePath);
    const info = await stat(absolute);
    if (info.size > MAX_FILE_BYTES) return { parts: [], meta: null, ocr: 'none', error: 'too large to read' };
    // The hash by stat identity: find and its polling ask again and again,
    // and a big drawing set must not be read and hashed each time.
    const statKey = `${info.mtimeMs}:${info.size}`;
    let bytes = null;
    let hash = this.hashes.get(absolute)?.key === statKey ? this.hashes.get(absolute).hash : null;
    if (!hash) {
      bytes = await readFile(absolute);
      hash = sha1(bytes);
      this.hashes.delete(absolute);
      this.hashes.set(absolute, { key: statKey, hash });
      if (this.hashes.size > MAX_HASHES) this.hashes.delete(this.hashes.keys().next().value);
    }
    const live = this.entries.get(treePath);
    let blob = live?.hash === hash ? live : this.side.get(hash) ?? null;
    if (!blob) {
      blob = await this.#readBlob(hash);
      if (!blob) {
        bytes ??= await readFile(absolute);
        blob = await this.#extract(treePath, bytes, false);
        await this.#writeBlob(hash, blob);
      }
      blob = { ...blob, parts: prepare(blob.parts ?? []) };
      if (!live || live.hash !== hash) {
        this.side.set(hash, blob);
        if (this.side.size > 16) this.side.delete(this.side.keys().next().value);
        if (!this.livePaths.has(treePath)) {
          // An archived version: its blob is kept while the version exists.
          this.archived[treePath] = hash;
          this.#saveSoon();
        }
        if (blob.wantsOcr && !blob.ocrDone) {
          // Read by OCR in the lane like any other file, stored by hash.
          this.#ocrSide(treePath, hash);
        }
      }
    }
    const ocr = !blob.wantsOcr ? 'none' : blob.ocrDone ? 'done' : 'pending';
    return {
      parts: blob.parts.map(({ lower, ...part }) => part),
      meta: blob.meta ?? null,
      ocr,
      error: blob.error ?? null,
    };
  }

  #ocrSide(treePath, hash) {
    if (this.ocrQueue.some((item) => item.hash === hash)) return;
    // Front of the line: someone is looking at it.
    this.ocrQueue.unshift({ path: treePath, key: null, hash, side: true });
    this.#pump();
  }

  /** Front of the OCR line for a file someone just opened. */
  prioritize(treePath) {
    const at = this.ocrQueue.findIndex((item) => item.path === treePath);
    if (at > 0) this.ocrQueue.unshift(...this.ocrQueue.splice(at, 1));
  }

  // --- searching -------------------------------------------------------------

  /**
   * Files whose text holds `query`, case-insensitive. Each result carries a
   * few located snippets and the total count.
   */
  async search(query) {
    await this.start();
    const needle = String(query ?? '').trim().toLowerCase();
    const results = [];
    let totalFiles = 0;
    if (needle) {
      const paths = [...this.entries.keys()].sort((a, b) => a.localeCompare(b));
      for (const treePath of paths) {
        const entry = this.entries.get(treePath);
        const hits = [];
        let total = 0;
        for (const part of entry.parts) {
          for (let at = part.lower.indexOf(needle); at !== -1; at = part.lower.indexOf(needle, at + needle.length)) {
            total += 1;
            if (hits.length < MAX_HITS_PER_FILE) hits.push(hitAt(part, at, needle.length));
          }
        }
        if (!total) continue;
        totalFiles += 1;
        if (results.length < MAX_FILES) results.push({ path: treePath, total, hits });
      }
    }
    return { query: needle, results, totalFiles, truncated: totalFiles > results.length, status: this.status() };
  }
}

export { ContentIndex, hitAt };
