// RDB source service — uploaded QuickSet relay databases.
//
// Each upload lands under DATA_DIR/rdb/<id>/ as the original bytes plus the
// parsed model; restarts re-read parsed.json, so uploads survive like RTAC
// exports do. A profile is addressed as "<fileId>::<profileName>" everywhere
// (sidebar, canvas placements, inspect) — the file id is the sanitized upload
// name, unique-ified, so refs stay human-readable in workspace JSON.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createImages } from '../lib/drawings/createImages.js';
import { httpError, resolveChild } from '../lib/http.js';
import { parseRdb, relayType, uniqueName } from '../lib/parsers/rdb/index.js';

const REF_SEPARATOR = '::';

const DRAWING_LABEL = { front: 'Front view', rear: 'Rear view' };
const DRAWING_PREFIX = 'drawing:';

function splitRef(ref) {
  const at = (ref ?? '').indexOf(REF_SEPARATOR);
  if (at < 1) throw httpError(400, `invalid rdb ref: ${ref}`);
  return { fileId: ref.slice(0, at), profileName: ref.slice(at + REF_SEPARATOR.length) };
}

class RdbService {
  constructor({ dataDir, selDevicesDir }) {
    this.dir = path.join(dataDir, 'rdb');
    // Passed through to the drawing generator; undefined = its bundled default.
    this.selDevicesDir = selDevicesDir;
    // fileId -> { fileName, profiles: [profile], drawings: { profileName: [view] } }
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
    // Uploads from before drawings existed (or whose drawings failed because a
    // PDF was missing at the time) retry in the background — dropping a
    // drawing PDF into resources/selDevices/<model>/ heals on next start.
    this.#backfillDrawings();
  }

  // --- panel drawings ---------------------------------------------------------
  // Best-effort at upload: a profile whose model has no metadata (or whose
  // drawing PDF is absent) simply gets no Drawings section.

  async #generateDrawings(fileId, profiles) {
    const drawings = {};
    for (const profile of profiles) {
      const outputDir = path.join(this.#dir(fileId), 'drawings', profile.name);
      try {
        drawings[profile.name] = await createImages(
          relayType(profile),
          profile.info?.PARTNO,
          outputDir,
          { devicesDir: this.selDevicesDir },
        );
      } catch (err) {
        console.warn(`no panel drawings for ${fileId}${REF_SEPARATOR}${profile.name}: ${err?.message ?? err}`);
        drawings[profile.name] = [];
      }
    }
    return drawings;
  }

  async #backfillDrawings() {
    for (const [fileId, stored] of this.files) {
      const missing = !stored.drawings
        || stored.profiles.some((profile) => !stored.drawings[profile.name]?.length);
      if (!missing) continue;
      try {
        stored.drawings = await this.#generateDrawings(fileId, stored.profiles);
        await writeFile(path.join(this.#dir(fileId), 'parsed.json'), JSON.stringify(stored));
      } catch (err) {
        console.warn(`drawing backfill failed for ${fileId}: ${err?.message ?? err}`);
      }
    }
  }

  #views(fileId, profileName) {
    return this.files.get(fileId)?.drawings?.[profileName] ?? [];
  }

  // Absolute path of one generated drawing PNG, for the image route.
  drawingPath(ref, view) {
    const { fileId, profileName } = splitRef(ref);
    this.profile(ref);
    if (!this.#views(fileId, profileName).includes(view)) {
      throw httpError(404, `no ${view} drawing for ${ref}`);
    }
    return path.join(this.#dir(fileId), 'drawings', profileName, `${view}.png`);
  }

  #dir(fileId) {
    return resolveChild(this.dir, fileId, `invalid rdb id: ${fileId}`);
  }

  #uniqueId(fileName) {
    const base = fileName.replace(/\.rdb$/i, '').replace(/[^\w.-]+/g, '_') || 'upload';
    return uniqueName(base, (candidate) => this.files.has(candidate));
  }

  async upload(fileName, buffer) {
    let parsed;
    try {
      parsed = parseRdb(buffer);
    } catch (err) {
      throw httpError(400, `not a readable .rdb (OLE compound) file: ${err?.message ?? err}`);
    }
    if (!parsed.profiles.length) {
      throw httpError(
        400,
        'no relay profiles found under Root Entry/Relays/ — is this a QuickSet database?',
      );
    }

    const id = this.#uniqueId(fileName);
    const dir = this.#dir(id);
    const stored = { fileName, profiles: parsed.profiles, drawings: {} };
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'original.rdb'), buffer);
    this.files.set(id, stored);
    stored.drawings = await this.#generateDrawings(id, stored.profiles);
    await writeFile(path.join(dir, 'parsed.json'), JSON.stringify(stored));
    return this.#summary(id, stored);
  }

  async remove(fileId) {
    if (!this.files.has(fileId)) {
      throw httpError(404, `unknown rdb file: ${fileId}`);
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
        relayType: relayType(profile),
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
      throw httpError(404, `unknown rdb profile: ${ref}`);
    }
    return profile;
  }

  // --- inspect mapping --------------------------------------------------------
  // The Inspect UI speaks the RTAC tree/item shapes; an RDB profile maps onto
  // them naturally: one item per settings section, the section's key/value
  // table as the item's settings. RTAC-only fields (connection summary,
  // schema, pages) are simply absent — the shapes mark them optional.

  tree(ref) {
    const { fileId, profileName } = splitRef(ref);
    const profile = this.profile(ref);
    const views = this.#views(fileId, profileName);

    // Generated panel drawings lead the tree in their own section; the
    // settings sections follow.
    const drawingNodes = views.map((view) => ({
      type: 'item',
      name: DRAWING_LABEL[view] ?? view,
      path: `${DRAWING_PREFIX}${view}`,
      kind: 'Drawing',
      kindLabel: 'Panel drawing',
      category: 'hardware',
      protocol: null,
      connectionType: null,
    }));

    return {
      name: profile.name,
      schema: null,
      deviceLabel: relayType(profile),
      summary: { files: profile.sections.length },
      errors: [],
      tree: [
        ...(drawingNodes.length
          ? [{ type: 'folder', name: 'Drawings', path: 'drawings', children: drawingNodes }]
          : []),
        ...profile.sections.map((section) => ({
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
      ],
    };
  }

  item(ref, sectionKey) {
    const profile = this.profile(ref);

    if (sectionKey.startsWith(DRAWING_PREFIX)) {
      const view = sectionKey.slice(DRAWING_PREFIX.length);
      // Validates the view exists (404s otherwise); the URL serves the PNG.
      this.drawingPath(ref, view);
      return {
        id: sectionKey,
        file: `${view}.png`,
        kind: 'Drawing',
        category: 'hardware',
        kindLabel: 'Panel drawing',
        name: DRAWING_LABEL[view] ?? view,
        settings: {},
        points: [],
        pointCount: 0,
        pages: [],
        image: {
          url: `/api/rdb/drawing?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}`,
          view,
        },
      };
    }

    const section = profile.sections.find((candidate) => candidate.key === sectionKey);
    if (!section) {
      throw httpError(404, `no such section in ${ref}: ${sectionKey}`);
    }
    return {
      id: section.key,
      file: section.file,
      kind: 'Section',
      category: 'system',
      kindLabel: section.key,
      name: section.desc,
      settings: section.settings,
      points: [],
      pointCount: 0,
      pages: [],
    };
  }
}

export { RdbService };
