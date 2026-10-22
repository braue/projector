// Naming rules shared by the files store and the artifacts over it.

import { httpError } from './http.js';

// First of base, base-2, base-3, ... that isUsed accepts as free.
function uniqueName(base, isUsed) {
  let candidate = base;
  let suffix = 2;
  while (isUsed(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** An archived version's stored name (`<stamp>-<name>`, written by
 *  files.#archive) with the stamp shed — THE decoder for that format, so
 *  the shape lives in one place. */
function shedArchiveStamp(storedName) {
  return storedName.replace(/^\d{10,}-/, '');
}

/** `name` inside the tree folder `dirPath` ('' = the root). */
function joinTree(dirPath, name) {
  return dirPath ? `${dirPath}/${name}` : name;
}

/** Every arrival carries a version note — the one-line account of what it
 *  changed (see services/files.js). */
function requireNote(note) {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (!trimmed) throw httpError(400, 'a version note is required');
  return trimmed;
}

export { joinTree, requireNote, shedArchiveStamp, uniqueName };
