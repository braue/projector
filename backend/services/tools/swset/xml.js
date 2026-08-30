// SWSET XML primitives — ported from the old SWSET tool's functions.py.
// The device Configuration XML is SEL's nested CompositeSetting/Setting
// shape; collectSettings() flattens it into a nested plain object for reads,
// and xmlSet() writes values back into the ORIGINAL parsed document so the
// output XML is the input with only the edits applied.
//
// Parsing mirrors Python's xmltodict ('@' attribute prefix, '#text'), which
// the path vocabulary in the schema depends on.

import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// Internal enum token <-> display label. Reads translate token -> label;
// writes translate the label back before touching the XML.
const TRANSLATIONS = {
  IO_ALM_PULSE: 'Pulse',
  IO_ALM_LATCH_AUTO: 'Latch (Automatic Clear)',
  IO_ALM_LATCH_MANUAL: 'Latch (Manual Clear)',
  STP_RSTP_MODE: 'RSTP',
  STP_OFF: 'OFF',
  CS_PRI_LOW: 'Low',
  CS_PRI_MEDIUM: 'Medium',
  CS_PRI_HIGH: 'High',
  CS_PRI_CRITICAL: 'Critical',
  RL_NO_LIMIT: 'No Limit',
  RL_BROADCAST: 'Broadcast',
  STP_EDGE_MODE: 'Fast Port',
  STP_EDGE_BPDU_GRD: 'Fast Port BPDU Guard',
  STP_NON_STP_BPDU_GRD: 'Non-STP BPDU Guard',
  STP_AUTO: 'Auto',
  PRTS_10M_HALF: '10Mbps Half Duplex',
  PRTS_10M_FULL: '10Mbps Full Duplex',
  PRTS_100M_HALF: '100Mbps Half Duplex',
  PRTS_100M_FULL: '100Mbps Full Duplex',
  PRTS_UNINSTALLED: 'Uninstalled',
  PRTS_AUTO: 'Auto',
  RL_MULTICAST: 'Multicast and Broadcast',
  CS_VAL_WRR: 'Weighted Round Robin',
  CS_VAL_STRICT: 'Strict',
  RL_UNKNWN_UCAST: 'Flooded Unicast, Multicast, and Broadcast',
  SL_INFORMATIONAL: 'Informational',
  SL_ALERT: 'Alert',
  SL_CRITICAL: 'Critical',
  SL_ERROR: 'Error',
  SL_NOTICE: 'Notice',
  SL_WARNING: 'Warning',
  PRTS_1G_FULL: '1Gbps Full Duplex',
  RL_1: '1 Mb',
  RL_5: '5 Mb',
  RL_10: '10 Mb',
  RL_20: '20 Mb',
  RL_30: '30 Mb',
  RL_42: '42 Mb',
  RL_50: '50 Mb',
  RL_65: '65 Mb',
  RL_85: '85 Mb',
  RL_500_KBPS: '500 Kb',
  UM_ADMINISTRATOR: 'Admin',
  UM_ENGINEER: 'Engineer',
  UM_USER_MANAGER: 'User Manager',
  UM_MONITOR: 'Monitor',
};

const REVERSE_TRANSLATIONS = (() => {
  const reverse = {};
  for (const [token, label] of Object.entries(TRANSLATIONS)) {
    if (label && !(label in reverse)) reverse[label] = token;
  }
  return reverse;
})();

const ensureList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const attr = (node, key) => node[`@${key}`] ?? node[key];
const asValue = (v) => {
  if (v != null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return null;
  return v === '' ? null : v;
};

/** Nested plain object from the Configuration element: composites become
 *  nested dicts keyed by name (with optional instance keys), leaves name:value. */
function collectSettings(configuration) {
  const containers = (node) => {
    const c = node?.Settings;
    if (Array.isArray(c)) return c.filter((x) => x != null && typeof x === 'object');
    if (c != null && typeof c === 'object') return [c];
    return [];
  };
  const walk = (node) => {
    const out = {};
    if (node == null || typeof node !== 'object') return out;
    for (const c of containers(node)) {
      for (const cs of ensureList(c.CompositeSetting)) {
        if (cs == null || typeof cs !== 'object') continue;
        const name = attr(cs, 'name');
        const instance = attr(cs, 'instance');
        const child = walk(cs);
        if (!name) {
          Object.assign(out, child);
          continue;
        }
        const bucket = (out[name] ??= {});
        if (instance != null && instance !== '') {
          Object.assign((bucket[String(instance)] ??= {}), child);
        } else {
          Object.assign(bucket, child);
        }
      }
      for (const s of ensureList(c.Setting)) {
        if (s == null || typeof s !== 'object') continue;
        const leaf = attr(s, 'name');
        if (leaf == null) continue;
        out[leaf] = asValue(s.Value);
      }
    }
    return out;
  };
  return walk(configuration);
}

/** Deep-get over the collected settings; enum leaves come back translated. */
function xmlGet(tree, path, fallback = '') {
  let cur = tree;
  for (const k of path) {
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
      if (k in cur) {
        cur = cur[k];
      } else if (typeof k === 'number' && String(k) in cur) {
        cur = cur[String(k)];
      } else {
        return fallback;
      }
    } else if (Array.isArray(cur)) {
      const idx = typeof k === 'number' ? k : /^\d+$/.test(String(k)) ? Number(k) : null;
      if (idx === null || idx < 0 || idx >= cur.length) return fallback;
      cur = cur[idx];
    } else {
      return fallback;
    }
  }
  if (cur != null && typeof cur === 'string' && cur in TRANSLATIONS) return TRANSLATIONS[cur];
  return cur;
}

