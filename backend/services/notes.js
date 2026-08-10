// Notes — the engineer's own working notes beside the evidence, one set per
// project. Nothing here reads settings artifacts.
//
// Stored whole in <project>/notes.json: [{ id, name, text }]. The body is
// ONE free-form text blob — exactly what the editor shows. List markers
// ("[ ]", "[x]", "-", "1.") are plain-text conventions the frontend assists
// with, not structure the backend understands.

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { httpError } from '../lib/http.js';

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
      const note = { id: randomUUID(), name: trimmed, text: '' };
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

  setText(id, text) {
    return this.#serialized(async () => {
      if (typeof text !== 'string') throw httpError(400, 'text must be a string');
      const notes = await this.#load();
      const note = this.#find(notes, id);
      note.text = text;
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
