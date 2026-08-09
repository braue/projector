// RDB source service — uploaded QuickSet relay databases.
//
// Storage rides the shared UploadStore (DATA_DIR/rdb/<id>/, parsed.json
// rehydration, unique ids); this service owns parsing, panel drawings, and
// the inspect/compare shaping. A profile is addressed "<fileId>::<profileName>"
// (see lib/refs.js).

import path from 'node:path';

import { settingsSignature } from '../lib/compare.js';
import { createImages } from '../lib/drawings/createImages.js';
import { httpError } from '../lib/http.js';
import { parseRdb, relayType } from '../lib/parsers/rdb/index.js';
import { REF_SEPARATOR, splitRef as splitSourceRef } from '../lib/refs.js';
import { UploadStore } from '../lib/uploadStore.js';

const DRAWING_LABEL = { front: 'Front view', rear: 'Rear view' };
const DRAWING_PREFIX = 'drawing:';

const splitRef = (ref) => splitSourceRef(ref, 'rdb');

class RdbService {
  // Compare entries per profile object — profiles are immutable per upload,
  // so the cache lives and dies with them.
  #comparableCache = new WeakMap();

  constructor({ dataDir, selDevicesDir }) {
    this.store = new UploadStore({
      dataDir,
      label: 'rdb',
      extension: /\.rdb$/i,
      originalName: 'original.rdb',
    });
    // Passed through to the drawing generator; undefined = its bundled default.
    this.selDevicesDir = selDevicesDir;
  }

  async init() {
    await this.store.init();
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
      const outputDir = path.join(this.store.dir(fileId), 'drawings', profile.name);
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
    for (const [fileId, stored] of this.store.entries()) {
      const missing = !stored.drawings
        || stored.profiles.some((profile) => !stored.drawings[profile.name]?.length);
      if (!missing) continue;
      try {
        stored.drawings = await this.#generateDrawings(fileId, stored.profiles);
        await this.store.saveParsed(fileId, stored);
      } catch (err) {
        console.warn(`drawing backfill failed for ${fileId}: ${err?.message ?? err}`);
      }
    }
  }

  #views(fileId, profileName) {
    return this.store.get(fileId)?.drawings?.[profileName] ?? [];
  }

  // Absolute path of one generated drawing PNG, for the image route.
  drawingPath(ref, view) {
    const { fileId, profileName } = splitRef(ref);
    this.profile(ref);
    if (!this.#views(fileId, profileName).includes(view)) {
      throw httpError(404, `no ${view} drawing for ${ref}`);
    }
    return path.join(this.store.dir(fileId), 'drawings', profileName, `${view}.png`);
  }

  // --- upload / list ----------------------------------------------------------

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

    const stored = { fileName, profiles: parsed.profiles, drawings: {} };
    const id = await this.store.add(fileName, buffer, stored);
    stored.drawings = await this.#generateDrawings(id, stored.profiles);
    await this.store.saveParsed(id, stored);
    return this.#summary(id, stored);
  }

  async remove(fileId) {
    await this.store.remove(fileId);
  }

  #summary(id, stored) {
    return {
      id,
      fileName: stored.fileName,
      profiles: stored.profiles.map((profile) => ({
        name: profile.name,
        ref: `${id}${REF_SEPARATOR}${profile.name}`,
        deviceType: relayType(profile),
      })),
    };
  }

  list() {
    return [...this.store.entries()].map(([id, stored]) => this.#summary(id, stored));
  }

  profile(ref) {
    const { fileId, profileName } = splitRef(ref);
    const stored = this.store.get(fileId);
    const profile = stored?.profiles.find((candidate) => candidate.name === profileName);
    if (!profile) {
      throw httpError(404, `unknown rdb profile: ${ref}`);
    }
    return profile;
  }

  // Compare adapter entries: one per settings section, signature = canonical
  // (key-sorted) JSON of the section's settings. Cached per profile object.
  comparable(ref) {
    const { fileId } = splitRef(ref);
    const profile = this.profile(ref);
    if (!this.#comparableCache.has(profile)) {
      this.#comparableCache.set(profile, profile.sections.map((section) => ({
        path: section.key,
        name: section.desc,
        item: this.item(ref, section.key),
        signature: settingsSignature(section.settings),
      })));
    }
    return {
      label: `${this.store.get(fileId).fileName} · ${profile.name}`,
      entries: this.#comparableCache.get(profile),
    };
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
