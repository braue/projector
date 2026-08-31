// The todo list — the one piece of state that is not project data. A single
// machine-global list, so it lives at the top of the data directory rather
// than inside any project.
//
// It is here, and not in the browser's localStorage, for a specific reason:
// the packaged app listens on port 0, so its window origin
// (http://127.0.0.1:<port>) is a different one on every launch, and anything
// Chromium keys by origin — localStorage included — is effectively wiped each
// time the app starts. The data directory is the only store that survives
// both a relaunch and an upgrade.
//
// Stored whole in <dataDir>/todos.json: [{ id, text, done }]. The list is
// ordered, and that order is the user's (they drag to reorder), so it is
// saved and returned exactly as given.

import { readFile, writeFile } from 'node:fs/promises';

import { httpError } from '../lib/http.js';

class TodosService {
  // Same discipline as NotesService: every write is a whole-file replace, so
  // two in flight would silently drop one side.
  #queue = Promise.resolve();

  constructor({ file }) {
    this.file = file;
  }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
    } catch (err) {
      // Only a missing file means "no todos yet" — a locked or corrupt one
      // must fail the request, or the next save would overwrite the lot.
      if (err?.code === 'ENOENT') return [];
      throw httpError(500, `could not read the todo list: ${err?.message ?? err}`);
    }
  }

  async list() {
    return this.#load();
  }

  /** Whole-list replace: every edit (add, tick, reorder, clear) is a change
   *  to the order or the membership, so the list is the unit. */
  async replace(todos) {
    if (!Array.isArray(todos)) throw httpError(400, 'todos must be an array');
    const cleaned = todos.map(clean).filter(Boolean);
    const run = this.#queue.then(async () => {
      // The directory is ProjectsService.init()'s to make, and it is awaited
      // in startServer() long before a request can land here.
      await writeFile(this.file, JSON.stringify(cleaned, null, 2));
      return cleaned;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Keep only well-formed rows, and only the three fields we store — the file
 *  is hand-editable, and the client is not a reason to trust its shape. */
function clean(todo) {
  if (!todo || typeof todo.id !== 'string' || typeof todo.text !== 'string') return null;
  const text = todo.text.trim();
  return text ? { id: todo.id, text, done: !!todo.done } : null;
}

export { TodosService };