/**
 * Set a value into the ORIGINAL parsed document (not the collected view).
 * Path: composite names (an int/digit-string after a name selects that
 * @instance), last element the Setting name. create=false only writes where
 * the full path exists. Returns whether the write landed.
 */
function xmlSet(cfg, path, value, { create = false, translateBack = true } = {}) {
  if (value === '') value = null;
  if (translateBack && value != null && value in REVERSE_TRANSLATIONS) {
    value = REVERSE_TRANSLATIONS[value];
  }
  let node = cfg;
  if (node == null || typeof node !== 'object' || !Array.isArray(path) || path.length < 2) return false;

  let i = 0;
  while (i < path.length - 1) {
    const name = path[i];
    let instance = null;
    if (i + 1 < path.length - 1) {
      const next = path[i + 1];
      if (typeof next === 'number' || /^\d+$/.test(String(next))) {
        instance = Number(next);
        i += 1;
      }
    }

    let settingsNode = node.Settings;
    if (create) {
      if (settingsNode == null) {
        node.Settings = settingsNode = {};
      } else if (Array.isArray(settingsNode)) {
        settingsNode = settingsNode.length && typeof settingsNode[0] === 'object' ? settingsNode[0] : {};
        node.Settings = settingsNode;
      } else if (typeof settingsNode !== 'object') {
        node.Settings = settingsNode = {};
      }
    } else {
      if (settingsNode == null || typeof settingsNode !== 'object') return false;
      settingsNode = Array.isArray(settingsNode)
        ? (settingsNode.length ? settingsNode[0] : null)
        : settingsNode;
      if (settingsNode == null || typeof settingsNode !== 'object') return false;
    }

    let comps = settingsNode.CompositeSetting;
    if (create) {
      if (comps == null) {
        settingsNode.CompositeSetting = comps = [];
      } else if (!Array.isArray(comps)) {
        settingsNode.CompositeSetting = comps = typeof comps === 'object' ? [comps] : [];
      }
    }
    if (comps != null && !Array.isArray(comps)) comps = [comps];

    let target = null;
    if (Array.isArray(comps)) {
      for (const entry of comps) {
        if (entry == null || typeof entry !== 'object' || attr(entry, 'name') !== name) continue;
        if (instance === null && !('@instance' in entry) && !('instance' in entry)) {
          target = entry;
          break;
        }
        if (instance !== null) {
          const entryInstance = attr(entry, 'instance');
          if (entryInstance != null && Number(entryInstance) === instance) {
            target = entry;
            break;
          }
        }
      }
    }
    if (target === null) {
      if (!create) return false;
      target = { '@name': name };
      if (instance !== null) target['@instance'] = String(instance);
      if (!Array.isArray(settingsNode.CompositeSetting)) {
        settingsNode.CompositeSetting = ensureList(settingsNode.CompositeSetting);
      }
      settingsNode.CompositeSetting.push(target);
    }

    node = target;
    i += 1;
  }

  let settingsNode = node.Settings;
  if (create) {
    if (settingsNode == null || typeof settingsNode !== 'object' || Array.isArray(settingsNode)) {
      node.Settings = settingsNode = {};
    }
  } else if (settingsNode == null || typeof settingsNode !== 'object' || Array.isArray(settingsNode)) {
    return false;
  }

  let leaves = settingsNode.Setting;
  if (leaves == null) {
    if (!create) return false;
    settingsNode.Setting = leaves = [];
  } else if (!Array.isArray(leaves)) {
    if (typeof leaves === 'object') {
      leaves = settingsNode.Setting = [leaves];
    } else {
      if (!create) return false;
      settingsNode.Setting = leaves = [];
    }
  }

  const leafName = path[path.length - 1];
  let leaf = leaves.find((s) => s != null && typeof s === 'object' && attr(s, 'name') === leafName);
  if (!leaf) {
    if (!create) return false;
    leaf = { '@name': leafName, Value: null };
    leaves.push(leaf);
  }
  leaf.Value = value;
  return true;
}

// xmltodict-compatible parse: '@' attribute prefix, '#text', everything as
// strings — the settings are text values and must round-trip untouched.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  format: true,
  indentBy: '  ',
  suppressBooleanAttributes: false,
});

function parseConfigXml(text) {
  return parser.parse(text);
}

function buildConfigXml(doc) {
  // The builder prints null as the string "null"; SEL empty values are empty
  // elements. Swap nulls for '' on a copy.
  const scrub = (node) => {
    if (Array.isArray(node)) return node.map(scrub);
    if (node != null && typeof node === 'object') {
      const out = {};
      for (const [key, value] of Object.entries(node)) out[key] = scrub(value);
      return out;
    }
    return node == null ? '' : node;
  };
  return `<?xml version="1.0" encoding="utf-8"?>\n${builder.build(scrub(doc))}`;
}

export {
  TRANSLATIONS,
  REVERSE_TRANSLATIONS,
  collectSettings,
  xmlGet,
  xmlSet,
  parseConfigXml,
  buildConfigXml,
};
