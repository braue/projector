// One JSON document on disk — the machine-global stores (todos, hours, tool
// settings, the VLAN bench table) are each exactly this, so the two rules
// they all need live here once:
//
// - Only a MISSING file reads as empty. A locked or corrupt one fails the
//   request, or the next write would overwrite the lot.
// - Writes are serialized read-modify-write: two saves in flight must both
//   land, never one silently dropping the other.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from './http.js';

class JsonFile {
  #queue = Promise.resolve();

  /**
   * @param {string} file
   * @param {{ label: string, empty: () => any, clean?: (raw: any) => any }} opts
   *   label names the store in errors ("the todo list"); empty() is a fresh
   *   empty document; clean() reshapes whatever was parsed (the files are
   *   hand-editable) and defaults to identity.
   */
  constructor(file, { label, empty, clean = (raw) => raw }) {
    this.file = file;
    this.label = label;
    this.empty = empty;
    this.clean = clean;
  }

  async read() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return this.empty();
      throw httpError(500, `could not read ${this.label}: ${err?.message ?? err}`);
    }
    try {
      return this.clean(JSON.parse(text));
    } catch (err) {
      throw httpError(500, `could not read ${this.label}: ${err?.message ?? err}`);
    }
  }

  /** `change(doc)` returns the next document, or undefined for "unchanged"
   *  (nothing is written). Resolves to the document as stored. */
  update(change) {
    const run = this.#queue.then(async () => {
      const current = await this.read();
      const next = await change(current);
      if (next === undefined) return { doc: current, changed: false };
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(next, null, 2));
      return { doc: next, changed: true };
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Whole-document replace. */
  async write(doc) {
    return (await this.update(() => doc)).doc;
  }
}

export { JsonFile };
