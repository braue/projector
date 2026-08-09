// CommModel — the normalization boundary at the heart of purview.
//
// Every source type (RTAC project, RDB relay profile, SCD IED) reduces to one
// DeviceProfile via an extractor in lib/comm/extract/. The linker and the
// canvas work only on this shape; parsers never feed the canvas directly.
// Adding a new artifact format is one new extractor, nothing else.
//
//   DeviceProfile {
//     name, manufacturer, model,
//     internalName?,         // the artifact's own name for the device, when
//                            // it differs from the display name (RTAC)
//     source: { type: 'rtac' | 'rdb' | 'scd' | 'sw', ref },
//     kind?: 'switch',       // network fabric, not an end device — the canvas
//                            // renders it differently and offers its ports
//                            // in the manual-connection dialog
//     interfaces: [ { kind: 'ethernet' | 'serial', name, ip?, mask?,
//                     gateway? } ],
//     endpoints:  [ Endpoint ],
//     // Physical port inventory (switches today): what a manually drawn
//     // connection plugs into. The linker checks a drawn link's port against
//     // this list — existence, enabled state, VLAN membership.
//     ports?: [ { id, name?, enabled, speed?,
//                 taggedVlans: [vid], untaggedVlans: [vid] } ],
//     // Declared-link evidence, when the artifact names both ends of a link
//     // (SCL Inputs today). `identity` is who this profile is within its
//     // document's namespace; each subscription names a publisher in that
//     // same namespace. The linker joins the two — no format knowledge.
//     // Identity also suppresses self-collisions in network diagnostics:
//     // the same device placed via two artifacts never collides with itself.
//     identity?: { namespace, name },
//     subscriptions?: [ { publisher, serviceType, control,
//                         publisherEndpointId?, points } ],
//   }
//
//   Endpoint {
//     id,                    // stable within the profile (e.g. source file path)
//     name,                  // the connection's own name in its artifact
//     role: 'client' | 'server' | 'peer',
//     protocol,              // family token: DNP, Modbus, SEL, GOOSE, ...
//     transport: 'tcp' | 'udp' | 'serial' | 'ethernet',  // ethernet = L2
//     remoteAddress?, remotePort?,   // what a client dials
//     localPort?,                    // what a server listens on / client pins
//     serial?: { port, baud, dataBits, parity, stopBits },
//     addressing: { selfDnp?, peerDnp?, modbusUnit? },
//     // Multicast wire identity for L2 publications (GOOSE today; Sampled
//     // Values would use the same fields). `vlanId` is the artifact's raw
//     // spelling (SCL: three hex digits), `vlan` the decoded number the
//     // linker checks against switch VLAN tables and collision diagnostics.
//     goose?: { mac, appId, vlanId, vlan },
//     lines: [string],       // human-readable port info for the link popup
//   }

// Each line is a plain settings statement a non-expert can read aloud —
// "Connects to 192.168.0.4 port 502", never shorthand like "dials x : y".
function endpointLines(endpoint) {
  const lines = [];
  if (endpoint.transport === 'serial') {
    const serial = endpoint.serial ?? {};
    const framing = [serial.dataBits, serial.parity?.[0], serial.stopBits].filter(Boolean).join('');
    lines.push(
      [serial.port && `Serial port ${serial.port}`, serial.baud && `${serial.baud} baud`, framing]
        .filter(Boolean)
        .join(' · '),
    );
  } else {
    if (endpoint.role === 'client' && endpoint.remoteAddress) {
      lines.push(`Connects to ${endpoint.remoteAddress}${endpoint.remotePort ? ` port ${endpoint.remotePort}` : ''}`);
    }
    if (endpoint.role !== 'client' && endpoint.localPort) {
      lines.push(`Listens on port ${endpoint.localPort}`);
    }
    if (endpoint.role === 'client' && endpoint.localPort) {
      lines.push(`Local port ${endpoint.localPort}`);
    }
  }
  const { selfDnp, peerDnp, modbusUnit } = endpoint.addressing ?? {};
  if (selfDnp != null) lines.push(`DNP address ${selfDnp}`);
  if (peerDnp != null) lines.push(`Peer DNP address ${peerDnp}`);
  if (modbusUnit != null) lines.push(`Modbus unit ID ${modbusUnit}`);
  return lines;
}

// The canvas-facing projection of a placed device: exactly the fields the
// frontend's GraphDevice type mirrors (frontend/src/types.ts) — change the
// two together. `scd` is the augmentation descriptor the workspace resolved
// ({ ref, error?, warning? }), or null.
function graphDevice(device, profile, scd) {
  return {
    id: device.id,
    x: device.x,
    y: device.y,
    source: device.source,
    name: profile.name,
    model: profile.model,
    endpointCount: profile.endpoints.length,
    // Network fabric (switches): the canvas styles the node and the connect
    // dialog offers the ports.
    ...(profile.kind ? { kind: profile.kind } : {}),
    ...(profile.ports
      ? {
          ports: profile.ports.map((port) => ({
            id: port.id,
            name: port.name,
            enabled: port.enabled,
          })),
        }
      : {}),
    // Serial lines the connect dialog can pair by hand.
    ...(profile.endpoints.some((endpoint) => endpoint.transport === 'serial')
      ? {
          serialEndpoints: profile.endpoints
            .filter((endpoint) => endpoint.transport === 'serial')
            .map((endpoint) => ({
              id: endpoint.id,
              name: endpoint.name ?? endpoint.serial?.port ?? endpoint.id,
              detail: endpoint.lines?.[0] ?? null,
            })),
        }
      : {}),
    scd: scd ?? null,
  };
}

export { endpointLines, graphDevice };
