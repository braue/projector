// Parser for SEL relay databases (.rdb) — an OLE compound file (CFB) holding
// one or more relay profiles, as AcSELerator QuickSet writes them. Ported
// from Volture and made memory-only: purview keeps the original upload plus
// this parsed model, and never re-extracts the tree to disk.
//
// Layout inside the container:
//   Root Entry/Relays/<profile>/    one folder per relay profile
//     Set_*.txt (etc.)              settings files: an optional [INFO] block,
//                                   one [SECTION] header, then KEY,"VALUE" lines
//     Cfg.txt                       [CLASSES] table: section key -> description
//
// Values survive verbatim (SEL settings hold long logic equations); anything
// past the cap is truncated with an explicit marker, never dropped silently.

import CFB from 'cfb';

import { uniqueName } from '../../names.js';

const PROFILE_ROOT_PREFIX = 'Root Entry/Relays/';

const MAX_SETTING_VALUE_LENGTH = 4096;
const TRUNCATION_MARKER = '…[truncated]';

const SKIP_FILES = new Set([
  'Cfg.txt',
  'DatabaseVersion.txt',
  'Device.txt',
  'DmyCmts5010',
  'Version',
]);

function sanitizeName(raw) {
  return (raw ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
}

function uniqueProfileName(rawName, usedNames, index) {
  const baseName = sanitizeName(rawName) || `profile-${index + 1}`;
  const name = uniqueName(baseName, (candidate) => usedNames.has(candidate));
  usedNames.add(name);
  return name;
}

// The relay's model as stated in the profile's [INFO] metadata; spellings
// vary by product family.
function relayType(profile) {
  return profile.info?.RELAYTYPE ?? profile.info?.DEVICETYPE ?? null;
}

// Walks container.FullPaths once and maps each profile folder directly under
// Root Entry/Relays/ to every file entry inside it. Membership is by path
// prefix, so files in subfolders such as Misc belong to their profile.
function indexProfileEntries(container) {
  const folderNames = [];
  const entriesByProfile = new Map();

  for (const [index, fullPath] of container.FullPaths.entries()) {
    if (!fullPath.startsWith(PROFILE_ROOT_PREFIX)) continue;
    const withinRelays = fullPath.slice(PROFILE_ROOT_PREFIX.length);
    const profileName = withinRelays.split('/')[0];
    if (!profileName) continue;

    const entry = container.FileIndex[index];
    const relativePath = withinRelays.slice(profileName.length + 1);
    if (!relativePath) {
      if (entry.type === 1 && !folderNames.includes(profileName)) {
        folderNames.push(profileName);
      }
      continue;
    }

    if (!entriesByProfile.has(profileName)) entriesByProfile.set(profileName, []);
    entriesByProfile.get(profileName).push({ entry, relativePath });
  }

  const profileEntries = new Map();
  for (const name of folderNames) {
    profileEntries.set(name, entriesByProfile.get(name) || []);
  }
  return profileEntries;
}

// Cfg.txt's [CLASSES] table: section key -> { desc, file }.
function translationTable(profileEntries) {
  const table = {};
  const cfgEntry = profileEntries.find(
    ({ entry }) => entry.type === 2 && /^Cfg\.txt$/i.test(entry.name),
  );
  if (!cfgEntry) return table;

  const text = cfgEntry.entry.content.toString();
  const matchLines = text.match(/\[CLASSES\]([\s\S]*)/i);
  if (!matchLines) return table;

  for (const line of matchLines[1].trim().split('\n')) {
    const parts = line.trim().split(',');
    if (parts.length >= 2) {
      const key = parts[0].replace(/^"|"$/g, '').trim().toUpperCase();
      const entry = { desc: parts[1].replace(/^"|"$/g, '').trim() };
      if (parts.length >= 3 && parts[2].trim() !== '') {
        entry.file = parts[2].replace(/^"|"$/g, '').trim();
      }
      table[key] = entry;
    }
  }
  return table;
}

function parseSettingsFile(contentStr) {
  const lines = contentStr.split(/\r?\n/);

  // [INFO] block: KEY=VALUE metadata (RELAYTYPE, FID, ...).
  const info = {};
  let insideInfo = false;
  for (const line of lines) {
    if (/^\[INFO\]/i.test(line)) {
      insideInfo = true;
      continue;
    }
    if (insideInfo) {
      if (/^\[.*\]/.test(line)) break;
      const match = line.trim().match(/^([^=[\]]+)=([^\r\n]*)$/);
      if (match) info[match[1].trim()] = match[2].trim();
    }
  }

  // The section this file carries: first non-INFO [HEADER].
  const sectionLine = lines.find((line) => /^\[[^\]]+\]/.test(line) && !/^\[INFO\]/i.test(line));
  const sectionKey = sectionLine ? sectionLine.match(/^\[([^\]]+)\]/)[1] : null;

  const settings = {};
  for (const line of lines) {
    const match = line.trim().match(/^([^,]+)\s*,\s*"([^"]*)"/);
    if (match) {
      const [, key, value] = match;
      settings[key] = value.length > MAX_SETTING_VALUE_LENGTH
        ? value.slice(0, MAX_SETTING_VALUE_LENGTH) + TRUNCATION_MARKER
        : value;
    }
  }

  return { info, sectionKey, settings };
}

// Parse an .rdb from a buffer into profiles:
//   [{ name, info, sections: [{ key, desc, file, settings }] }]
function parseRdb(buffer) {
  const container = CFB.read(buffer, { type: 'buffer' });
  const profiles = [];
  const usedNames = new Set();

  let profileIndex = 0;
  for (const [rawName, profileEntries] of indexProfileEntries(container)) {
    const name = uniqueProfileName(rawName, usedNames, profileIndex);
    profileIndex += 1;

    const translations = translationTable(profileEntries);
    const profile = { name, info: {}, sections: [] };
    let infoParsed = false;

    for (const { entry } of profileEntries) {
      if (entry.type !== 2) continue;
      if (SKIP_FILES.has(entry.name)) continue;

      const parsed = parseSettingsFile(entry.content.toString());

      if (!infoParsed && Object.keys(parsed.info).length > 0) {
        profile.info = parsed.info;
        infoParsed = true;
      }
      if (!parsed.sectionKey) continue;

      profile.sections.push({
        key: parsed.sectionKey,
        desc: translations[parsed.sectionKey]?.desc ?? parsed.sectionKey,
        file: translations[parsed.sectionKey]?.file ?? entry.name,
        settings: parsed.settings,
      });
    }

    profiles.push(profile);
  }

  return { profiles };
}

export { parseRdb, relayType };
