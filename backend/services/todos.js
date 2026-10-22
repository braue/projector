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

import { JsonFile } from '../lib/jsonFile.js';
import { httpError } from '../lib/http.js';

class TodosService {
  constructor({ file }) {
    this.store = new JsonFile(file, {
      label: 'the todo list',
      empty: () => [],
      clean: (raw) => (Array.isArray(raw) ? raw.map(clean).filter(Boolean) : []),
    });
  }

  list() {
    return this.store.read();
  }

  /** Whole-list replace: every edit (add, tick, reorder, clear) is a change
   *  to the order or the membership, so the list is the unit. */
  async replace(todos) {
    if (!Array.isArray(todos)) throw httpError(400, 'todos must be an array');
    return this.store.write(todos.map(clean).filter(Boolean));
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
