// Parser for SEL relay databases (.rdb), the OLE compound files (CFB) that
// AcSELerator QuickSet writes. Memory-only: projector keeps the upload plus
// this model and never extracts the tree to disk.
//
//   Root Entry/Relays/<profile>/   one folder per relay profile
//     Cfg.txt                      [CLASSES]: section key, description, file
//     Set_*.txt (etc.)             optional [INFO] block of KEY=VALUE, one
//                                  [SECTION] header, then KEY,"VALUE" lines
//
// Values are kept verbatim (SEL logic equations run long). Anything past the
// cap is truncated with a visible marker, never dropped.

import CFB from 'cfb';

import { uniqueName } from '../../names.js';

const RELAYS = 'Root Entry/Relays/';
const MAX_VALUE = 4096;
const TRUNCATED = '…[truncated]';
const NOT_SETTINGS = new Set(['Cfg.txt', 'DatabaseVersion.txt', 'Device.txt', 'DmyCmts5010', 'Version']);

const FOLDER = 1;
const FILE = 2;

const unquote = (text) => text.replace(/^"|"$/g, '').trim();

// The relay model from [INFO]; product families spell the key differently.
function relayType(profile) {
  return profile.info?.RELAYTYPE ?? profile.info?.DEVICETYPE ?? null;
}

// Profile folder name -> the file entries anywhere beneath it, in folder order.
function filesByProfile(container) {
  const folders = [];
  const files = [];
  container.FullPaths.forEach((fullPath, index) => {
    if (!fullPath.startsWith(RELAYS)) return;
    const [name, ...rest] = fullPath.slice(RELAYS.length).split('/');
    const entry = container.FileIndex[index];
    if (!name) return;
    if (rest.join('') === '' && entry.type === FOLDER) folders.push(name);
    else if (entry.type === FILE) files.push({ name, entry });
  });
  return new Map(folders.map((folder) => [
    folder,
    files.filter(({ name }) => name === folder).map(({ entry }) => entry),
  ]));
}

// Cfg.txt's [CLASSES] table: section key -> { desc, file? }.
function sectionClasses(files) {
  const cfg = files.find((entry) => /^Cfg\.txt$/i.test(entry.name));
  const body = cfg?.content.toString().match(/\[CLASSES\]([\s\S]*)/i)?.[1] ?? '';
  const classes = {};
  for (const line of body.trim().split('\n')) {
    const [key, desc, file] = line.trim().split(',');
    if (desc === undefined) continue;
    classes[unquote(key).toUpperCase()] = file?.trim()
      ? { desc: unquote(desc), file: unquote(file) }
      : { desc: unquote(desc) };
  }
  return classes;
}

function parseSettingsFile(text) {
  const info = {};
  const settings = {};
  let section = null;
  let inInfo = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = raw.match(/^\[([^\]]+)\]/);
    if (header) {
      inInfo = /^INFO$/i.test(header[1]);
      if (!inInfo) section ??= header[1];
    } else if (inInfo) {
      const pair = line.match(/^([^=[\]]+)=(.*)$/);
      if (pair) info[pair[1].trim()] = pair[2].trim();
    }

    const setting = line.match(/^([^,]+)\s*,\s*"([^"]*)"/);
    if (setting) {
      const [, key, value] = setting;
      settings[key] = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) + TRUNCATED : value;
    }
  }
  return { info, section, settings };
}

// .rdb buffer -> { profiles: [{ name, info, sections: [{ key, desc, file, settings }] }] }
function parseRdb(buffer) {
  const container = CFB.read(buffer, { type: 'buffer' });
  const used = new Set();

  const profiles = [...filesByProfile(container)].map(([rawName, files], index) => {
    const base = rawName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || `profile-${index + 1}`;
    const name = uniqueName(base, (candidate) => used.has(candidate));
    used.add(name);

    const classes = sectionClasses(files);
    const profile = { name, info: {}, sections: [] };

    for (const entry of files) {
      if (NOT_SETTINGS.has(entry.name)) continue;
      const { info, section, settings } = parseSettingsFile(entry.content.toString());
      if (!Object.keys(profile.info).length) profile.info = info;
      if (!section) continue;
      profile.sections.push({
        key: section,
        desc: classes[section]?.desc ?? section,
        file: classes[section]?.file ?? entry.name,
        settings,
      });
    }
    return profile;
  });

  return { profiles };
}

export { parseRdb, relayType };
