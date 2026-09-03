// Artifact refs: a profile inside an artifact is addressed as
// "<treePath>::<profileName>" everywhere (sidebar, inspect, compare). ':'
// cannot appear in a file name (services/files.js strips it), so the
// separator never collides with the path half. lib/artifacts.js owns the
// splitting.

const REF_SEPARATOR = '::';

export { REF_SEPARATOR };
