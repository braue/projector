// RTAC project model -> DeviceProfile.
//
// An RTAC export describes one RTAC and every connection it owns. Each
// connection item (category 'connection') becomes one endpoint; the shared
// endpoint-setting vocabulary in parsers/rtac/endpoints.js names where it
// points. The RTAC's own NIC addresses are not stated per-connection in the
// export, so interfaces stay empty for now — the linker matches on what
// clients dial, which the export does state.

import {
  RTAC_BAUD_SETTING,
  RTAC_LOCAL_PORT_SETTINGS,
  RTAC_REMOTE_ADDRESS_SETTINGS,
  RTAC_REMOTE_PORT_SETTINGS,
  RTAC_SERIAL_PORT_SETTING,
} from '../../parsers/rtac/endpoints.js';
import { endpointLines } from '../model.js';

function firstSetting(settings, keys) {
  for (const key of keys) {
    const value = (settings[key] ?? '').trim();
    if (value) return value;
  }
  return null;
}

// DNP addressing is stated from the connection's own point of view: a client
// connection's "Client DNP Address" is the RTAC itself, its "Server DNP
// Address" is the far end — and on a server connection the same two names
// swap owners.
function dnpAddressing(item) {
  const client = (item.settings['Client DNP Address'] ?? '').trim() || null;
  const server = (item.settings['Server DNP Address'] ?? '').trim() || null;
  if (client == null && server == null) return {};
  if (item.role === 'server') return { selfDnp: server, peerDnp: client };
  return { selfDnp: client, peerDnp: server };
}

function extractEndpoint(item) {
  const settings = item.settings ?? {};
  const transport = item.connectionType === 'Serial' ? 'serial' : 'tcp';

  const endpoint = {
    id: item.file,
    name: item.name,
    role: item.role ?? 'client',
    protocol: item.protocolFamily ?? item.protocol ?? null,
    transport,
    remoteAddress: transport === 'tcp' ? firstSetting(settings, RTAC_REMOTE_ADDRESS_SETTINGS) : null,
    remotePort: transport === 'tcp' ? firstSetting(settings, RTAC_REMOTE_PORT_SETTINGS) : null,
    localPort: transport === 'tcp' ? firstSetting(settings, RTAC_LOCAL_PORT_SETTINGS) : null,
    serial:
      transport === 'serial'
        ? {
            port: (settings[RTAC_SERIAL_PORT_SETTING] ?? '').trim() || null,
            baud: (settings[RTAC_BAUD_SETTING] ?? '').trim() || null,
            dataBits: (settings['Data Bits'] ?? '').trim() || null,
            parity: (settings['Parity Bit'] ?? '').trim() || null,
            stopBits: (settings['Stop Bit'] ?? '').trim() || null,
          }
        : null,
    addressing: {
      ...dnpAddressing(item),
      ...((settings['Slave ID'] ?? '').trim() ? { modbusUnit: settings['Slave ID'].trim() } : {}),
    },
  };
  endpoint.lines = endpointLines(endpoint);
  return endpoint;
}

// `model` is parseRtacProject output; `ref` the project name in the database.
// The database name is the identity — two projects can carry the same
// internal NavigatorLayout name (a copied project keeps it), and the canvas
// must tell them apart.
function extractRtacProfile(model, ref) {
  return {
    name: ref,
    internalName: model.name ?? null,
    manufacturer: 'SEL',
    model: model.deviceMOT ? `SEL-${model.deviceMOT}` : 'RTAC',
    source: { type: 'rtac', ref },
    interfaces: [],
    endpoints: model.items
      .filter((item) => item.category === 'connection')
      // System-role connections (access points, NGVL, EtherCAT I/O) are the
      // RTAC's own plumbing, not links to other stations' equipment.
      .filter((item) => item.role === 'client' || item.role === 'server' || item.role === 'peer')
      .map(extractEndpoint),
  };
}

export { extractRtacProfile };
