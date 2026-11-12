// From the parsed QuickSet tables to the tool's outputs: the Device Manager
// tree (folders and the devices in them, devices behind other devices), each
// device's connection, its newest settings unpacked into the QuickSet export
// layout, and the settings DMA and network work cares about.

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toCsv } from '../../../lib/csv.js';

// Port settings worth a column when a device has them.
const NETWORK_KEYS = ['EPORT', 'IPADDR', 'SUBNETM', 'DEFRTR', 'IPADDRB', 'SUBNETMB', 'DEFRTRB',
  'NETMODE', 'NETPORT', 'NETASPD', 'NETBSPD', 'ETELNET', 'TPORT', 'TIDLE',
  'EFTPSERV', 'FTPUSER', 'FTPANMS', 'EHTTP', 'HTTPPORT', 'EHTTPS', 'E61850', 'EGSE',
  'EDNP', 'DNPADR', 'DNPNUM', 'EMOD', 'MODNUM', 'ESNTP', 'SNTPPSIP', 'SNTPBSIP',
  'SNTPRATE', 'SNTPPORT', 'EPMIP', 'PMOTS1'];
// Event, SER, load profile and time settings.
const COLLECTION_KEYS = ['LER', 'PRE', 'ERDIG', 'EVELOCK', 'NUMEVE', 'ESER', 'SER1', 'SER2', 'SER3',
  'SER4', 'SER5', 'SRATE', 'ELDP', 'LDLIST', 'LDAR', 'EVSSI', 'VSSIP', 'DATE_F', 'IRIGC',
  'DST_BEGM', 'UTCOFFS', 'TIME_SRC', 'NFREQ', 'PHROT', 'RID', 'TID', 'SID'];

const DEVICE_COLUMNS = [
  ['folder', 'Folder'], ['device', 'Device'], ['viaParent', 'Reached via'], ['deviceType', 'Device type'],
  ['deviceClass', 'Device class'], ['inService', 'In service'], ['partNumber', 'Part number'],
  ['serialNumber', 'Serial number'], ['fid', 'FID'], ['firmware', 'Firmware'], ['description', 'Description'],
  ['stationName', 'Station'], ['commType', 'Comm type'], ['ipAddress', 'IP address'], ['telnetPort', 'Telnet port'],
  ['httpsPort', 'HTTPS port'], ['ftpPort', 'FTP port'], ['fileTransferOption', 'File transfer option'],
  ['protocol', 'Protocol'], ['hostProtocol', 'Host protocol'], ['parentPort', 'Parent port'], ['serial', 'Serial'],
  ['phoneNumber', 'Phone'], ['credentialSource', 'Credential source'], ['userName', 'User name'],
  ['accessLevel', 'Access level'], ['rtacTitledPassword', 'RTAC titled password'],
  ['rtacSoeListening', 'RTAC SOE listening'], ['blueframeIp', 'Blueframe IP'], ['blueframeUser', 'Blueframe user'],
  ['blueframeResource', 'Blueframe resource'], ['attributes', 'Attributes'], ['settingsSource', 'Settings source'],
  ['settingsDate', 'Settings date'], ['settingsComment', 'Settings comment'], ['settingsFolder', 'Settings folder'],
  ['deviceId', 'Device id'],
];

const rowsOf = (tables, name) => tables[name]?.rows ?? [];
const byId = (tables, name, key) => new Map(rowsOf(tables, name).map((r) => [r[key], r]));
const lookup = (tables, name, key, label) => new Map(rowsOf(tables, name).map((r) => [r[key], r[label]]));
const blank = (v) => v ?? '';
const realIp = (ip) => (ip && ip !== '0.0.0.0' ? ip : '');

/** A path segment safe on Windows and Linux. */
function safeName(name) {
  const cleaned = String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/\.+$/, '');
  return cleaned || '_';
}

