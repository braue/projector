// Zip archives: what is in them, and the bytes of one entry. An archive is
// read one entry at a time — a 2 GB export zip must not be inflated whole to
// find the one PDF inside it.

import { unzipSync } from 'fflate';

function asBytes(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Every entry: { name, size (uncompressed), compressed, dir }. */
function zipEntries(bytes) {
  const entries = [];
  unzipSync(asBytes(bytes), {
    filter(file) {
      entries.push({
        name: file.name,
        size: file.originalSize,
        compressed: file.size,
        dir: file.name.endsWith('/'),
      });
      return false;
    },
  });
  return entries;
}

/** One entry's bytes, or null when it is not there (or is encrypted, or
 *  uses a compression method the reader does not have). */
function zipEntry(bytes, name) {
  try {
    const out = unzipSync(asBytes(bytes), { filter: (file) => file.name === name });
    return out[name] ?? null;
  } catch {
    return null;
  }
}

export { zipEntries, zipEntry };
