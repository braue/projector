// Upload-source refs: a profile inside an uploaded file is addressed as
// "<fileId>::<profileName>" everywhere (sidebar, canvas placements, inspect).
// The file id is the sanitized upload name, unique-ified, so refs stay
// human-readable in workspace JSON. RDB and SCD share the scheme.

import { httpError } from './http.js';

const REF_SEPARATOR = '::';

function splitRef(ref, label) {
  const at = (ref ?? '').indexOf(REF_SEPARATOR);
  if (at < 1) throw httpError(400, `invalid ${label} ref: ${ref}`);
  return { fileId: ref.slice(0, at), profileName: ref.slice(at + REF_SEPARATOR.length) };
}

// Swap the file-id half of a ref, preserving the profile — how stored refs
// follow an upload rename. Refs under other ids come back unchanged.
// (Mirrored in frontend/src/lib/sources.ts.)
function replaceRefFile(ref, fromId, toId) {
  const prefix = `${fromId}${REF_SEPARATOR}`;
  return ref.startsWith(prefix) ? `${toId}${REF_SEPARATOR}${ref.slice(prefix.length)}` : ref;
}

export { REF_SEPARATOR, replaceRefFile, splitRef };