/** [{ section, key, value }] from a set_*.txt / Cfg.txt. */
function parseSettingFile(text) {
  const out = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.replace(/^[\s\u001c-\u001f]+|[\s\u001c-\u001f]+$/g, '');
    if (!s || s[0] === '#' || s[0] === ';') continue;
    if (s.startsWith('[') && s.endsWith(']')) {
      section = s.slice(1, -1);
      continue;
    }
    const cuts = [s.indexOf(','), s.indexOf('=')].filter((i) => i > 0);
    if (!cuts.length) continue;
    const at = Math.min(...cuts);
    out.push({ section, key: s.slice(0, at).trim(), value: s.slice(at + 1).trim().replace(/^"|"$/g, '') });
  }
  return out;
}

/** Streamed CSV for the one output that runs to millions of rows. */
function csvStream(file, header) {
  const out = createWriteStream(file);
  const write = (row) => (out.write(toCsv(row, [])) ? null : new Promise((r) => out.once('drain', r)));
  write(header);
  return {
    write,
    end: () => new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    }),
  };
}

/**
 * Build every output into `dir` from the parsed tables; `blobDir` holds the
 * settings ZIPs. Returns { devices, folders, network, collection, revisions,
 * tree } for the viewer and the tool UI. `log` narrates.
 */
