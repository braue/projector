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
//                tree()/item(), signature-cached per immutable model — for
//                one profile, or for a whole file with every profile's items
//                namespaced (see comparable() for which ref means which)
//
// Subclass contract:
//   parse(buffer) -> model            (throw on unreadable input)
//   validate(model)                   optional; throw httpError(400)
//   profilesOf(model, fileId) -> [{ name, deviceType }]
//   findProfile(model, name, fileId) -> the profile object, or null
//   tree(ref) / item(ref, key)        the inspect sections

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { modelSignature } from './compare.js';
import { httpError } from './http.js';
import { REF_SEPARATOR, splitRef } from './refs.js';
import { UploadStore } from './uploadStore.js';

class UploadService {
  // Compare entries per profile / per store record — both are immutable for
  // the life of an upload (a re-parse mints new ones).
  #comparableCache = new WeakMap();
  #fileCache = new WeakMap();

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

  // Rename an upload: display name and id together (the id is minted from
  // the name, and it shows wherever refs do). The id is inside every ref, so
  // the project bundle wires `onRenamed` to rewrite canvas placements.
  async rename(fileId, nextName) {
    const trimmed = nextName?.trim();
    if (!trimmed) throw httpError(400, 'name required');
    const stored = this.store.get(fileId);
    if (!stored) throw httpError(404, `unknown ${this.label} file: ${fileId}`);
    const id = await this.store.rename(fileId, trimmed);
    stored.fileName = trimmed;
    await this.store.saveParsed(id, stored);
    // The rename is committed above — a failed ref rewrite must not report
    // failure; a canvas too broken to rewrite surfaces on its next read.
    try {
      await this.onRenamed?.(fileId, id);
    } catch (err) {
      console.warn(`canvas refs not rewritten for ${this.label} rename ${fileId} -> ${id}: ${err?.message ?? err}`);
    }
    return { previousId: fileId, ...this.summary(id, stored) };
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

  // Compare adapter entries at either granularity, chosen by the ref:
  //
  //   "<fileId>::<profile>"  ONE profile's items — two revisions of the same
  //                          relay, or one relay against another
  //   "<fileId>"             the WHOLE file, every profile's items namespaced
  //                          "<profile>/<path>" so the compare tree folds one
  //                          folder per profile and same-named profiles pair
  //                          across the two files
  //
  // SCD picks the whole file (an .scd's IEDs are one substation, and reading
  // them apart loses the point); RDB and SW pick a profile. Search shares
  // this adapter and always addresses a profile.
  comparable(ref) {
    if (!ref?.includes(REF_SEPARATOR)) return this.#wholeFile(ref);
    const { fileName, profile } = this.profile(ref);
    const { profileName } = splitRef(ref, this.label);
    if (!this.#comparableCache.has(profile)) {
      this.#comparableCache.set(profile, this.#entries(ref));
    }
    return { label: `${fileName} · ${profileName}`, entries: this.#comparableCache.get(profile) };
  }

  #wholeFile(fileId) {
    const stored = this.store.get(fileId);
    if (!stored) throw httpError(404, `unknown ${this.label} file: ${fileId}`);
    // Keyed on the STORE RECORD, not the model: a single-profile type (SW)
    // hands back the model itself as its profile, and the two granularities
    // must never share a cache slot.
    if (!this.#fileCache.has(stored)) {
      this.#fileCache.set(stored, this.profilesOf(stored.model, fileId).flatMap((profile) =>
        this.#entries(`${fileId}${REF_SEPARATOR}${profile.name}`, `${profile.name}/`)));
    }
    return { label: stored.fileName, entries: this.#fileCache.get(stored) };
  }

  // One profile's top-level inspect items, signature = canonical (key-sorted)
  // JSON of the WHOLE item — SCD/SW items carry compare-relevant data in
  // pages rows (Report IDs, option fields, port tables) that the settings
  // summaries deliberately abbreviate. Folder children (e.g. RDB panel
  // drawings) are presentation, not compared.
  #entries(ref, prefix = '') {
    return this.tree(ref).tree
      .filter((node) => node.type === 'item')
      .map((node) => {
        const item = this.item(ref, node.path);
        // Lazy: search shares these entries and never reads signatures.
        let signature;
        return {
          path: `${prefix}${node.path}`,
          name: node.name,
          item,
          get signature() {
            return (signature ??= modelSignature(item));
          },
        };
      });
  }
}

export { UploadService };
