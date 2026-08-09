// The lifecycle every upload-backed source service (RDB, SCD, SW) shares —
// the service-layer twin of routes/uploads.js, which owns the HTTP surface.
// A new source type supplies a parser, a profile lister, and its inspect
// sections (tree/item); everything else lives here once:
//
//   init         rehydrate from disk; uploads parsed by an older MODEL
//                VERSION are evicted and re-parsed from their original bytes
//                in the background (parsing is CPU-bound — startup never
//                blocks on it; `migrated` resolves when the sweep is done)
//   upload       parse, validate, persist, summarize
//   list         sidebar summaries, refs minted as "<fileId>::<profileName>"
//   profile      one addressed profile with its context:
//                { fileId, fileName, model, profile }
//   comparable   compare-adapter entries derived from the service's own
//                tree()/item(), signature-cached per immutable model
//
// Subclass contract:
//   parse(buffer) -> model            (throw on unreadable input)
//   validate(model)                   optional; throw httpError(400)
//   profilesOf(model, fileId) -> [{ name, deviceType }]
//   findProfile(model, name, fileId) -> the profile object, or null
//   tree(ref) / item(ref, key)        the inspect sections

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { settingsSignature } from './compare.js';
import { httpError } from './http.js';
import { REF_SEPARATOR, splitRef } from './refs.js';
import { UploadStore } from './uploadStore.js';

class UploadService {
  // Compare entries per model object — models are immutable per upload.
  #comparableCache = new WeakMap();

  constructor({ dataDir, label, extension, originalName, modelVersion, uploadErrorLabel }) {
    this.label = label;
    this.modelVersion = modelVersion;
    this.uploadErrorLabel = uploadErrorLabel;
    this.store = new UploadStore({ dataDir, label, extension, originalName });
  }

  async init() {
    await this.store.init();
    const stale = [...this.store.entries()]
      .filter(([, stored]) => stored.modelVersion !== this.modelVersion);
    for (const [id] of stale) this.store.evict(id);
    this.migrated = (async () => {
      for (const [id, stored] of stale) {
        try {
          const buffer = await readFile(path.join(this.store.dir(id), this.store.originalName));
          await this.store.saveParsed(id, {
            fileName: stored.fileName,
            modelVersion: this.modelVersion,
            model: this.parse(buffer),
          });
        } catch (err) {
          console.warn(`could not re-parse ${this.label} upload ${id}: ${err?.message ?? err}`);
        }
      }
    })();
  }

  async upload(fileName, buffer) {
    let model;
    try {
      model = this.parse(buffer);
    } catch (err) {
      throw httpError(400, `${this.uploadErrorLabel}: ${err?.message ?? err}`);
    }
    this.validate?.(model);
    const stored = { fileName, modelVersion: this.modelVersion, model };
    const id = await this.store.add(fileName, buffer, stored);
    await this.afterUpload?.(id, stored);
    return this.summary(id, stored);
  }

  async remove(fileId) {
    await this.store.remove(fileId);
  }

  summary(id, stored) {
    return {
      id,
      fileName: stored.fileName,
      profiles: this.profilesOf(stored.model, id).map((profile) => ({
        ...profile,
        ref: `${id}${REF_SEPARATOR}${profile.name}`,
      })),
    };
  }

  list() {
    return [...this.store.entries()].map(([id, stored]) => this.summary(id, stored));
  }

  profile(ref) {
    const { fileId, profileName } = splitRef(ref, this.label);
    const stored = this.store.get(fileId);
    const profile = stored ? this.findProfile(stored.model, profileName, fileId) : null;
    if (!profile) {
      throw httpError(404, `unknown ${this.label} profile: ${ref}`);
    }
    return { fileId, fileName: stored.fileName, model: stored.model, profile };
  }

  // Compare adapter entries: the profile's top-level inspect items, signature
  // = canonical (key-sorted) JSON of each item's settings. Folder children
  // (e.g. RDB panel drawings) are presentation, not compared settings.
  comparable(ref) {
    const { fileName, profile } = this.profile(ref);
    const { profileName } = splitRef(ref, this.label);
    if (!this.#comparableCache.has(profile)) {
      this.#comparableCache.set(profile, this.tree(ref).tree
        .filter((node) => node.type === 'item')
        .map((node) => {
          const item = this.item(ref, node.path);
          return {
            path: node.path,
            name: node.name,
            item,
            signature: settingsSignature(item.settings),
          };
        }));
    }
    return { label: `${fileName} · ${profileName}`, entries: this.#comparableCache.get(profile) };
  }
}

export { UploadService };
