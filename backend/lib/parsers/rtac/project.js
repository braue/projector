// Layer 2 of the RTAC export parser — semantics.
//
// Folds the structural modules of one export into the project model the API
// serves: one item per export file, each carrying its interpreted setting
// pages (flattened config, normalized points, leftover pages verbatim) plus
// whatever kind-specific structure layer 1 extracted (POU source, EtherCAT
// topology, ...). Connections additionally get a role/family classification
// and a derived endpoint label, and servers get their shared map linked.
//
// Pages are classified by column signature rather than by a hard-coded
// page-name list, so unfamiliar pages (new relay models, future protocols)
// still classify instead of being dropped.

import { firstSetting } from '../../settings.js';
import {
  RTAC_BAUD_SETTING,
  RTAC_LOCAL_PORT_SETTINGS,
  RTAC_REMOTE_ADDRESS_SETTINGS,
  RTAC_REMOTE_PORT_SETTINGS,
  RTAC_SERIAL_PORT_SETTING,
} from './endpoints.js';

// A page whose rows are keyed on a "Setting" column is a config table
// (Setting/Value/Comment). A page with a "Tag Name" column is a point map.
// Anything else is kept verbatim as a generic table.
const CONFIG_KEY_COLUMN = 'Setting';
const POINT_NAME_COLUMN = 'Tag Name';

// Columns that carry a point's address, by protocol family. First match wins;
// the raw row is always retained so nothing is lost.
const ADDRESS_COLUMNS = [
  'Point Number',           // DNP, Mirrored Bits (transmit)
  'Bit Number',             // Mirrored Bits (receive), SEL breaker bits
  'Coil Address',           // Modbus coils
  'Input Address',          // Modbus discrete inputs
  'Register Address Start', // Modbus holding / input registers
  'Remote Bit',             // SEL remote bits
];

// Settings that name the far end of a connection, from the shared endpoint
// vocabulary. Deliberately excludes "Client IP Address(es)" — on a server that
// is an access list, not an endpoint.
const PORT_SETTINGS = [...RTAC_REMOTE_PORT_SETTINGS, ...RTAC_LOCAL_PORT_SETTINGS];

// A server keeps its point map in a sibling TagList file; this setting names
// that file (its base name, e.g. "DNPServerSharedMap1_DNP").
const SHARED_MAP_SETTING = 'Map Name';

function classifyPage(page) {
  const columns = new Set(page.columns);
  if (columns.has(POINT_NAME_COLUMN)) return 'points';
  if (columns.has(CONFIG_KEY_COLUMN)) return 'config';
  return 'generic';
}

// Derive { role, family } from an RTAC protocol token, e.g. "DNPClient".
function classifyProtocol(protocol) {
  if (!protocol) return { role: null, family: null };
  if (protocol === 'SELMirroredBits') return { role: 'peer', family: 'MirroredBits' };

  let role = 'system'; // NGVL, AccessPointServer, ...
  if (protocol.endsWith('Client')) role = 'client';
  else if (protocol.endsWith('Server')) role = 'server';

  return { role, family: protocol.replace(/(Client|Server)$/, '') };
}

// Flatten a config page (Setting/Value/Comment rows) into { key: value }.
function flattenConfig(page) {
  const out = {};
  for (const row of page.rows) {
    const key = row[CONFIG_KEY_COLUMN];
    if (!key) continue;
    out[key] = row.Value ?? '';
  }
  return out;
}

function parseBool(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).toLowerCase() === 'true';
}

// Normalized points from a point page; the full row stays under `raw`.
function extractPoints(page) {
  return page.rows.map((row) => {
    const addressColumn = ADDRESS_COLUMNS.find((column) => column in row) ?? null;
    return {
      page: page.name,
      tagName: row[POINT_NAME_COLUMN] ?? null,
      tagType: row['Tag Type'] ?? null, // IEC 61850 CDC: SPS, DPS, MV, INS, SPC, ...
      alias: row['Tag Alias'] ?? null,
      enabled: parseBool(row.Enable ?? row.Visible),
      addressColumn,
      address: addressColumn ? row[addressColumn] : null,
      comment: row.Comment ?? null,
      raw: row,
    };
  });
}

