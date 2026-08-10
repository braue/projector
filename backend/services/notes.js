// Notes — the engineer's own working notes beside the evidence, one set per
// project. Nothing here reads settings artifacts.
//
// Stored whole in <project>/notes.json:
//   [{ id, name, items: [{ id, text, kind, checked, level }] }]
// A line's `kind` is 'text' (plain), 'check' (checkbox), 'bullet', or
// 'number'; `checked` only means anything on check lines. `level` is 0 or 1 —
// sub-lines render tabbed in. The editor replaces a note's items wholesale
// (they are tiny), so there is no per-item API.

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { httpError } from '../lib/http.js';

const KINDS = new Set(['text', 'check', 'bullet', 'number']);

// Whatever the client sent, reduced to the stored item shape.
function sanitizeItems(items) {
  if (!Array.isArray(items)) throw httpError(400, 'items must be an array');
  return items.map((item) => ({
    id: typeof item?.id === 'string' && item.id ? item.id : randomUUID(),
    text: String(item?.text ?? ''),
    kind: KINDS.has(item?.kind) ? item.kind : 'text',
    checked: Boolean(item?.checked),
    level: item?.level === 1 ? 1 : 0,
  }));
}

class NotesService {
  // Mutations serialize through one chain: every mutator is a whole-file
  // read-modify-write, and two in flight would silently drop one side.
  #queue = Promise.resolve();

  constructor({ file }) {
    this.file = file;
  }

  #serialized(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #load() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      // Only a missing file means "no notes yet". A locked or corrupt file
      // must fail the request — returning [] here would let the next save
      // overwrite every stored note.
      if (err?.code === 'ENOENT') return [];
      throw httpError(500, `could not read notes: ${err?.message ?? err}`);
    }
  }

  async #save(notes) {
    await writeFile(this.file, JSON.stringify(notes, null, 2));
  }

  #find(notes, id) {
    const note = notes.find((candidate) => candidate.id === id);
    if (!note) throw httpError(404, `unknown note: ${id}`);
    return note;
  }

  async list() {
    return this.#load();
  }

  create(name) {
    const trimmed = name?.trim();
    if (!trimmed) throw httpError(400, 'note name required');
    return this.#serialized(async () => {
      const notes = await this.#load();
      const note = { id: randomUUID(), name: trimmed, items: [] };
      notes.push(note);
      await this.#save(notes);
      return note;
    });
  }

  rename(id, name) {
    const trimmed = name?.trim();
    if (!trimmed) throw httpError(400, 'note name required');
    return this.#serialized(async () => {
      const notes = await this.#load();
      const note = this.#find(notes, id);
      note.name = trimmed;
      await this.#save(notes);
      return note;
    });
  }

  setItems(id, items) {
    const sanitized = sanitizeItems(items);
    return this.#serialized(async () => {
      const notes = await this.#load();
      const note = this.#find(notes, id);
      note.items = sanitized;
      await this.#save(notes);
      return note;
    });
  }

  remove(id) {
    return this.#serialized(async () => {
      const notes = await this.#load();
      this.#find(notes, id);
      await this.#save(notes.filter((note) => note.id !== id));
    });
  }
}

export { NotesService };
