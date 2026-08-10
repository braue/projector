// Shared HTTP plumbing. Routes are plain async handlers — Express 5 forwards
// a rejected promise to the error middleware in index.js, the one place a
// coded error ({ status }) becomes a JSON response.

import path from 'node:path';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// A query parameter that must arrive as a non-empty string.
function requireQuery(req, name) {
  const value = req.query[name];
  if (typeof value !== 'string' || !value) {
    throw httpError(400, `${name} query parameter required`);
  }
  return value;
}

// A user-supplied name becomes one path segment under `baseDir` — refuse
// anything that would resolve outside it.
function resolveChild(baseDir, name, message) {
  const resolved = path.resolve(baseDir, name);
  if (path.dirname(resolved) !== path.resolve(baseDir)) {
    throw httpError(400, message);
  }
  return resolved;
}

// A user-supplied RELATIVE path (any depth, '' = the base itself) resolved
// under `baseDir` — refuse anything that escapes it.
function resolveWithin(baseDir, relPath, message) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relPath ?? '');
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw httpError(400, message);
  }
  return resolved;
}

export { httpError, requireQuery, resolveChild, resolveWithin };
