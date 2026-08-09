// Parser for SEL managed-switch settings exports (SEL-2730M) — the
// <Configuration> XML the web UI writes: a Nameplate block plus a tree of
// CompositeSetting/Setting/Value elements.
//
// Comm-truth focused: it models what the canvas and inspect views link on —
//
//   ports        the physical jacks (eth1..ethN): enabled, speed/duplex,
//                user label — what a manual connection plugs into
//   vlans        the default VLAN plus every static VLAN, with the tagged and
//                untagged port-number lists exactly as authored
//   interfaces   management interfaces (Eth F, Mgmt): addresses in CIDR form
//                and which services (HTTPS, SNMP) answer on each
//
// Loss-tolerant like the other parsers: absent sections yield empty lists,
// unknown sections are ignored, and values stay verbatim strings — the
// semantic layer decides how to read "True" or "PRTS_1G_FULL".

import { attr, parseXml, text, toArray } from '../xml.js';

// --- CompositeSetting navigation ----------------------------------------------

// Children of a <Settings> container (the root Configuration.Settings and
// every CompositeSetting.Settings share the shape).
function composites(container) {
  return toArray(container?.CompositeSetting);
}

function composite(container, name) {
  return composites(container).find((node) => attr(node, 'name') === name) ?? null;
}

// <Setting name="X"><Value>v</Value></Setting> siblings -> { X: 'v' }.
function settingValues(node) {
  const out = {};
  for (const setting of toArray(node?.Settings?.Setting)) {
    const name = attr(setting, 'name');
    if (name) out[name] = text(setting.Value);
  }
  return out;
}

// Instanced composites ("static_vlan #0, #1, ...") in instance order.
function instances(node) {
  return composites(node?.Settings).sort(
    (a, b) => Number(attr(a, 'instance') ?? 0) - Number(attr(b, 'instance') ?? 0),
  );
}

// --- value decoding ------------------------------------------------------------

function bool(value) {
  return value === 'True';
}

// "PRTS_1G_FULL" -> "1G full", "PRTS_AUTO" -> "auto" — readable, still terse.
function decodeSpeed(value) {
  if (!value) return null;
  return value.replace(/^PRTS_/, '').replaceAll('_', ' ').toLowerCase().replace(/^(\d+[gm])/, (m) => m.toUpperCase());
}

// VLAN membership lists: "1,2" or "1-4,7" -> [1, 2] / [1, 2, 3, 4, 7].
function portNumbers(value) {
  const out = [];
  for (const token of (value ?? '').split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n += 1) out.push(n);
    } else if (/^\d+$/.test(trimmed)) {
      out.push(Number(trimmed));
    }
  }
  return out;
}

// --- sections -------------------------------------------------------------------

function parseNameplate(nameplate) {
  return {
    type: text(nameplate?.Type) || null,
    fid: text(nameplate?.FID) || null,
    id: text(nameplate?.Id) || null,
    partNumber: text(nameplate?.PartNumber) || null,
    serialNumber: text(nameplate?.SerialNumber) || null,
  };
}

function parsePorts(portSettings) {
  return instances(composite(portSettings?.Settings, 'ports')).map((port, index) => {
    const values = settingValues(port);
    return {
      // VLAN membership lists reference ports by this 1-based number.
      number: Number(attr(port, 'instance') ?? index) + 1,
      id: values.port_id || null,
      name: values.PRTS_NAME_ST || null,
      enabled: bool(values.PRTS_ENABLE_ST),
      speed: decodeSpeed(values.PRTS_SPDDPLX_ST),
    };
  });
}

function parseVlans(vlanSettings) {
  const vlans = [];
  const defaultVlan = composite(vlanSettings?.Settings, 'default_vlan');
  if (defaultVlan) {
    const values = settingValues(defaultVlan);
    vlans.push({
      vid: 1,
      name: values.VL_NAME_ST || 'Default',
      isDefault: true,
      taggedPorts: portNumbers(values.VL_TAGGEDPORTS_ST),
      untaggedPorts: portNumbers(values.VL_UNTAGGEDPORTS_ST),
    });
  }
  for (const vlan of instances(composite(vlanSettings?.Settings, 'static_vlans'))) {
    const values = settingValues(vlan);
    vlans.push({
      vid: values.VL_VID_ST ? Number(values.VL_VID_ST) : null,
      name: values.VL_NAME_ST || null,
      isDefault: false,
      taggedPorts: portNumbers(values.VL_TAGGEDPORTS_ST),
      untaggedPorts: portNumbers(values.VL_UNTAGGEDPORTS_ST),
    });
  }
  const aware = composite(vlanSettings?.Settings, 'vlan_aware_mode');
  return { vlans, vlanAware: aware ? bool(settingValues(aware).VL_AWARE_ST) : null };
}

// A management interface's addresses: "192.168.1.2/24" plus which services
// (HTTPS, SNMP, ...) are switched on for that address.
function parseAddresses(iface) {
  return instances(composite(iface.Settings, 'addresses')).map((address) => {
    const values = settingValues(address);
    const [ip, prefix] = (values.ip_address ?? '').split('/');
    const applications = settingValues(composite(address.Settings, 'applications'));
    return {
      ip: ip || null,
      prefix: prefix ? Number(prefix) : null,
      alias: values.alias || null,
      services: Object.entries(applications)
        .filter(([, value]) => bool(value))
        .map(([name]) => name),
    };
  });
}

function parseInterfaces(networkSettings) {
  return instances(composite(networkSettings?.Settings, 'interfaces')).map((iface) => {
    const values = settingValues(iface);
    return {
      id: values.interface_id || null,
      alias: values.alias || null,
      enabled: bool(values.enabled),
      vlan: values.vlan ? Number(values.vlan) : null,
      addresses: parseAddresses(iface),
    };
  });
}

// Parse one switch settings export (raw XML string) into the SW model.
function parseSw(xmlString) {
  const doc = parseXml(xmlString);
  const config = doc?.Configuration;
  if (!config?.Nameplate) {
    throw new Error('missing <Configuration>/<Nameplate> — not a switch settings export');
  }

  const sections = config.Settings;
  const nameplate = parseNameplate(config.Nameplate);
  const network = settingValues(composite(composite(sections, 'network_settings')?.Settings, 'global_settings'));
  const rstp = settingValues(composite(composite(sections, 'SEL_RSTP')?.Settings, 'Global Settings'));

  const ports = parsePorts(composite(sections, 'port_settings'));
  const { vlans, vlanAware } = parseVlans(composite(sections, 'vlan_settings'));
  const interfaces = parseInterfaces(composite(sections, 'network_settings'));

  return {
    nameplate,
    hostname: network.NI_HOSTNAME_ST || null,
    defaultGateway: network.NI_DEFGW_ST || null,
    rstpMode: rstp.STP_MODE_ST || null,
    ports,
    vlans,
    vlanAware,
    interfaces,
  };
}

// The switch's display name: the operator-assigned nameplate id, the
// hostname when the nameplate is blank, the upload id as a last resort.
// Refs are minted from this — the service and the extractor must agree.
function switchName(model, fallback) {
  return model.nameplate.id ?? model.hostname ?? fallback;
}

export { parseSw, switchName };
