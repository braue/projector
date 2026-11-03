// AcSELerator RTAC's saved connections for the SEL-3530 family — the list
// its Connect dialog offers — kept per user at
// %LOCALAPPDATA%\SEL\AcSELerator\RTAC\Connections\SEL3530.csv:
//
//     Name,Server,Port,Database,User_Id
//     SEL RTAC Default Connection,10.42.44.17,5432,3530,SEL
//
// The bench RTACs go in by name: a row already named for one gets the bench
// address (its other columns kept), a new one gets the file's own defaults.
// Every other row is left as it was. The previous file is kept beside it as
// SEL3530.csv.bak, and an unreadable one is refused rather than replaced.

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { httpError } from './http.js';

const FILE_NAME = 'SEL3530.csv';
const HEADER = ['Name', 'Server', 'Port', 'Database', 'User_Id'];
const DEFAULTS = { Port: '5432', Database: '3530', User_Id: 'SEL' };

/** Where AcRTAC keeps it; PROJECTOR_ACRTAC_CONNECTIONS (a directory) overrides. */
function connectionsDir() {
  if (process.env.PROJECTOR_ACRTAC_CONNECTIONS) return process.env.PROJECTOR_ACRTAC_CONNECTIONS;
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'SEL', 'AcSELerator', 'RTAC', 'Connections');
}

/** RFC 4180 rows (quoted cells may hold commas, "" and newlines); blank lines dropped. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('unclosed quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const quote = (cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** The file's text with `devices` (bench RTACs: {id, networkIp}) merged in,
 *  and what changed. `text` null is a file AcRTAC hasn't written yet. */
function mergeConnections(text, devices) {
  const [header, ...rows] = text == null ? [HEADER] : parseCsv(text.replace(/^﻿/, ''));
  if (!header) throw new Error('the file is empty');
  const col = Object.fromEntries(HEADER.map((name) => [name, header.findIndex((h) => h.trim() === name)]));
  const missing = HEADER.filter((name) => col[name] < 0);
  if (missing.length) throw new Error(`no ${missing.join(', ')} column`);

  const byName = new Map(rows.map((r) => [(r[col.Name] ?? '').trim(), r]));
  const added = [];
  const updated = [];
  for (const { id, networkIp } of devices) {
    const row = byName.get(id);
    if (row) {
      if (row[col.Server] !== networkIp) updated.push(id);
      row[col.Server] = networkIp;
      continue;
    }
    const fresh = header.map(() => '');
    for (const [name, value] of Object.entries({ Name: id, Server: networkIp, ...DEFAULTS })) fresh[col[name]] = value;
    rows.push(fresh);
    byName.set(id, fresh);
    added.push(id);
  }
  const lines = [header, ...rows].map((r) => header.map((_, i) => quote(r[i] ?? '')).join(','));
  return { text: lines.join('\r\n') + '\r\n', added, updated, total: rows.length };
}

/** Merge the bench RTACs into AcRTAC's SEL3530.csv on this machine. */
async function writeAcrtacConnections(devices, dir = connectionsDir()) {
  const file = path.join(dir, FILE_NAME);
  let text = null;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw httpError(500, `could not read ${file}: ${err?.message ?? err}`);
  }
  let merged;
  try {
    merged = mergeConnections(text, devices);
  } catch (err) {
    throw httpError(422, `${file} isn't the connection list this knows (${err.message}); left as it was`);
  }
  try {
    await mkdir(dir, { recursive: true });
    if (text != null) await copyFile(file, `${file}.bak`);
    await writeFile(`${file}.tmp`, merged.text);
    await rename(`${file}.tmp`, file);
  } catch (err) {
    throw httpError(500, `could not write ${file}: ${err?.message ?? err}`);
  }
  return { file, added: merged.added, updated: merged.updated, total: merged.total };
}

export { connectionsDir, mergeConnections, writeAcrtacConnections };
