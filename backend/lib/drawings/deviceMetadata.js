// Per-model SEL drawing metadata, ported from Volture. Each directory under
// resources/selDevices/<model>/ holds a metadata.json describing which master
// configuration PDF draws that model, which PDF layers each part-number option
// enables, and where the front/rear views sit on the page. The PDFs themselves
// are SEL's copyrighted works and are NOT distributed with this repo — drop
// them beside their metadata.json (the file names the metadata expects) and
// drawings start generating.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SEL_DEVICES_DIR = path.resolve(HERE, '../../resources/selDevices');

function normalizeDeviceName(model) {
  return String(model ?? '').trim().replace(/^SEL-/i, '').toUpperCase();
}

// Directory listing and parsed metadata are cached per devices dir for the
// process lifetime — an RDB with many profiles of one model reads each
// metadata file at most once.
const dirListingCache = new Map();
function deviceDirs(devicesDir) {
  if (!dirListingCache.has(devicesDir)) {
    dirListingCache.set(devicesDir, fs.readdir(devicesDir, { withFileTypes: true })
      .then((entries) => entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => b.length - a.length))
      .catch(() => []));
  }
  return dirListingCache.get(devicesDir);
}

const metadataCache = new Map();

// Resolve a model name to its selDevices directory (strip `SEL-`, exact match,
// else longest directory name that is a prefix before a `-`) and return the
// parsed metadata.json, or null when the model is unknown.
async function loadDeviceMetadata(model, devicesDir = SEL_DEVICES_DIR) {
  const normalized = normalizeDeviceName(model);
  if (!normalized) return null;

  const dirs = await deviceDirs(devicesDir);
  const deviceDir = dirs.find((name) => name.toUpperCase() === normalized)
    ?? dirs.find((name) => normalized.startsWith(`${name.toUpperCase()}-`));
  if (!deviceDir) return null;

  const cacheKey = path.join(devicesDir, deviceDir);
  if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);

  let metadata = null;
  try {
    metadata = JSON.parse(await fs.readFile(path.join(cacheKey, 'metadata.json'), 'utf8'));
  } catch {
    metadata = null;
  }
  metadataCache.set(cacheKey, metadata);
  return metadata;
}

export { SEL_DEVICES_DIR, loadDeviceMetadata };