async function buildModel(tables, { dir, blobDir, unzip, log = () => {} }) {
  const devices = byId(tables, 'public.device', 'device_id');
  const dtypes = byId(tables, 'public.device_type', 'device_type_id');
  const dclasses = lookup(tables, 'public.device_type_class', 'device_type_class_id', 'class_name');
  const conns = byId(tables, 'public.connection', 'connection_id');
  const chans = byId(tables, 'public.communication_channel', 'communication_channel_id');
  const ctypes = lookup(tables, 'public.communication_type', 'communication_type_id', 'communication_type');
  const protos = lookup(tables, 'public.protocol', 'protocol_id', 'protocol_name');
  const serifs = lookup(tables, 'public.serial_interface_type', 'serial_interface_type_id', 'serial_interface_type_name');
  const credsrc = lookup(tables, 'public.credential_source_type', 'credential_source_type_id', 'credential_source_type_name');
  const locs = byId(tables, 'public.location', 'location_id');
  const ltypes = lookup(tables, 'public.location_type', 'location_type_id', 'location_type_name');
  const titled = lookup(tables, 'public.titled_password', 'titled_password_id', 'title');
  const nodes = byId(tables, 'public.connection_node_data', 'connection_node_id');
  const revTypes = lookup(tables, 'public.config_revision_type', 'config_revision_type_id', 'revision_type');
  const attrTypes = lookup(tables, 'public.device_attribute_type', 'device_attribute_type_id', 'attribute_name');

  const devOpt = byId(tables, 'public.device_option', 'device_option_id');
  const rtacOpt = new Map();
  for (const r of rowsOf(tables, 'public.device_rtac_option')) {
    const did = devOpt.get(r.device_option_id)?.device_id;
    if (did) rtacOpt.set(did, r);
  }
  const attrs = new Map();
  for (const r of rowsOf(tables, 'public.device_attribute')) {
    if (!attrs.has(r.device_id)) attrs.set(r.device_id, []);
    attrs.get(r.device_id).push(`${attrTypes.get(r.attribute_type_id) ?? r.attribute_type_id}=${blank(r.attribute_value)}`);
  }

  // The tree: folder nodes carry a location, device nodes a device.
  const label = (n) => (n.location_id
    ? locs.get(n.location_id)?.location_name || `location ${n.location_id}`
    : devices.get(n.device_id)?.device_name || `device ${n.device_id}`);
  const ancestors = (n) => {
    const chain = [];
    const seen = new Set([n.connection_node_id]);
    let cur = n.parent_node_id ? nodes.get(n.parent_node_id) : null;
    while (cur && !seen.has(cur.connection_node_id)) {
      seen.add(cur.connection_node_id);
      chain.unshift(cur);
      cur = cur.parent_node_id ? nodes.get(cur.parent_node_id) : null;
    }
    return chain;
  };
  const folders = [];
  const devNodes = [];
  for (const n of nodes.values()) {
    const chain = ancestors(n);
    if (n.location_id) {
      const loc = locs.get(n.location_id) ?? {};
      folders.push({
        path: [...chain, n].map(label).join(' / '),
        name: label(n),
        type: blank(ltypes.get(loc.location_type_id)),
        description: blank(loc.description),
        latitude: blank(loc.latitude),
        longitude: blank(loc.longitude),
      });
    } else if (n.device_id) {
      devNodes.push({ node: n, chain });
    }
  }
  folders.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const sortKey = ({ node, chain }) => [...chain, node].map((x) => label(x).toLowerCase()).join('\u0000');
  devNodes.sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true }));

  // Newest settings per device: the latest revision, or the work copy when
  // that is newer.
  const revisions = rowsOf(tables, 'public.device_config_revision')
    .slice()
    .sort((a, b) => Number(a.revision_sequence_number ?? 0) - Number(b.revision_sequence_number ?? 0));
  const latest = new Map();
  for (const r of revisions) {
    if (r.settings_content_id) {
      latest.set(r.device_id, { source: 'revision', date: blank(r.begin_timestamp), id: r.settings_content_id, comment: r.comment });
    }
  }
  for (const w of rowsOf(tables, 'public.device_settings_work_copy')) {
    if (!w.settings_content_id || w.is_cleared === 't') continue;
    const date = w.updated_timestamp || w.created_timestamp || '';
    const cur = latest.get(w.device_id);
    if (!cur || date > cur.date) latest.set(w.device_id, { source: 'work copy', date, id: w.settings_content_id, comment: w.comment });
  }

  const configsDir = path.join(dir, 'configs');
  const viewerData = path.join(dir, 'viewer', 'viewer_data');
  await rm(configsDir, { recursive: true, force: true });
  await mkdir(viewerData, { recursive: true });
  const long = csvStream(path.join(dir, 'settings.csv'), ['Folder', 'Device', 'Relay type', 'File', 'Group', 'Setting', 'Value']);

  const deviceRows = [];
  const usedDirs = new Set(); // lowercased: Windows paths ignore case
  const network = [];
  const collection = [];
  for (const [index, { node, chain }] of devNodes.entries()) {
    const did = node.device_id;
    const d = devices.get(did) ?? {};
    const dt = dtypes.get(d.device_type_id) ?? {};
    const conn = conns.get(d.connection_id) ?? {};
    const ch = chans.get(conn.communication_channel_id) ?? {};
    const ctype = blank(ctypes.get(ch.communication_type_id));
    const rt = rtacOpt.get(did);
    const folder = chain.filter((a) => a.location_id).map(label).join(' / ');
    const parity = (ch.parity || 'N')[0];
    const row = {
      folder,
      device: blank(d.device_name),
      viaParent: chain.filter((a) => a.device_id).map(label).join(' > '),
      deviceType: blank(dt.device_type_name),
      deviceClass: blank(dclasses.get(dt.device_type_class_id)),
      inService: d.in_service === 't' ? 'Yes' : d.in_service === 'f' ? 'No' : '',
      partNumber: blank(d.part_number),
      serialNumber: blank(d.serial_number),
      fid: blank(d.fid_string),
      firmware: blank(d.firmware_version),
      description: blank(d.description),
      stationName: blank(d.station_name),
      commType: ctype,
      ipAddress: realIp(ch.ip_address),
      telnetPort: ctype === 'network' ? blank(ch.telnet_port) : '',
      httpsPort: ctype === 'network' || ctype === 'blueframe' ? blank(ch.https_port) : '',
      ftpPort: ctype === 'network' ? blank(ch.ftp_port) : '',
      fileTransferOption: blank(ch.file_transfer_option),
      protocol: protos.get(ch.protocol_id) === 'Unspecified' ? '' : blank(protos.get(ch.protocol_id)),
      hostProtocol: blank(protos.get(ch.host_protocol_id)),
      parentPort: blank(conn.port_number),
      serial: ctype === 'direct serial' || ctype === 'modem'
        ? `${blank(ch.baud_rate)} ${blank(ch.data_bits)}${parity}${blank(ch.stop_bits)} ${blank(serifs.get(ch.serial_interface_id))}`.trim()
        : '',
      phoneNumber: blank(ch.phone_number),
      credentialSource: blank(credsrc.get(ch.credential_source_type_id)),
      userName: blank(ch.user_name),
      accessLevel: blank(ch.access_level_id),
      rtacTitledPassword: rt ? blank(titled.get(rt.titled_password_id)) : '',
      rtacSoeListening: rt ? (rt.is_soe_listening_enabled === 't' ? 'Yes' : 'No') : '',
      blueframeIp: realIp(ch.blueframe_ip_address),
      blueframeUser: blank(ch.blueframe_user_name),
      blueframeResource: blank(ch.resource_id),
      attributes: (attrs.get(did) ?? []).join('; '),
      settingsSource: '',
      settingsDate: '',
      settingsComment: '',
      settingsFolder: '',
      deviceId: did,
    };

    const settings = new Map(); // "group\u0000key" -> value, first wins
    const groups = [];
    const pick = latest.get(did);
    if (pick) {
      row.settingsSource = pick.source;
      row.settingsDate = pick.date;
      row.settingsComment = blank(pick.comment).replace(/\s*\n\s*/g, ' ');
      let entries = null;
      try {
        entries = unzip(await readFile(path.join(blobDir, `${pick.id}.zip`)));
      } catch (err) {
        if (err?.code !== 'ENOENT') row.settingsSource += ' (unreadable)';
      }
      if (entries) {
        // Two devices can share a name in one folder (or clean to the same
        // one); the second gets its id so neither overwrites the other.
        let devDir = path.join(configsDir, ...chain.map((a) => safeName(label(a))), safeName(row.device || did));
        if (usedDirs.has(devDir.toLowerCase())) devDir = `${devDir} (${safeName(did)})`;
        usedDirs.add(devDir.toLowerCase());
        row.settingsFolder = path.relative(dir, devDir).split(path.sep).join('/');
        const files = new Map();
        for (const [name, bytes] of Object.entries(entries)) {
          if (name.endsWith('/') || name.endsWith('\\')) continue;
          const parts = name.replaceAll('\\', '/').split('/');
          // <top>/Relays/<device>/...  ->  <device dir>/...
          const rel = parts.length >= 3 && parts[1].toLowerCase() === 'relays' ? parts.slice(3) : parts.slice(1);
          if (!rel.length) continue;
          const target = path.join(devDir, ...rel.map(safeName));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, bytes);
          files.set(rel.join('/'), bytes);
        }
        const cfgKey = [...files.keys()].find((k) => k.toLowerCase() === 'misc/cfg.txt');
        const groupNames = new Map();
        if (cfgKey) {
          for (const { section, key, value } of parseSettingFile(Buffer.from(files.get(cfgKey)).toString('latin1'))) {
            if (section === 'INFO') settings.set(`INFO\u0000${key}`, value);
            else if (section === 'CLASSES') groupNames.set(key, value);
          }
        }
        const order = [...groupNames.keys()].sort((a, b) => (a === 'G' ? -1 : b === 'G' ? 1 : 0));
        const relayType = settings.get('INFO\u0000RELAYTYPE') ?? '';
        for (const rel of [...files.keys()].sort()) {
          const base = rel.split('/').pop();
          if (!/^set_.*\.txt$/i.test(base)) continue;
          const code = base.slice(4, -4);
          const group = { code, name: groupNames.get(code) ?? code, file: rel, settings: [] };
          for (const { section, key, value } of parseSettingFile(Buffer.from(files.get(rel)).toString('latin1'))) {
            if (section === 'INFO') continue;
            const g = section || code;
            const k = `${g}\u0000${key}`;
            if (!settings.has(k)) settings.set(k, value);
            group.settings.push([key, value]);
            await long.write([folder, row.device, relayType, rel, groupNames.get(g) ?? g, key, value]);
          }
          groups.push(group);
        }
        groups.sort((a, b) => {
          const ia = order.indexOf(a.code);
          const ib = order.indexOf(b.code);
          return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
        });
        await writeFile(path.join(viewerData, `${safeName(did)}.js`),
          `QSV_LOADED(${jsonForScript(String(did))},${jsonForScript({ groups, files: [...files.keys()].sort() })});\n`);
      }
    }
    if (!row.fid && settings.has('INFO\u0000FID')) row.fid = settings.get('INFO\u0000FID');
    if (!row.partNumber && settings.has('INFO\u0000PARTNO')) row.partNumber = settings.get('INFO\u0000PARTNO');
    deviceRows.push(row);

    const groupCodes = [...new Set([...settings.keys()].map((k) => k.split('\u0000')[0]))].filter((g) => g !== 'INFO').sort();
    for (const g of groupCodes) {
      const vals = {};
      for (const k of NETWORK_KEYS) if (settings.has(`${g}\u0000${k}`)) vals[k] = settings.get(`${g}\u0000${k}`);
      if (vals.IPADDR || vals.IPADDRB) {
        network.push({ deviceId: did, folder, device: row.device, deviceType: row.deviceType, quicksetIp: row.ipAddress, port: g, ...vals });
      }
    }
    const cvals = {};
    for (const k of COLLECTION_KEYS) {
      const g = groupCodes.find((code) => settings.has(`${code}\u0000${k}`));
      if (g) cvals[k] = settings.get(`${g}\u0000${k}`);
    }
    if (Object.keys(cvals).length) collection.push({ deviceId: did, folder, device: row.device, deviceType: row.deviceType, ...cvals });
    if ((index + 1) % 50 === 0) log(`${index + 1} of ${devNodes.length} devices`);
  }
  await long.end();

  const inTree = new Set(devNodes.map((x) => x.node.device_id));
  const revisionRows = revisions.filter((r) => inTree.has(r.device_id)).map((r) => ({
    deviceId: r.device_id,
    device: blank(devices.get(r.device_id)?.device_name),
    seq: blank(r.revision_sequence_number),
    type: blank(revTypes.get(r.revision_type_id)),
    version: blank(r.version_number),
    date: blank(r.begin_timestamp),
    user: blank(r.creator_username),
    comment: blank(r.comment).replace(/\s*\n\s*/g, ' '),
  }));

  const tree = [...nodes.values()].map((n) => ({
    id: n.connection_node_id,
    parent: n.parent_node_id,
    label: label(n),
    deviceId: n.device_id,
    order: Number(n.display_order ?? 0),
  }));

  // CSVs with a column for every key any row carries.
  const writeCsv = async (name, rows, fixed) => {
    const keys = fixed ?? [...new Set(rows.flatMap((r) => Object.keys(r)))].map((k) => [k, k]);
    await writeFile(path.join(dir, name), toCsv(keys.map(([, title]) => title), rows.map((r) => keys.map(([key]) => r[key] ?? ''))));
  };
  await writeCsv('devices.csv', deviceRows, DEVICE_COLUMNS);
  await writeCsv('folders.csv', folders, [['path', 'Path'], ['name', 'Name'], ['type', 'Type'], ['description', 'Description'], ['latitude', 'Latitude'], ['longitude', 'Longitude']]);
  await writeCsv('network.csv', network.map(({ deviceId, ...rest }) => rest));
  await writeCsv('collection.csv', collection.map(({ deviceId, ...rest }) => rest));
  await writeCsv('revisions.csv', revisionRows.map(({ deviceId, ...rest }) => rest));

  return { devices: deviceRows, folders, network, collection, revisions: revisionRows, tree };
}

/** JSON that is safe inside a <script> element. */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

export { buildModel, jsonForScript, parseSettingFile, safeName, DEVICE_COLUMNS };
