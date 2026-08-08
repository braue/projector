// RDB source service — uploaded QuickSet relay databases.
//
// Each upload lands under DATA_DIR/rdb/<id>/ as the original bytes plus the
// parsed model; restarts re-read parsed.json, so uploads survive like RTAC
// exports do. A profile is addressed as "<fileId>::<profileName>" everywhere
// (sidebar, canvas placements, inspect) — the file id is the sanitized upload
// name, unique-ified, so refs stay human-readable in workspace JSON.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseRdb } from '../lib/parsers/rdb/index.js';

const REF_SEPARATOR = '::';

function splitRef(ref) {
  const at = (ref ?? '').indexOf(REF_SEPARATOR);
  if (at < 1) {
    throw Object.assign(new Error(`invalid rdb ref: ${ref}`), { status: 400 });
  }
  return { fileId: ref.slice(0, at), profileName: ref.slice(at + REF_SEPARATOR.length) };
}

class RdbService {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'rdb');
    // fileId -> { fileName, profiles: [profile] }
    this.files = new Map();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const stored = JSON.parse(
          await readFile(path.join(this.dir, entry.name, 'parsed.json'), 'utf8'),
        );
        this.files.set(entry.name, stored);
      } catch (err) {
        console.warn(`skipping unreadable rdb upload ${entry.name}: ${err?.message ?? err}`);
      }
    }
  }

  #dir(fileId) {
    const dir = path.resolve(this.dir, fileId);
    if (path.dirname(dir) !== path.resolve(this.dir)) {
      throw Object.assign(new Error(`invalid rdb id: ${fileId}`), { status: 400 });
    }
    return dir;
  }

  #uniqueId(fileName) {
    const base = fileName.replace(/\.rdb$/i, '').replace(/[^\w.-]+/g, '_') || 'upload';
    let candidate = base;
    let suffix = 2;
    while (this.files.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async upload(fileName, buffer) {
    let parsed;
    try {
      parsed = parseRdb(buffer);
    } catch (err) {
      throw Object.assign(
        new Error(`not a readable .rdb (OLE compound) file: ${err?.message ?? err}`),
        { status: 400 },
      );
    }
    if (!parsed.profiles.length) {
      throw Object.assign(
        new Error('no relay profiles found under Root Entry/Relays/ — is this a QuickSet database?'),
        { status: 400 },
      );
    }

    const id = this.#uniqueId(fileName);
    const dir = this.#dir(id);
    const stored = { fileName, profiles: parsed.profiles };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'original.rdb'), buffer);
    await writeFile(path.join(dir, 'parsed.json'), JSON.stringify(stored));
    this.files.set(id, stored);
    return this.#summary(id, stored);
  }

  async remove(fileId) {
    if (!this.files.has(fileId)) {
      throw Object.assign(new Error(`unknown rdb file: ${fileId}`), { status: 404 });
    }
    await rm(this.#dir(fileId), { recursive: true, force: true });
    this.files.delete(fileId);
  }

  #summary(id, stored) {
    return {
      id,
      fileName: stored.fileName,
      profiles: stored.profiles.map((profile) => ({
        name: profile.name,
        ref: `${id}${REF_SEPARATOR}${profile.name}`,
        relayType: profile.info?.RELAYTYPE ?? profile.info?.DEVICETYPE ?? null,
      })),
    };
  }

  list() {
    return [...this.files.entries()].map(([id, stored]) => this.#summary(id, stored));
  }

  profile(ref) {
    const { fileId, profileName } = splitRef(ref);
    const stored = this.files.get(fileId);
    const profile = stored?.profiles.find((candidate) => candidate.name === profileName);
    if (!profile) {
      throw Object.assign(new Error(`unknown rdb profile: ${ref}`), { status: 404 });
    }
    return profile;
  }

  // --- inspect mapping --------------------------------------------------------
  // The Inspect UI speaks the RTAC tree/item shapes; an RDB profile maps onto
  // them naturally: one item per settings section, the section's key/value
  // table as the item's settings.

  tree(ref) {
    const profile = this.profile(ref);
    return {
      name: profile.name,
      schema: null,
      deviceMOT: profile.info?.RELAYTYPE ?? null,
      summary: {
        files: profile.sections.length,
        connections: 0, clients: 0, servers: 0, peers: 0, totalPoints: 0, protocols: [],
      },
      errors: [],
      tree: profile.sections.map((section) => ({
        type: 'item',
        name: section.desc,
        path: section.key,
        kind: 'Section',
        kindLabel: section.key === section.desc ? 'Settings section' : section.key,
        category: 'system',
        protocol: null,
        connectionType: null,
        pointCount: Object.keys(section.settings).length,
      })),
    };
  }

  item(ref, sectionKey) {
    const profile = this.profile(ref);
    const section = profile.sections.find((candidate) => candidate.key === sectionKey);
    if (!section) {
      throw Object.assign(new Error(`no such section in ${ref}: ${sectionKey}`), { status: 404 });
    }
    return {
      id: section.key,
      file: section.file,
      kind: 'Section',
      category: 'system',
      kindLabel: section.key,
      name: section.desc,
      schema: null,
      deviceMOT: profile.info?.RELAYTYPE ?? null,
      settings: section.settings,
      points: [],
      pointCount: 0,
      pages: [],
      hasControllerPou: false,
    };
  }
}

export { REF_SEPARATOR, RdbService };
