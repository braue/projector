// RDB source service — uploaded QuickSet relay databases.
//
// Lifecycle lives in lib/uploadService.js; this service owns the RDB-shaped
// parts: which profiles a file carries (its relays), the inspect sections,
// and the generated panel drawings. A profile is addressed
// "<fileId>::<profileName>" (see lib/refs.js).

import path from 'node:path';

import { createImages } from '../lib/drawings/createImages.js';
import { httpError } from '../lib/http.js';
import { sectionItem, sectionNode } from '../lib/inspect.js';
import { parseRdb, relayType } from '../lib/parsers/rdb/index.js';
import { REF_SEPARATOR, splitRef as splitSourceRef } from '../lib/refs.js';
import { UploadService } from '../lib/uploadService.js';

const DRAWING_LABEL = { front: 'Front view', rear: 'Rear view' };
const DRAWING_PREFIX = 'drawing:';

const splitRef = (ref) => splitSourceRef(ref, 'rdb');

// Bumped when the parsed model's shape changes; stale uploads (including
// pre-versioning ones) re-parse from their original bytes in the background.
const MODEL_VERSION = 1;

class RdbService extends UploadService {
  constructor({ dataDir, selDevicesDir, apiBase = '/api' }) {
    super({
      dataDir,
      label: 'rdb',
      extension: /\.rdb$/i,
      originalName: 'original.rdb',
      modelVersion: MODEL_VERSION,
      uploadErrorLabel: 'not a readable .rdb (OLE compound) file',
    });
    // Passed through to the drawing generator; undefined = its bundled default.
    this.selDevicesDir = selDevicesDir;
    // Prefix for the drawing-image URLs baked into item payloads — projects
    // scope the route, so the service must know where it is mounted.
    this.apiBase = apiBase;
  }

  parse(buffer) {
    return parseRdb(buffer);
  }

  validate(model) {
    if (!model.profiles.length) {
      throw httpError(
        400,
        'no relay profiles found under Root Entry/Relays/ — is this a QuickSet database?',
      );
    }
  }

  profilesOf(model) {
    return model.profiles.map((profile) => ({
      name: profile.name,
      deviceType: relayType(profile),
    }));
  }

  findProfile(model, name) {
    return model.profiles.find((profile) => profile.name === name) ?? null;
  }

  async init() {
    await super.init();
    // Uploads from before drawings existed (or whose drawings failed because a
    // PDF was missing at the time) retry after any model migration — dropping
    // a drawing PDF into resources/selDevices/<model>/ heals on next start.
    this.migrated = this.migrated.then(() => this.#backfillDrawings());
  }

  async afterUpload(id, stored) {
    stored.drawings = await this.#generateDrawings(id, stored.model.profiles);
    await this.store.saveParsed(id, stored);
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
        || stored.model.profiles.some((profile) => !stored.drawings[profile.name]?.length);
      if (!missing) continue;
      try {
        stored.drawings = await this.#generateDrawings(fileId, stored.model.profiles);
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

  // --- inspect mapping --------------------------------------------------------
  // The Inspect UI speaks the RTAC tree/item shapes; an RDB profile maps onto
  // them naturally: one item per settings section, the section's key/value
  // table as the item's settings. RTAC-only fields (connection summary,
  // schema, pages) are simply absent — the shapes mark them optional.

  tree(ref) {
    const { fileId, profileName } = splitRef(ref);
    const { profile } = this.profile(ref);
    const views = this.#views(fileId, profileName);

    // Generated panel drawings lead the tree in their own section; the
    // settings sections follow.
    const drawingNodes = views.map((view) => sectionNode({
      name: DRAWING_LABEL[view] ?? view,
      path: `${DRAWING_PREFIX}${view}`,
      kindLabel: 'Panel drawing',
      category: 'hardware',
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
        ...profile.sections.map((section) => sectionNode({
          name: section.desc,
          path: section.key,
          kindLabel: section.key === section.desc ? 'Settings section' : section.key,
          category: 'system',
          pointCount: Object.keys(section.settings).length,
        })),
      ],
    };
  }

  item(ref, sectionKey) {
    const { profile } = this.profile(ref);

    if (sectionKey.startsWith(DRAWING_PREFIX)) {
      const view = sectionKey.slice(DRAWING_PREFIX.length);
      // Validates the view exists (404s otherwise); the URL serves the PNG.
      this.drawingPath(ref, view);
      return sectionItem('Drawing', {
        id: sectionKey,
        file: `${view}.png`,
        category: 'hardware',
        kindLabel: 'Panel drawing',
        name: DRAWING_LABEL[view] ?? view,
        image: {
          url: `${this.apiBase}/rdb/drawing?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}`,
          view,
        },
      });
    }

    const section = profile.sections.find((candidate) => candidate.key === sectionKey);
    if (!section) {
      throw httpError(404, `no such section in ${ref}: ${sectionKey}`);
    }
    return sectionItem('Section', {
      id: section.key,
      file: section.file,
      category: 'system',
      kindLabel: section.key,
      name: section.desc,
      settings: section.settings,
    });
  }
}

export { RdbService };
