// RDB artifact kind — QuickSet relay databases (.rdb) in the project tree.
//
// Model lifecycle lives in lib/artifacts.js; this kind owns the RDB-shaped
// parts: which profiles a file carries (its relays), the inspect sections,
// and the generated panel drawings. A profile is addressed
// "<path>::<profileName>".

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { ArtifactKind, splitArtifactRef } from '../lib/artifacts.js';
import { createImages } from '../lib/drawings/createImages.js';
import { httpError } from '../lib/http.js';
import { sectionItem, sectionNode } from '../lib/inspect.js';
import { parseRdb, relayType } from '../lib/parsers/rdb/index.js';

const DRAWING_LABEL = { front: 'Front view', rear: 'Rear view' };
const DRAWING_PREFIX = 'drawing:';

class RdbKind extends ArtifactKind {
  constructor({ artifacts, projectDir, selDevicesDir, apiBase = '/api' }) {
    super({ artifacts, label: 'rdb' });
    this.uploadErrorLabel = 'not a readable .rdb (OLE compound) file';
    // Generated drawings, keyed by the source file's content hash — a new
    // version renders fresh, an old version keeps its own.
    this.drawingsDir = path.join(projectDir, 'drawings');
    // Passed through to the drawing generator; undefined = its bundled default.
    this.selDevicesDir = selDevicesDir;
    // Prefix for the drawing-image URLs baked into item payloads — projects
    // scope the route, so the kind must know where it is mounted.
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

  // --- panel drawings ---------------------------------------------------------
  // Rendered lazily on the first inspect of a file and memoized on its cache
  // entry: a profile whose model has no metadata (or whose drawing PDF is
  // absent) simply gets no Drawings section.

  async #views(treePath) {
    const entry = await this.artifacts.entry(treePath);
    entry.drawings ??= this.#generate(entry);
    return entry.drawings;
  }

  async #generate(entry) {
    const drawings = {};
    for (const profile of entry.model.profiles) {
      const outputDir = path.join(this.drawingsDir, entry.hash, profile.name);
      drawings[profile.name] = await this.#profileViews(profile, outputDir);
    }
    return drawings;
  }

  async #profileViews(profile, outputDir) {
    // The output dir is content-hash-keyed, so PNGs rendered by an earlier
    // inspect (before a cache eviction or an app restart) are valid as-is —
    // re-rendering is seconds of main-process CPU per profile.
    const onDisk = (await readdir(outputDir).catch(() => []))
      .filter((name) => name.endsWith('.png'))
      .map((name) => name.slice(0, -'.png'.length));
    if (onDisk.length) return ['front', 'rear'].filter((view) => onDisk.includes(view));
    try {
      return await createImages(
        relayType(profile),
        profile.info?.PARTNO,
        outputDir,
        { devicesDir: this.selDevicesDir },
      );
    } catch (err) {
      console.warn(`no panel drawings for ${profile.name}: ${err?.message ?? err}`);
      return [];
    }
  }

  // Absolute path of one generated drawing PNG, for the image route.
  async drawingPath(ref, view) {
    const { path: treePath, profileName } = splitArtifactRef(ref);
    await this.profile(ref);
    const entry = await this.artifacts.entry(treePath);
    const views = (await this.#views(treePath))[profileName] ?? [];
    if (!views.includes(view)) {
      throw httpError(404, `no ${view} drawing for ${ref}`);
    }
    return path.join(this.drawingsDir, entry.hash, profileName, `${view}.png`);
  }

  // --- inspect mapping --------------------------------------------------------
  // The Inspect UI speaks the RTAC tree/item shapes; an RDB profile maps onto
  // them naturally: one item per settings section, the section's key/value
  // table as the item's settings.

  async tree(ref) {
    const { path: treePath, profileName } = splitArtifactRef(ref);
    const { profile } = await this.profile(ref);
    const views = (await this.#views(treePath))[profileName] ?? [];

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

  async item(ref, sectionKey) {
    const { profile } = await this.profile(ref);

    if (sectionKey.startsWith(DRAWING_PREFIX)) {
      const view = sectionKey.slice(DRAWING_PREFIX.length);
      // Validates the view exists (404s otherwise); the URL serves the PNG.
      await this.drawingPath(ref, view);
      return sectionItem('Drawing', {
        id: sectionKey,
        file: `${view}.png`,
        category: 'hardware',
        kindLabel: 'Panel drawing',
        name: DRAWING_LABEL[view] ?? view,
        image: {
          url: `${this.apiBase}/artifacts/drawing?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}`,
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

export { RdbKind };