// The far end of a connection as one short label for the connections table.
// Serial links read "Com_01 · 19200"; IP links read "host:port" (or ":port"
// for a server, which only declares what it listens on).
function deriveEndpoint(settings, connectionType) {
  if (connectionType === 'Serial') {
    const port = settings[RTAC_SERIAL_PORT_SETTING];
    if (!port) return null;
    const baud = settings[RTAC_BAUD_SETTING];
    return baud ? `${port} · ${baud}` : port;
  }

  const address = firstSetting(settings, RTAC_REMOTE_ADDRESS_SETTINGS);
  const port = firstSetting(settings, PORT_SETTINGS);
  if (address && port) return `${address}:${port}`;
  if (port) return `:${port}`;
  return address;
}

// Split one module's setting pages into config / points / everything else.
function interpretPages(module) {
  const settings = {};
  const points = [];
  const pages = [];

  for (const page of module.settingPages) {
    const kind = classifyPage(page);
    if (kind === 'config') Object.assign(settings, flattenConfig(page));
    else if (kind === 'points') points.push(...extractPoints(page));
    else if (page.rows.length) pages.push(page); // empty pages carry nothing
  }

  return { settings, points, pages };
}

// The file base name a "Map Name" setting refers to, and the fallback the
// TagList itself declares as <Name>.
function moduleBaseName(file) {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.xml$/i, '');
}

// One project item per export file: identity, classification, interpreted
// pages, and every kind-specific field layer 1 extracted — carried through
// verbatim so a new extractor's output reaches the API without touching this
// file.
function buildItem(module) {
  const { settingPages, ...rest } = module;
  const { settings, points, pages } = interpretPages(module);

  const item = {
    ...rest,
    // The file path is the only identity an export guarantees to be unique.
    id: module.file,
    settings,
    points,
    pointCount: points.length,
    pages,
  };

  if (module.category === 'connection') {
    const { role, family } = classifyProtocol(module.protocol);
    item.role = role;
    item.protocolFamily = family;
    item.endpoint = deriveEndpoint(settings, module.connectionType);
    item.sharedMapRef = settings[SHARED_MAP_SETTING] || null;
    item.sharedMap = null;
  }

  return item;
}

// Attach each server's shared map to it. RTAC names the map by file base name
// ("DNPServerSharedMap1_DNP"); older/other exports may use the TagList's own
// <Name>, so both are accepted. The tag list stays a project item of its own —
// the file tree shows it — but the connection preview gets the map inline.
function linkSharedMaps(items) {
  const byKey = new Map();
  for (const item of items) {
    if (item.category !== 'tagList') continue;
    byKey.set(moduleBaseName(item.file), item);
    if (item.name) byKey.set(item.name, item);
  }

  for (const item of items) {
    if (item.category !== 'connection' || !item.sharedMapRef) continue;
    const map = byKey.get(item.sharedMapRef);
    if (!map) continue;
    item.sharedMap = { file: map.file, name: map.name, points: map.points };
    item.pointCount += map.points.length;
  }
}

// Assemble the project model from every structural module in one export.
function buildProject(modules) {
  const items = modules.map(buildItem);
  linkSharedMaps(items);

  let projectName = null;
  let schema = null;
  let deviceMOT = null;
  for (const item of items) {
    schema ??= item.schema;
    deviceMOT ??= item.deviceMOT;
    if (item.kind === 'NavigatorLayout' && item.name) projectName = item.name;
  }

  const connections = items.filter((item) => item.category === 'connection');
  const countRole = (role) => connections.filter((connection) => connection.role === role).length;

  return {
    name: projectName,
    schema,
    deviceMOT,
    summary: {
      files: items.length,
      connections: connections.length,
      clients: countRole('client'),
      servers: countRole('server'),
      peers: countRole('peer'),
      totalPoints: items.reduce((total, item) => total + item.pointCount, 0),
      protocols: [...new Set(connections.map((c) => c.protocol).filter(Boolean))].sort(),
    },
    items,
  };
}

export { buildProject, moduleBaseName };
