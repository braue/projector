// CommModel — the normalization boundary at the heart of purview.
//
// Every source type (RTAC project, RDB relay profile, SCD IED) reduces to one
// DeviceProfile via an extractor in lib/comm/extract/. The linker and the
// canvas work only on this shape; parsers never feed the canvas directly.
// Adding a new artifact format is one new extractor, nothing else.
//
//   DeviceProfile {
//     name, manufacturer, model,
//     source: { type: 'rtac' | 'rdb' | 'scd', ref },
//     interfaces: [ { kind: 'ethernet' | 'serial', name, ip?, mask?, mac? } ],
//     endpoints:  [ Endpoint ],
//     // Declared-link evidence, when the artifact names both ends of a link
//     // (SCL Inputs today). `identity` is who this profile is within its
//     // document's namespace; each subscription names a publisher in that
//     // same namespace. The linker joins the two — no format knowledge.
//     identity?: { namespace, name },
//     subscriptions?: [ { publisher, serviceType, control,
//                         publisherEndpointId?, points } ],
//   }
//
//   Endpoint {
//     id,                    // stable within the profile (e.g. source file path)
//     name,                  // the connection's own name in its artifact
//     role: 'client' | 'server' | 'peer',
//     protocol,              // family token: DNP, Modbus, SEL, C37118, ...
//     transport: 'tcp' | 'udp' | 'serial',
//     remoteAddress?, remotePort?,   // what a client dials
//     localPort?,                    // what a server listens on / client pins
//     serial?: { port, baud, dataBits, parity, stopBits },
//     addressing: { selfDnp?, peerDnp?, modbusUnit? },
//     lines: [string],       // human-readable port info for the link popup
//   }

function endpointLines(endpoint) {
  const lines = [];
  if (endpoint.transport === 'serial') {
    const serial = endpoint.serial ?? {};
    const framing = [serial.dataBits, serial.parity?.[0], serial.stopBits].filter(Boolean).join('');
    lines.push([serial.port, serial.baud && `${serial.baud} baud`, framing].filter(Boolean).join(' · '));
  } else {
    if (endpoint.role === 'client' && endpoint.remoteAddress) {
      lines.push(`dials ${endpoint.remoteAddress}${endpoint.remotePort ? ` : ${endpoint.remotePort}` : ''}`);
    }
    if (endpoint.role !== 'client' && endpoint.localPort) {
      lines.push(`listens : ${endpoint.localPort}`);
    }
    if (endpoint.role === 'client' && endpoint.localPort) {
      lines.push(`local port ${endpoint.localPort}`);
    }
  }
  const { selfDnp, peerDnp, modbusUnit } = endpoint.addressing ?? {};
  if (selfDnp != null || peerDnp != null) {
    lines.push(`DNP address ${selfDnp ?? '?'}${peerDnp != null ? ` → peer ${peerDnp}` : ''}`);
  }
  if (modbusUnit != null) lines.push(`unit id ${modbusUnit}`);
  return lines;
}

export { endpointLines };
