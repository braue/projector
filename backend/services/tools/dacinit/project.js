// What a DAC project already says about itself, read once per run: the tag
// lists of its DNP clients and SCADA maps, the device definitions it declares,
// which Init_* POU holds which device kind, and how its existing reclosers are
// configured. The generators take their pointers and definitions from here
// rather than from naming templates, because the CLECO schemes don't share one
// naming scheme: a recloser's client can be SEL_651R2_048 or SEL_651R2_R048,
// two reclosers can share one client (ST_MARY_STREET_3166_3168_DNP._3166_…),
// a 34.5kV project can split its SCADA points over DMS_POINTS_ONE and
// DMS_POINTS_TWO, and feeders map as FDR_… or FEEDER_…. Across every CLECO
// scheme (13.2kV and 34.5kV, ~7,000 init statements) the rule that holds is:
// a pointer is the FIRST tag of the device's group, where a group is the run
// of tags sharing a prefix ahead of "BI_00000"/"AI_00000"/"BO_00000".

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readInterconnect } from './connectors.js';
import { readImplementation } from './pou.js';

const SECTIONS = { 'Binary Inputs': 'BI', 'Analog Inputs': 'AI', 'Binary Outputs': 'BO' };

// Each kind's Init_* POU, matched by name — the schemes spell them
// Init_Xfmr / Init_XFMR, Init_PseudoBkr / Init_PseudoBkrs / Init_Pseudo_Bkrs.
const POU_PATTERNS = {
  reclosers: /^Init_Reclosers?\.xml$/i,
  transformers: /^Init_Xfmrs?\.xml$/i,
  feeders: /^Init_Feeders?\.xml$/i,
  breakers: /^Init_Breakers?\.xml$/i,
  pseudoBreakers: /^Init_Pseudo_?Bkrs?\.xml$/i,
  connectors: /^Init_DA_Connectors?\.xml$/i,
};

// Device-definition variable types, by the device kind they define.
const DEF_TYPES = {
  feeder: /^typeFeederDeviceDef$/i,
  transformer: /^type\w*TransformerDeviceDef$/i,
  pseudoBreaker: /^typePseudoBreakerDeviceDef$/i,
  recloser: /^typeRecloserDeviceDef$/i,
  connector: /^typeDacInterconnectDeviceDef$/i,
  manager: /^typeDacInterconnectManagerDeviceDef$/i,
};

async function listXml(dir) {
  const out = [];
  const walk = async (at) => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.xml$/i.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

const tokens = (text) => text.toLowerCase().split('_').filter(Boolean);

/**
 * Split a tag into the parts the pointer rule needs. "ST_MARY_3166_3168_DNP.
 * _3166_BI_00000_RECLOSER_STATUS.status" -> struct "ST_MARY_3166_3168_DNP",
 * member "_3166_BI_00000_RECLOSER_STATUS", group "_3166_". Trailing members
 * (".status" on outputs) are not part of what ADR() points at.
 */
function parseTag(tag) {
  const [struct, member] = tag.split('.');
  if (!member) return null;
  const head = /^(.*?)(?:BI|AI|BO)_\d{5}/i.exec(member);
  return { struct, member, group: head ? head[1] : null };
}

/** The setting pages of a Device or TagList export that carry point tags. */
function readTagSections(xml) {
  const sections = {};
  const page = /<SettingPage>\s*<Name>([^<]*)<\/Name>([\s\S]*?)<\/SettingPage>/g;
  for (let m = page.exec(xml); m; m = page.exec(xml)) {
    const kind = SECTIONS[m[1]];
    if (!kind) continue;
    const names = [];
    const tag = /<Column>Tag Name<\/Column>\s*<Value>([^<]*)<\/Value>/g;
    for (let t = tag.exec(m[2]); t; t = tag.exec(m[2])) {
      const parsed = parseTag(t[1].trim());
      if (parsed) names.push(parsed);
    }
    sections[kind] = names;
  }
  return sections;
}

/** `name : type` declarations in a GVL body, comments stripped. */
function declaredVariables(content) {
  const text = content.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\n]*/g, '');
  const out = [];
  const decl = /^\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/gm;
  for (let m = decl.exec(text); m; m = decl.exec(text)) out.push({ name: m[1], type: m[2] });
  return out;
}

