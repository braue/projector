// The QuickSet device browser: one standalone HTML page (viewer.html, the
// template beside this file) with the device tree and each device's
// connection, network and collection settings inline. A device's full
// settings sit in viewer_data/<id>.js (written by the model) and load on
// click through a <script> tag, so the page also works opened from disk.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { jsonForScript } from './model.js';

const TEMPLATE = new URL('./viewer.html', import.meta.url);

// The page's field names, where they are not just the snake_case of ours.
const RENAMES = {
  viaParent: 'via_parent_device',
  blueframeResource: 'blueframe_resource_id',
  quicksetIp: 'qs_ip_address',
};
// Setting names (EPORT, IPADDR, …) pass through as they are.
const snake = (key) => RENAMES[key] ?? (/^[a-z]/.test(key) ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : key);

function forPage(row, drop = []) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === '' || value === null || value === undefined || drop.includes(key)) continue;
    out[snake(key)] = key === 'inService' ? (value === 'Yes' ? 't' : value === 'No' ? 'f' : value) : value;
  }
  return out;
}

const grouped = (rows) => {
  const out = {};
  for (const row of rows) (out[row.deviceId] ??= []).push(forPage(row, ['deviceId', 'folder', 'device', 'deviceType']));
  return out;
};

/** Write <dir>/viewer/viewer.html from the model. */
async function writeViewer(dir, model) {
  const data = {
    tree: model.tree.map((n) => ({ id: n.id, parent: n.parent, label: n.label, device_id: n.deviceId, order: n.order })),
    devices: Object.fromEntries(model.devices.map((d) => [d.deviceId, forPage(d)])),
    folders: Object.fromEntries(model.folders.map((f) => [f.path, f])),
    network: grouped(model.network),
    collection: Object.fromEntries(Object.entries(grouped(model.collection)).map(([id, rows]) => [id, rows[0]])),
    revisions: grouped(model.revisions),
  };
  const html = (await readFile(TEMPLATE, 'utf8')).replace('/*DATA*/', () => jsonForScript(data));
  await writeFile(path.join(dir, 'viewer', 'viewer.html'), html);
}

export { writeViewer };
