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

export { uniqueName, shedArchiveStamp };