/** Parse "Name := value," pairs out of one call's argument text. */
function callArgs(text) {
  const args = {};
  const pair = /([A-Za-z_]\w*)\s*:=\s*([^,;)]+(?:\([^)]*\))?[^,;)]*)/g;
  for (let m = pair.exec(text); m; m = pair.exec(text)) args[m[1].toLowerCase()] = m[2].trim();
  return args;
}

/**
 * The point-count profile of each existing recloser: NumBi/NumAi/NumBo/NumAo/
 * NumCnt from its InitAutoMapScadaLink, and whether its client is shared (the
 * field pointer reads "<client>._<n>_BI_…"). New reclosers copy the profile
 * most of the project's same-shaped reclosers use.
 */
function recloserProfiles(implText) {
  const text = implText.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/[^\n]*/g, '');
  const shared = new Map();
  const field = /(\w+)\.init\s*\(([^;]*?)\)\s*;/gi;
  for (let m = field.exec(text); m; m = field.exec(text)) {
    const bi = callArgs(m[2]).pfieldfirst_bi ?? '';
    shared.set(m[1].toLowerCase(), /\._/.test(bi));
  }
  const out = [];
  const auto = /(\w+)\.InitAutoMapScadaLink\s*\(([^;]*?)\)\s*;/gi;
  for (let m = auto.exec(text); m; m = auto.exec(text)) {
    const args = callArgs(m[2]);
    const counts = ['numbi', 'numai', 'numbo', 'numao', 'numcnt'].map((key) => args[key]);
    if (counts.some((v) => v == null)) continue;
    out.push({ name: m[1], shared: shared.get(m[1].toLowerCase()) ?? false, counts });
  }
  return out;
}

/** Read the DAC project at `rtacDir` (the .rtac folder). */
async function readProject(rtacDir) {
  const root = path.join(rtacDir, 'SEL_RTAC');
  const structs = new Map(); // lowercased struct -> { struct, sections, kind }
  const definitions = [];
  for (const file of await listXml(root)) {
    const xml = await readFile(file, 'utf8');
    const isDevice = xml.includes('<Device>');
    const isMap = xml.includes('<TagList>');
    if (isDevice && /<Protocol>DNPClient<\/Protocol>/.test(xml) || isMap) {
      const sections = readTagSections(xml);
      for (const [kind, tags] of Object.entries(sections)) {
        for (const tag of tags) {
          const key = tag.struct.toLowerCase();
          let entry = structs.get(key);
          if (!entry) {
            entry = {
              struct: tag.struct,
              kind: isMap ? 'map' : 'client',
              file: path.relative(rtacDir, file),
              sections: { BI: [], AI: [], BO: [] },
            };
            structs.set(key, entry);
          }
          entry.sections[kind].push(tag);
        }
      }
    } else if (/[\\/]DeviceDefinitions[\\/]/i.test(file) && xml.includes('<GVL>')) {
      const body = /<Content><!\[CDATA\[([\s\S]*?)\]\]>/.exec(xml)?.[1] ?? '';
      definitions.push(...declaredVariables(body));
    }
  }

  const initDir = path.join(root, 'DAC', 'Initializations');
  const initFiles = await readdir(initDir).catch(() => []);
  const pous = {};
  for (const [kind, pattern] of Object.entries(POU_PATTERNS)) {
    pous[kind] = initFiles.find((name) => pattern.test(name)) ?? null;
  }

  let profiles = [];
  let recloserDefs = [];
  if (pous.reclosers) {
    const impl = readImplementation(await readFile(path.join(initDir, pous.reclosers), 'utf8'));
    profiles = recloserProfiles(impl);
    const def = /DeviceDefinition\s*:=\s*(\w+)/gi;
    for (let m = def.exec(impl); m; m = def.exec(impl)) recloserDefs.push(m[1]);
  }

  const interconnect = await readInterconnect(rtacDir, pous.connectors);
  return { structs: [...structs.values()], definitions, pous, profiles, recloserDefs, interconnect };
}

