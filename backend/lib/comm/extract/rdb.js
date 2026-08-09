// RDB relay profile -> DeviceProfile.
//
// SEL relay settings are flat KEY,"VALUE" pairs grouped in sections, and the
// setting names that matter for communications follow family conventions
// (IPADDR, DNPADR, ...). This extractor is a RULE TABLE over those names —
// deliberately front-and-center so it can be tuned the moment real files show
// a variant spelling. Every rule degrades gracefully: an IP with no port
// still yields an interface (the linker then matches on IP alone, tier
// 'probable'), and a section nothing matches is simply not a comm setting.

import { relayType } from '../../parsers/rdb/index.js';
import { firstSetting } from '../../settings.js';
import { endpointLines } from '../model.js';

// --- the rule table -----------------------------------------------------------

// A section owning any of these declares an ethernet interface.
const IP_KEYS = ['IPADDR'];
const MASK_KEYS = ['SUBNETM', 'SUBMASK', 'SUBNETMASK'];
const GATEWAY_KEYS = ['DEFRTR', 'GATEWAY', 'IPGATE', 'DEFGW'];

// Protocol servers a relay can expose, recognized by their address/enable
// settings. `port` lists known port-setting spellings, first hit wins.
const SERVER_RULES = [
  {
    protocol: 'DNP',
    address: ['DNPADR'],
    port: ['DNPTPRT', 'DNPUPRT', 'DNPPORT', 'DNPNUM'],
    addressing: (value) => ({ selfDnp: value }),
  },
  {
    protocol: 'Modbus',
    address: ['MODADR', 'MBADR', 'SLAVEID'],
    port: ['MBTPRT', 'MBPORT', 'MODPORT'],
    addressing: (value) => ({ modbusUnit: value }),
  },
];

// A section with a baud-rate setting is a serial port; PROTO names what runs
// on it (SEL, DNP, MOD, ...) and the framing keys fill in the line settings.
const BAUD_KEYS = ['SPEED', 'BAUD'];
const SERIAL_PROTO_KEYS = ['PROTO', 'PROTOCOL'];
const DATA_BITS_KEYS = ['BITS', 'DATABIT'];
const PARITY_KEYS = ['PARITY'];
const STOP_BITS_KEYS = ['STOPBIT', 'STOP'];

const PROTO_FAMILY = { MOD: 'Modbus', MODBUS: 'Modbus', DNP: 'DNP', SEL: 'SEL' };

// -----------------------------------------------------------------------------

function extractRdbProfile(profile, ref) {
  const interfaces = [];
  const endpoints = [];

  for (const section of profile.sections ?? []) {
    const settings = section.settings ?? {};
    const sectionName = section.desc ?? section.key;

    const ip = firstSetting(settings, IP_KEYS);
    if (ip) {
      interfaces.push({
        kind: 'ethernet',
        name: sectionName,
        ip,
        mask: firstSetting(settings, MASK_KEYS),
        gateway: firstSetting(settings, GATEWAY_KEYS),
      });
    }

    for (const rule of SERVER_RULES) {
      const address = firstSetting(settings, rule.address);
      if (!address) continue;
      const endpoint = {
        id: `${section.key}:${rule.protocol}`,
        name: `${rule.protocol} server (${sectionName})`,
        role: 'server',
        protocol: rule.protocol,
        transport: 'tcp',
        remoteAddress: null,
        remotePort: null,
        localPort: firstSetting(settings, rule.port),
        serial: null,
        addressing: rule.addressing(address),
      };
      endpoint.lines = endpointLines(endpoint);
      endpoints.push(endpoint);
    }

    const baud = firstSetting(settings, BAUD_KEYS);
    if (baud) {
      const proto = firstSetting(settings, SERIAL_PROTO_KEYS)?.toUpperCase() ?? null;
      const endpoint = {
        id: `${section.key}:serial`,
        name: sectionName,
        role: 'server',
        protocol: proto ? (PROTO_FAMILY[proto] ?? proto) : 'SEL',
        transport: 'serial',
        serial: {
          port: sectionName,
          baud,
          dataBits: firstSetting(settings, DATA_BITS_KEYS),
          parity: firstSetting(settings, PARITY_KEYS),
          stopBits: firstSetting(settings, STOP_BITS_KEYS),
        },
        addressing: {},
      };
      endpoint.lines = endpointLines(endpoint);
      endpoints.push(endpoint);
    }
  }

  return {
    name: profile.name,
    manufacturer: 'SEL',
    model: relayType(profile) ?? 'relay',
    source: { type: 'rdb', ref },
    interfaces,
    endpoints,
  };
}

export { extractRdbProfile };
