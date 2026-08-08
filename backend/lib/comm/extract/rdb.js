// RDB relay profile -> DeviceProfile.
//
// SEL relay settings are flat KEY,"VALUE" pairs grouped in sections, and the
// setting names that matter for communications follow family conventions
// (IPADDR, DNPADR, ...). This extractor is a RULE TABLE over those names —
// deliberately front-and-center so it can be tuned the moment real files show
// a variant spelling. Every rule degrades gracefully: an IP with no port
// still yields an interface (the linker then matches on IP alone, tier
// 'probable'), and a section nothing matches is simply not a comm setting.

import { endpointLines } from '../model.js';

// --- the rule table -----------------------------------------------------------

// A section owning any of these declares an ethernet interface.
const IP_KEYS = ['IPADDR'];
const MASK_KEYS = ['SUBNETM', 'SUBMASK', 'SUBNETMASK'];

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
// on it (SEL, DNP, MOD, ...).
const BAUD_KEYS = ['SPEED', 'BAUD'];
const SERIAL_PROTO_KEYS = ['PROTO', 'PROTOCOL'];

// -----------------------------------------------------------------------------

function firstKey(settings, keys) {
  for (const key of keys) {
    const value = (settings[key] ?? '').trim();
    if (value) return { key, value };
  }
  return null;
}

const PROTO_FAMILY = { MOD: 'Modbus', MODBUS: 'Modbus', DNP: 'DNP', SEL: 'SEL' };

function extractRdbProfile(profile, ref) {
  const interfaces = [];
  const endpoints = [];

  for (const section of profile.sections ?? []) {
    const settings = section.settings ?? {};
    const sectionName = section.desc ?? section.key;

    const ip = firstKey(settings, IP_KEYS);
    if (ip) {
      interfaces.push({
        kind: 'ethernet',
        name: sectionName,
        ip: ip.value,
        mask: firstKey(settings, MASK_KEYS)?.value ?? null,
      });
    }

    for (const rule of SERVER_RULES) {
      const address = firstKey(settings, rule.address);
      if (!address) continue;
      const endpoint = {
        id: `${section.key}:${rule.protocol}`,
        name: `${rule.protocol} server (${sectionName})`,
        role: 'server',
        protocol: rule.protocol,
        transport: 'tcp',
        remoteAddress: null,
        remotePort: null,
        localPort: firstKey(settings, rule.port)?.value ?? null,
        serial: null,
        addressing: rule.addressing(address.value),
      };
      endpoint.lines = endpointLines(endpoint);
      endpoints.push(endpoint);
    }

    const baud = firstKey(settings, BAUD_KEYS);
    if (baud) {
      const proto = firstKey(settings, SERIAL_PROTO_KEYS)?.value?.toUpperCase() ?? null;
      const endpoint = {
        id: `${section.key}:serial`,
        name: sectionName,
        role: 'server',
        protocol: proto ? (PROTO_FAMILY[proto] ?? proto) : 'SEL',
        transport: 'serial',
        serial: {
          port: sectionName,
          baud: baud.value,
          dataBits: firstKey(settings, ['BITS', 'DATABIT'])?.value ?? null,
          parity: firstKey(settings, ['PARITY'])?.value ?? null,
          stopBits: firstKey(settings, ['STOPBIT', 'STOP'])?.value ?? null,
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
    model: profile.info?.RELAYTYPE ?? profile.info?.DEVICETYPE ?? 'relay',
    source: { type: 'rdb', ref },
    interfaces,
    endpoints,
  };
}

export { extractRdbProfile };