// --- questions the generators ask --------------------------------------------

/** Is `name` a device definition this project declares? */
function hasDefinition(project, name) {
  const key = String(name).toLowerCase();
  return project.definitions.some((def) => def.name.toLowerCase() === key);
}

/** The project's definition of a kind (the first declared), or null. */
function definitionOf(project, kind) {
  return project.definitions.find((def) => DEF_TYPES[kind].test(def.type))?.name ?? null;
}

/**
 * The voltage family the project's reclosers are written in: 34.5kV schemes
 * use the RecDef_* definitions, 13.2kV the Rec_SEL_651R_* ones. Counted from
 * the reclosers already initialized (a project can declare both families);
 * failing that, from what the project declares.
 */
function voltageFamily(project) {
  const rec = project.recloserDefs.map((name) => name.toLowerCase());
  const high = rec.filter((name) => name.startsWith('recdef_')).length;
  const low = rec.filter((name) => name.startsWith('rec_sel_')).length;
  if (high || low) return high > low ? '34.5kV' : '13.2kV';
  if (hasDefinition(project, 'RecDef_Standard')) return '34.5kV';
  return '13.2kV';
}

/** Point counts most of the project's reclosers of this shape use, or null. */
function commonProfile(project, shared) {
  const tally = new Map();
  for (const profile of project.profiles) {
    if (profile.shared !== shared) continue;
    const key = profile.counts.join(',');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  return best ? best[0].split(',') : null;
}

/**
 * Groups of tags that may belong to device `id`, as { entry, group } pairs —
 * one per distinct struct + group prefix. `where` narrows by struct kind
 * ('client' | 'map') and optionally to one struct; `accept(groupTokens,
 * structTokens)` decides whether the group names the device.
 */
function findGroups(project, { kind, struct, accept }) {
  const out = [];
  const wanted = struct ? struct.toLowerCase() : null;
  for (const entry of project.structs) {
    if (entry.kind !== kind) continue;
    if (wanted && entry.struct.toLowerCase() !== wanted) continue;
    const structTokens = tokens(entry.struct).filter((t) => t !== 'dnp');
    const seen = new Set();
    // A group can live in one section only (a breaker's BKR_… outputs).
    for (const tag of [...entry.sections.BI, ...entry.sections.AI, ...entry.sections.BO]) {
      if (tag.group == null) continue;
      const key = tag.group.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (accept(tokens(tag.group), structTokens)) out.push({ entry, group: tag.group });
    }
  }
  return out;
}

/** The first tag of the group(s) in each section, as ADR() pointer text (or null). */
function firstTags(entry, group) {
  const keys = new Set([group].flat().map((g) => g.toLowerCase()));
  const pick = (section) => {
    const tag = entry.sections[section].find((t) => t.group != null && keys.has(t.group.toLowerCase()));
    return tag ? `ADR(${tag.struct}.${tag.member})` : null;
  };
  return { bi: pick('BI'), ai: pick('AI'), bo: pick('BO') };
}

/** The first tag in groups naming the device whose member matches `pattern`. */
function namedTag(project, section, groups, pattern) {
  for (const { entry, group } of groups) {
    const key = group.toLowerCase();
    const tag = entry.sections[section].find((t) => t.group != null
      && t.group.toLowerCase() === key && pattern.test(t.member));
    if (tag) return `ADR(${tag.struct}.${tag.member})`;
  }
  return null;
}

const describe = (groups) => groups.map(({ entry, group }) => `${entry.struct}.${group}`).join(', ');

/** A device's DNP client struct given what the row names it ("X" or "X_DNP"). */
function clientStruct(project, name) {
  if (!name) return null;
  const key = String(name).toLowerCase().replace(/_dnp$/, '');
  return project.structs.find((entry) => entry.kind === 'client'
    && entry.struct.toLowerCase().replace(/_dnp$/, '') === key) ?? null;
}

/**
 * The DNP client a substation's transformer reports through, found by the
 * substation's name: every client whose name holds it ("Goodbee" ->
 * Goodbee_Sub, Abita_Springs_Sub). Several narrow to the ones named for a
 * substation (with "Sub" in the name), then to the ones without a device
 * number in them (not a shared recloser client like ST_MARY_3166_3168).
 * Returns { client } or { problem, candidates }.
 */
function substationClient(project, substation) {
  const key = String(substation ?? '').trim().replace(/\s+/g, '_').toLowerCase();
  if (!key) return { problem: 'no substation given', candidates: [] };
  let found = project.structs.filter((e) => e.kind === 'client')
    .map((e) => e.struct.replace(/_DNP$/i, ''))
    .filter((name) => name.toLowerCase().includes(key));
  for (const narrow of [(n) => /(^|_)sub(_|$)/i.test(n), (n) => !/\d{3,}/.test(n)]) {
    if (found.length > 1 && found.some(narrow)) found = found.filter(narrow);
  }
  if (found.length === 1) return { client: found[0] };
  return {
    problem: found.length ? `several DNP clients name ${substation} (${found.join(', ')})` : `no DNP client names ${substation}`,
    candidates: found,
  };
}

// Group prefixes that name something other than a recloser.
const NOT_RECLOSER = new Set(['fdr', 'feeder', 'bkr', 'dac', 'xfmr']);

/**
 * Where a recloser's field points live: its own client ("SEL_651R2_048_DNP.
 * BI_00000_…", group "") or its slot on a shared one ("…_DNP._3166_BI_…",
 * group "_3166_"). Returns { struct, field, shared } or { problem }.
 */
function recloserField(project, number, client) {
  const n = String(number).toLowerCase();
  const names = [n, `r${n}`];
  const named = (list) => names.some((name) => list.includes(name));
  // Its own client carries ungrouped tags and has the number in its name; a
  // shared client gives each recloser a group with the number in it.
  const accept = (groupTokens, structTokens) => (groupTokens.length
    ? named(groupTokens) && !NOT_RECLOSER.has(groupTokens[0])
    : named(structTokens));
  let groups;
  if (client) {
    const entry = clientStruct(project, client);
    if (!entry) return { problem: `no DNP client named ${client}` };
    groups = findGroups(project, { kind: 'client', struct: entry.struct, accept: (g) => !g.length || named(g) });
    const slot = groups.filter(({ group }) => tokens(group).length);
    if (slot.length) groups = slot;
  } else {
    groups = findGroups(project, { kind: 'client', accept });
  }
  // One client can list a recloser under two prefixes (SUNSET_ST_6057_6055:
  // SEL_651R2_6055_BI_… and _6055_AI_…); each pointer is then the first of
  // its section across both.
  if (!groups.length) return { problem: 'no DNP client carries its points' };
  const { entry } = groups[0];
  if (groups.some((candidate) => candidate.entry !== entry)) {
    return { problem: `several clients carry it (${describe(groups)})` };
  }
  const prefixes = groups.map(({ group }) => group);
  return {
    struct: entry.struct, entry, prefixes,
    field: firstTags(entry, prefixes), shared: prefixes.some((g) => tokens(g).length > 0),
  };
}

/** A recloser's group on the SCADA map(s): "SEL_651R2_048_" / "SEL_651R2_R048_". */
function recloserScada(project, number) {
  const n = String(number).toLowerCase();
  const groups = findGroups(project, {
    kind: 'map',
    accept: (g) => !NOT_RECLOSER.has(g[0]) && !g.includes('connector') && (g.includes(n) || g.includes(`r${n}`)),
  });
  if (groups.length !== 1) {
    return { problem: groups.length ? `several SCADA map groups name it (${describe(groups)})` : 'no SCADA map has its points' };
  }
  const [{ entry, group }] = groups;
  return { scada: firstTags(entry, group) };
}

/** Map groups naming a feeder/breaker number: FDR_4473A_, FEEDER_6878_, BKR_5615A_. */
function feederGroups(project, number) {
  const n = String(number).toLowerCase();
  return findGroups(project, { kind: 'map', accept: (g) => g.includes(n) && !g.includes('dac') });
}

/** A feeder's SCADA link: its Armed status and Exclude command. */
function feederScada(project, number) {
  const groups = feederGroups(project, number);
  const bi = namedTag(project, 'BI', groups, /_armed$/i);
  const bo = namedTag(project, 'BO', groups, /exclude_cmd$/i);
  return { bi, bo };
}

/** A breaker's SCADA link: its command-timeout status and inhibit command. */
function breakerScada(project, number) {
  // A dedicated BKR_… group wins over the breaker points on the FDR_… group.
  const groups = feederGroups(project, number)
    .sort((a, b) => Number(tokens(b.group)[0] === 'bkr') - Number(tokens(a.group)[0] === 'bkr'));
  const bi = namedTag(project, 'BI', groups, /commandtimeout$/i);
  const bo = namedTag(project, 'BO', groups, /inhibit(control)?_cmd$/i);
  return { bi, bo };
}

/** A substation breaker's field points: its group on the substation client. */
function breakerField(project, number, client) {
  const n = String(number).toLowerCase();
  const entry = clientStruct(project, client);
  // A breaker on its own relay client has ungrouped tags (SEL_651R2_5488A_DNP.BI_…).
  const accept = (g, structTokens) => (g.length ? g.includes(n) : structTokens.includes(n));
  const groups = entry
    ? findGroups(project, { kind: 'client', struct: entry.struct, accept })
    : findGroups(project, { kind: 'client', accept: (g) => g.includes(n) && ['bkr', 'brk'].includes(g[0]) });
  if (groups.length !== 1) {
    const where = entry ? `on ${entry.struct}` : 'on any client';
    return { problem: groups.length ? `several groups ${where} name it (${describe(groups)})` : `no breaker points ${where}` };
  }
  const [{ entry: host, group }] = groups;
  return { struct: host.struct, field: firstTags(host, group) };
}

/**
 * The naming the project's SCADA map(s) already use, for devices whose points
 * aren't configured yet: the map carrying the most recloser groups, and the
 * prefix its feeder groups go by (FDR_ or FEEDER_).
 */
function conventions(project) {
  const maps = project.structs.filter((entry) => entry.kind === 'map');
  const tally = (values) => {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const recloserGroups = (entry) => new Set(entry.sections.BI
    .filter((t) => t.group && !NOT_RECLOSER.has(tokens(t.group)[0])).map((t) => t.group.toLowerCase())).size;
  const map = maps.sort((a, b) => recloserGroups(b) - recloserGroups(a))[0];
  const feederPrefix = tally(maps.flatMap((entry) => entry.sections.BI)
    .filter((t) => t.group && /_armed$/i.test(t.member))
    .map((t) => t.group.split('_')[0].toUpperCase()));
  return { scadaMap: map ? map.struct.replace(/_DNP$/i, '') : null, feederPrefix };
}

export {
  readProject, parseTag, conventions, hasDefinition, definitionOf, voltageFamily, commonProfile, clientStruct,
  substationClient,
  recloserField, recloserScada, feederScada, breakerScada, breakerField,
  POU_PATTERNS,
};
