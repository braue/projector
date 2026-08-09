// SW switch -> DeviceProfile.
//
// A switch settings export states where the switch answers (management
// addresses, and which services listen on each) and what its physical ports
// are set to (enabled, speed, VLAN membership). The addresses become
// interfaces + management server endpoints so IP-based linking works like any
// other device; the ports become the profile's `ports` inventory — what a
// manually drawn connection plugs into (see linker.js's manual pass).
//
// `kind: 'switch'` marks the profile as network fabric: the canvas renders it
// differently and offers its ports in the connect dialog.

import { switchName } from '../../parsers/sw/index.js';
import { endpointLines } from '../model.js';

// "/24" -> "255.255.255.0"; null when the export states no prefix.
function prefixToMask(prefix) {
  if (prefix === null || prefix === undefined) return null;
  const bits = 0xffffffff << (32 - prefix);
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join('.');
}

const MANAGEMENT_SERVICES = {
  HTTPS: { protocol: 'HTTPS', transport: 'tcp', localPort: 443 },
  SNMP: { protocol: 'SNMP', transport: 'udp', localPort: 161 },
};

function managementEndpoints(model) {
  const endpoints = [];
  for (const iface of model.interfaces) {
    for (const address of iface.addresses) {
      for (const service of address.services) {
        const known = MANAGEMENT_SERVICES[service];
        if (!known || !address.ip) continue;
        const endpoint = {
          id: `mgmt:${iface.id}/${address.ip}/${service}`,
          name: `${service} on ${iface.id}`,
          role: 'server',
          protocol: known.protocol,
          transport: known.transport,
          localPort: known.localPort,
          addressing: {},
        };
        endpoint.lines = [`${service} management on ${address.ip}`, ...endpointLines(endpoint)];
        endpoints.push(endpoint);
      }
    }
  }
  return endpoints;
}

// The port inventory the manual-connection dialog and linker read: identity,
// state, and which VLANs ride the port. Tagged membership is verbatim from
// the VLAN table. Untagged membership adds one 802.1Q rule the export leaves
// implicit: a port with no untagged assignment belongs to the default VLAN
// untagged (its PVID stays 1) — so default-VLAN traffic checks correctly.
function portInventory(model) {
  const defaultVid = model.vlans.find((vlan) => vlan.isDefault)?.vid ?? null;
  return model.ports.map((port) => {
    const untagged = model.vlans
      .filter((vlan) => vlan.untaggedPorts.includes(port.number))
      .map((vlan) => vlan.vid);
    if (!untagged.length && defaultVid !== null) untagged.push(defaultVid);
    return {
      id: port.id ?? `port ${port.number}`,
      name: port.name,
      enabled: port.enabled,
      speed: port.speed,
      taggedVlans: model.vlans.filter((vlan) => vlan.taggedPorts.includes(port.number)).map((vlan) => vlan.vid),
      untaggedVlans: untagged,
    };
  });
}

// Input is SwService.profile(ref) output — for a switch the model IS the
// profile (one per file).
function extractSwProfile({ fileId, model }, ref) {
  return {
    name: switchName(model, fileId),
    manufacturer: 'SEL',
    model: model.nameplate.type ?? 'switch',
    kind: 'switch',
    source: { type: 'sw', ref },
    interfaces: model.interfaces.flatMap((iface) =>
      iface.addresses.map((address) => ({
        kind: 'ethernet',
        name: address.alias && address.alias !== iface.id ? `${iface.id} (${address.alias})` : iface.id,
        ip: address.ip,
        mask: prefixToMask(address.prefix),
        gateway: model.defaultGateway,
      }))),
    endpoints: managementEndpoints(model),
    ports: portInventory(model),
  };
}

export { extractSwProfile };
