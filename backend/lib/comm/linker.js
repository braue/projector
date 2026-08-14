// The linker — a pure, deterministic function over DeviceProfiles.
//
// A link on the canvas is never stored data: it is this function
// cross-referencing what each artifact says about its own communications.
// Tiers, in order of certainty:
//
//   confirmed — a client's dial target (ip:port, protocol) is owned by
//               another device and every checked value agrees
//   conflict  — the address pins the pair but a value disagrees
//               (port, protocol, DNP address pair)
//   probable  — the address pins the pair but one side is silent on the rest
//   declared  — nobody owns the address: the link ends in a ghost node
//
// No I/O and no randomness, so the whole engine is unit-testable with
// fixture profiles. `devices` is [{ id, profile }]; ghosts for unresolved
// far ends are deduped by address across the whole workspace.

function normalizeIp(value) {
  return (value ?? '').trim();
}

// Who owns an IP: every device whose interfaces carry it. ALL claimants are
// kept — duplicate ownership (the same physical device placed via two
// artifacts, or a genuine misconfiguration) must surface as a warning on the
// links matched through that address, never be silently shadowed by whichever
// device happened to come first.
function buildAddressIndex(devices) {
  const byIp = new Map();
  for (const { id, profile } of devices) {
    for (const iface of profile.interfaces ?? []) {
      const ip = normalizeIp(iface.ip);
      if (!ip) continue;
      if (!byIp.has(ip)) byIp.set(ip, []);
      const claimants = byIp.get(ip);
      if (!claimants.some((claimant) => claimant.deviceId === id)) {
        claimants.push({ deviceId: id, profile, iface });
      }
    }
  }
  return byIp;
}

// A manual link in canonical form: `{ id, type, ends: [{ deviceId, port?,
// endpointId? }, ...] }`. The sided spelling (aPort/bEndpointId/...) is the
// API wire format the connect dialog sends; this converter is its single
// home.
function normalizeManualLink(link) {
  return {
    id: link.id,
    type: link.type,
    ends: link.ends ?? [
      { deviceId: link.aDeviceId, port: link.aPort, endpointId: link.aEndpointId },
      { deviceId: link.bDeviceId, port: link.bPort, endpointId: link.bEndpointId },
    ],
  };
}

// A port in a profile's inventory, by id ("eth3").
function findPort(profile, portId) {
  return (profile.ports ?? []).find((candidate) => candidate.id === portId) ?? null;
}

function portCarriesVlan(port, vlan) {
  return (port.taggedVlans ?? []).includes(vlan) || (port.untaggedVlans ?? []).includes(vlan);
}

function portVlanSet(port) {
  return new Set([...(port.taggedVlans ?? []), ...(port.untaggedVlans ?? [])]);
}

// --- IPv4 subnet math -----------------------------------------------------------

function ipToInt(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((value ?? '').trim());
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

// Is the dialed address on one of the client's stated subnets? true / false,
// or null when the client states no complete ip+mask pair to judge by —
// unknown stays silent, never guessed.
function remoteOnLink(profile, endpoint) {
  const remote = ipToInt(endpoint.remoteAddress);
  if (remote === null) return null;
  let judged = null;
  for (const iface of profile.interfaces ?? []) {
    const ip = ipToInt(iface.ip);
    const mask = ipToInt(iface.mask);
    if (ip === null || mask === null) continue;
    judged = false;
    if (((remote & mask) >>> 0) === ((ip & mask) >>> 0)) return true;
  }
  return judged;
}

// Off-subnet traffic needs a router. A client that dials outside every
// subnet it states, and states no gateway, has no route to the far end —
// whatever the far end's settings say.
function routeWarning(profile, endpoint) {
  if (remoteOnLink(profile, endpoint) !== false) return null;
  if ((profile.interfaces ?? []).some((iface) => iface.gateway)) return null;
  return {
    kind: 'warning',
    text: `${profile.name} dials ${endpoint.remoteAddress} outside its stated subnets and states no gateway — traffic has no route`,
  };
}

// --- the drawn fabric -------------------------------------------------------------

// What the user drew, resolved against switch port inventories:
//   attachments  deviceId -> [{ switchDevice, port }] — where each end device
//                plugs in (the port object carries VLAN membership)
//   trunks       switch-to-switch runs, both ports resolved
function buildFabric(devices, manualLinks) {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const attachments = new Map();
  const trunks = [];
  for (const manual of manualLinks) {
    if (manual.type !== 'ethernet') continue;
    const ends = manual.ends.map((end) => ({ ...end, device: byId.get(end.deviceId) }));
    if (ends.some((end) => !end.device)) continue;
    const [a, b] = ends;
    if (a.device.profile.kind === 'switch' && b.device.profile.kind === 'switch') {
      const aPort = a.port ? findPort(a.device.profile, a.port) : null;
      const bPort = b.port ? findPort(b.device.profile, b.port) : null;
      if (aPort && bPort) {
        trunks.push({ a: { device: a.device, port: aPort }, b: { device: b.device, port: bPort } });
      }
      continue;
    }
    for (const [self, far] of [[a, b], [b, a]]) {
      if (far.device.profile.kind !== 'switch' || !far.port) continue;
      const port = findPort(far.device.profile, far.port);
      if (!port) continue;
      if (!attachments.has(self.device.id)) attachments.set(self.device.id, []);
      attachments.get(self.device.id).push({ switchDevice: far.device, port });
    }
  }
  return { attachments, trunks };
}

// Switch ids reachable from `startIds` over trunks the predicate admits.
function reachableSwitches(startIds, trunks, usable) {
  const seen = new Set(startIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const trunk of trunks) {
      if (!usable(trunk)) continue;
      for (const [near, far] of [[trunk.a, trunk.b], [trunk.b, trunk.a]]) {
        if (seen.has(near.device.id) && !seen.has(far.device.id)) {
          seen.add(far.device.id);
          grew = true;
        }
      }
    }
  }
  return seen;
}

// GOOSE is VLAN-pinned layer-2 multicast: the publication only reaches the
// subscriber if every hop of the path carries its VLAN — the access port each
// end plugs into, and some chain of drawn trunks between their switches with
// the VLAN on both ports of every hop. Fabric that is not drawn stays
// silent: we validate stated topology, never guess it.
function vlanPathWarnings(fabric, publisherEnd, subscriberEnd, vlan, vlanRaw) {
  const warnings = [];
  const rides = `GOOSE rides VLAN ${vlan}${vlanRaw && String(vlan) !== vlanRaw ? ` (VLAN-ID ${vlanRaw})` : ''}`;

  for (const end of [publisherEnd, subscriberEnd]) {
    for (const attachment of fabric.attachments.get(end.id) ?? []) {
      if (!portCarriesVlan(attachment.port, vlan)) {
        warnings.push({
          kind: 'error',
          text: `${rides} but ${attachment.switchDevice.profile.name} port ${attachment.port.id} (${end.profile.name}'s connection) does not carry it`,
        });
      }
    }
  }

  // Ends on different switches: some drawn trunk path must carry the VLAN
  // end to end. No drawn path at all means the topology isn't stated — silence.
  const pubAttachments = fabric.attachments.get(publisherEnd.id) ?? [];
  const subAttachments = fabric.attachments.get(subscriberEnd.id) ?? [];
  if (pubAttachments.length && subAttachments.length) {
    const pubIds = new Set(pubAttachments.map((attachment) => attachment.switchDevice.id));
    const subIds = [...new Set(subAttachments.map((attachment) => attachment.switchDevice.id))];
    if (!subIds.some((id) => pubIds.has(id))) {
      const clean = reachableSwitches(pubIds, fabric.trunks,
        (trunk) => portCarriesVlan(trunk.a.port, vlan) && portCarriesVlan(trunk.b.port, vlan));
      if (!subIds.some((id) => clean.has(id))) {
        const drawn = reachableSwitches(pubIds, fabric.trunks, () => true);
        if (subIds.some((id) => drawn.has(id))) {
          warnings.push({
            kind: 'error',
            text: `${rides} but no drawn trunk path between ${pubAttachments[0].switchDevice.profile.name} and ${subAttachments[0].switchDevice.profile.name} carries it`,
          });
        }
      }
    }
  }

  // Multiple attachments can rediscover the same failure — one warning each.
  return [...new Map(warnings.map((warning) => [warning.text, warning])).values()];
}

// Same-subnet traffic never routes: when both ends of an IP link are drawn
// into the same switch, their two ports must share at least one VLAN or the
// frames have no layer-2 path. Only judged when the dialed address is on the
// client's own subnet — routed traffic may legitimately change VLANs.
function l2PathWarning(fabric, clientEnd, ownerEnd) {
  for (const client of fabric.attachments.get(clientEnd.id) ?? []) {
    for (const owner of fabric.attachments.get(ownerEnd.id) ?? []) {
      if (client.switchDevice.id !== owner.switchDevice.id) continue;
      const clientVlans = portVlanSet(client.port);
      if (![...portVlanSet(owner.port)].some((vlan) => clientVlans.has(vlan))) {
        return {
          kind: 'error',
          text: `${clientEnd.profile.name} (port ${client.port.id}) and ${ownerEnd.profile.name} (port ${owner.port.id}) are drawn into ${client.switchDevice.profile.name} on ports that share no VLAN — same-subnet traffic cannot pass`,
        };
      }
    }
  }
  return null;
}

// --- workspace-wide review ---------------------------------------------------

// The same physical device placed via two artifacts shares an identity — its
// values colliding with itself is not a finding.
function identityKey(profile, fallback) {
  return profile.identity ? `${profile.identity.namespace}|${profile.identity.name}` : fallback;
}

// Settings collisions an engineer checks across the whole network, links or
// not: duplicate IP ownership, and GOOSE wire identifiers (APPID, multicast
// MAC) used by more than one publication — subscribers filter on these, so a
// collision means messages that cannot be told apart. `byIp` is the address
// index linkProfiles already built.
function networkDiagnostics(devices, byIp) {
  const diagnostics = [];

  for (const [ip, claimants] of byIp) {
    const carriers = new Map();
    for (const claimant of claimants) {
      const key = identityKey(claimant.profile, claimant.deviceId);
      if (!carriers.has(key)) carriers.set(key, claimant);
    }
    if (carriers.size > 1) {
      diagnostics.push({
        severity: 'error',
        text: `IP ${ip} is set on ${[...carriers.values()]
          .map((claimant) => `${claimant.profile.name}${claimant.iface.name ? ` (${claimant.iface.name})` : ''}`)
          .join(' and ')}`,
      });
    }
  }

  const collisions = [
    { pick: (goose) => goose.appId, label: (value) => `GOOSE APPID ${value}` },
    { pick: (goose) => goose.mac, label: (value) => `GOOSE multicast MAC ${value}` },
  ].map((rule) => ({ ...rule, groups: new Map() }));
  for (const device of devices) {
    for (const endpoint of device.profile.endpoints ?? []) {
      if (!endpoint.goose) continue;
      for (const rule of collisions) {
        const value = rule.pick(endpoint.goose);
        if (!value) continue;
        if (!rule.groups.has(value)) rule.groups.set(value, new Map());
        rule.groups.get(value).set(
          identityKey(device.profile, device.id),
          `${device.profile.name} ${endpoint.name}`,
        );
      }
    }
  }
  for (const rule of collisions) {
    for (const [value, carriers] of rule.groups) {
      if (carriers.size > 1) {
        diagnostics.push({
          severity: 'error',
          text: `${rule.label(value)} is used by ${[...carriers.values()].join(' and ')} — subscribers cannot tell the publications apart`,
        });
      }
    }
  }

  return diagnostics;
}

// The far side's matching server endpoint, if it states one: same protocol
// first, then same port, then any server endpoint at all.
function findServerEndpoint(profile, clientEndpoint) {
  const servers = (profile.endpoints ?? []).filter(
    (endpoint) => endpoint.role === 'server' && endpoint.transport !== 'serial',
  );
  const port = clientEndpoint.remotePort;
  return (
    servers.find((s) => s.protocol === clientEndpoint.protocol && (!port || s.localPort === port)) ??
    servers.find((s) => s.localPort != null && s.localPort === port) ??
    servers.find((s) => s.protocol === clientEndpoint.protocol) ??
    null
  );
}

// One plain sentence for the popup's top line. Roles live in the side labels
// ("<device> · client"), so the summary only says protocol, wire, and how the
// pair was matched.
function summarize(endpoint, matchedOn) {
  const proto = endpoint.protocol ?? 'unknown protocol';
  const transport = endpoint.transport === 'serial' ? 'serial' : 'TCP';
  return `${proto} connection over ${transport} — ${matchedOn}`;
}

function linkProfiles(devices, manualLinks = []) {
  const manual = manualLinks.map(normalizeManualLink);
  const byIp = buildAddressIndex(devices);
  const fabric = buildFabric(devices, manual);
  const links = [];
  const ghosts = new Map(); // address/key -> ghost

  // Serial endpoints the user already paired by hand: their "far end
  // unknown" ghosts are resolved, not drawn again.
  const pairedSerial = new Set();
  for (const link of manual) {
    if (link.type === 'ethernet') continue;
    for (const end of link.ends) {
      if (end.endpointId) pairedSerial.add(`${end.deviceId}|${end.endpointId}`);
    }
  }

  // The three "far end is not a placed device" cases share one link shape.
  const declared = (base, ghost, summary, bLabel, bLines, warnings) =>
    links.push({
      ...base,
      targetGhostId: ghost.id,
      tier: 'declared',
      summary,
      b: { label: bLabel, lines: bLines },
      warnings,
    });

  const ghostFor = (key, label, sublabel, lines) => {
    const existing = ghosts.get(key);
    if (existing) return existing;
    const ghost = { id: `ghost:${key}`, label, sublabel, lines };
    ghosts.set(key, ghost);
    return ghost;
  };

  for (const { id: deviceId, profile } of devices) {
    for (const endpoint of profile.endpoints ?? []) {
      if (endpoint.role !== 'client' && endpoint.role !== 'peer') continue;

      // The side label is who the device is and which role it plays; the
      // lines lead with the RTAC navigator connection name (SEL_3530_1,
      // Other_3) — that name is how the reader finds the connection in
      // AcSELerator, so it travels with every link and ghost this endpoint
      // produces.
      const aSide = {
        label: `${profile.name} · ${endpoint.role}`,
        lines: [
          ...(endpoint.name ? [`Connection ${endpoint.name}`] : []),
          ...(endpoint.lines ?? []),
        ],
      };
      const base = {
        id: `${deviceId}:${endpoint.id}`,
        sourceDeviceId: deviceId,
        protocol: endpoint.protocol,
        transport: endpoint.transport,
        a: aSide,
      };

      // Serial: no shared address space — declared, pending a manual pair.
      // Already-paired lines are covered by their manual link below.
      if (endpoint.transport === 'serial') {
        if (pairedSerial.has(`${deviceId}|${endpoint.id}`)) continue;
        const ghost = ghostFor(
          `${deviceId}:${endpoint.id}`,
          endpoint.name ?? endpoint.serial?.port ?? 'serial device',
          `serial · declared by ${profile.name}`,
          ['No file paired with this serial line'],
        );
        declared(base, ghost,
          summarize(endpoint, 'the other end is unknown'),
          `${ghost.label} · unknown device`, ghost.lines,
          [{ kind: 'warning', text: 'Serial far end unknown — load its file or pair it manually' }]);
        continue;
      }

      const address = normalizeIp(endpoint.remoteAddress);
      if (!address) continue; // nothing dialed — nothing to draw

      // Prefer an owner other than the dialer itself (a device can end up
      // claiming an address its own clients dial once an SCD supplies its
      // interfaces).
      const claimants = byIp.get(address) ?? [];
      const owner = claimants.find((claimant) => claimant.deviceId !== deviceId);
      if (!owner) {
        // Several connections (even from several sources) can dial one
        // address; the ghost keeps one line per declaring connection, led by
        // its RTAC navigator name — the address alone doesn't tell the
        // reader WHICH connection is dangling.
        const ghost = ghostFor(address, address, `declared by ${profile.name} · not loaded`, []);
        const declarers = (ghost.declarers ??= new Set());
        declarers.add(profile.name);
        ghost.sublabel = `declared by ${[...declarers].join(', ')} · not loaded`;
        const line = [
          endpoint.name,
          endpoint.protocol ?? 'unknown protocol',
          endpoint.remotePort && `port ${endpoint.remotePort}`,
        ].filter(Boolean).join(' · ');
        if (!ghost.lines.includes(line)) ghost.lines.push(line);
        declared(base, ghost,
          summarize(endpoint, 'the other end is not loaded'),
          `${address} · unknown device`, ['No file loaded for this address'],
          [
            { kind: 'warning', text: 'Far end unknown — load its RDB or SCD to verify this link' },
            ...[routeWarning(profile, endpoint)].filter(Boolean),
          ]);
        continue;
      }

      // The address pins the pair — now the far side's own settings testify.
      const server = findServerEndpoint(owner.profile, endpoint);
      const warnings = [];

      if (server) {
        if (endpoint.remotePort && server.localPort && endpoint.remotePort !== server.localPort) {
          warnings.push({
            kind: 'error',
            text: `Port mismatch — ${profile.name} connects to port ${endpoint.remotePort}, ${owner.profile.name} listens on port ${server.localPort}`,
          });
        }
        if (endpoint.protocol && server.protocol && endpoint.protocol !== server.protocol) {
          warnings.push({
            kind: 'error',
            text: `Protocol mismatch — ${endpoint.protocol} vs ${server.protocol}`,
          });
        }
        const expected = endpoint.addressing?.peerDnp;
        const actual = server.addressing?.selfDnp;
        if (expected != null && actual != null && expected !== actual) {
          warnings.push({
            kind: 'error',
            text: `DNP address mismatch — ${profile.name} expects ${expected}, ${owner.profile.name} is set to ${actual}`,
          });
        }
      }

      // Same-subnet traffic through the drawn fabric needs a layer-2 path.
      if (remoteOnLink(profile, endpoint) === true) {
        const l2 = l2PathWarning(fabric, { id: deviceId, profile }, { id: owner.deviceId, profile: owner.profile });
        if (l2) warnings.push(l2);
      }

      let tier = warnings.length ? 'conflict' : server ? 'confirmed' : 'probable';
      if (!server) {
        warnings.push({
          kind: 'warning',
          text: `${owner.profile.name} owns ${address} but states no matching ${endpoint.protocol ?? ''} server — matched on IP only`,
        });
      } else if (tier === 'confirmed' && endpoint.remotePort && !server.localPort) {
        // The far side agrees on protocol but is silent on the port the
        // client dials — enough to pair, not enough to confirm.
        tier = 'probable';
        warnings.push({
          kind: 'warning',
          text: `${owner.profile.name} states no ${endpoint.protocol ?? ''} port — matched on IP and protocol only`,
        });
      }

      // Route sanity: off-subnet without a gateway is unreachable however
      // well the far end agrees. Advisory (post-tier) — masks can be stale.
      const route = routeWarning(profile, endpoint);
      if (route) warnings.push(route);

      // Contested ownership: other artifacts also claim this address (the
      // same physical device placed twice, or a real address collision).
      const otherClaimants = claimants
        .filter((claimant) => claimant !== owner)
        .map((claimant) =>
          claimant.deviceId === deviceId ? `${profile.name} (this device)` : claimant.profile.name,
        );
      if (otherClaimants.length) {
        warnings.push({
          kind: 'warning',
          text: `${address} is also claimed by ${otherClaimants.join(', ')} — matched against ${owner.profile.name}`,
        });
      }

      links.push({
        ...base,
        targetDeviceId: owner.deviceId,
        tier,
        summary: summarize(endpoint, `matched by IP ${address}`),
        b: {
          label: `${owner.profile.name} · server`,
          lines: [
            `IP ${address}${owner.iface.name ? ` (${owner.iface.name})` : ''}`,
            ...(server?.lines ?? []),
          ],
        },
        warnings,
      });
    }
  }

  // Declared subscriptions: an artifact that names both ends of a link (see
  // `identity`/`subscriptions` in model.js). A device whose identity matches
  // the named publisher — within the same document namespace — confirms the
  // link; a publisher nobody carries becomes a ghost.
  for (const { id: deviceId, profile } of devices) {
    const namespace = profile.identity?.namespace;
    if (!namespace) continue;

    for (const sub of profile.subscriptions ?? []) {
      const serviceType = sub.serviceType ?? 'unknown service';
      const aSide = {
        label: `${profile.name} · subscriber`,
        lines: [
          sub.control ? `Subscribes to ${sub.control}` : `Subscribes via ${serviceType}`,
          `${sub.points} point${sub.points === 1 ? '' : 's'} bound`,
        ],
      };
      const base = {
        id: `${deviceId}:sub:${sub.publisher}:${sub.control ?? serviceType}`,
        sourceDeviceId: deviceId,
        protocol: serviceType,
        transport: 'ethernet',
        a: aSide,
      };

      // Every canvas device carrying the publisher's identity (standalone or
      // as an attachment). More than one means the same identity is placed
      // twice — matched against the first, surfaced like contested IPs.
      const owners = devices.filter(
        (device) => device.id !== deviceId
          && device.profile.identity?.namespace === namespace
          && device.profile.identity?.name === sub.publisher,
      );
      const owner = owners[0];

      if (!owner) {
        const ghost = ghostFor(
          `${namespace}:${sub.publisher}`,
          sub.publisher,
          `${serviceType} · declared by ${profile.name}`,
          [sub.control ? `Publishes ${sub.control}` : `${serviceType} publisher`],
        );
        declared(base, ghost,
          `${serviceType} subscription — the publisher is not on the canvas`,
          `${sub.publisher} · not on canvas`, ghost.lines,
          [{ kind: 'warning', text: `${sub.publisher} is declared in the same document — place it (or attach it to its device) to resolve this link` }]);
        continue;
      }

      const publication = sub.publisherEndpointId
        ? (owner.profile.endpoints ?? []).find((endpoint) => endpoint.id === sub.publisherEndpointId)
        : null;

      // The document confirms the subscription; the drawn fabric can still
      // refute it — a VLAN-pinned publication that a switch port drops never
      // reaches the subscriber, whatever the SCL declares.
      const vlan = publication?.goose?.vlan ?? null;
      const pathWarnings = vlan
        ? vlanPathWarnings(fabric, owner, { id: deviceId, profile }, vlan, publication.goose.vlanId)
        : [];
      const warnings = [
        ...(owners.length > 1
          ? [{
              kind: 'warning',
              text: `${sub.publisher} is carried by ${owners.length} canvas devices (${owners.map((device) => device.profile.name).join(', ')}) — matched against ${owner.profile.name}`,
            }]
          : []),
        ...pathWarnings,
      ];

      links.push({
        ...base,
        targetDeviceId: owner.id,
        tier: pathWarnings.length ? 'conflict' : 'confirmed',
        summary: pathWarnings.length
          ? `${serviceType} connection — declared in the source document, but the drawn network path drops its VLAN`
          : `${serviceType} connection — declared in the source document`,
        b: {
          label: `${owner.profile.name} · publisher`,
          lines: publication?.lines ?? [`Publishes ${sub.control ?? serviceType}`],
        },
        warnings,
      });
    }
  }

  // Manual links the user drew — validated, never inferred. Two kinds:
  // physical ethernet runs (a port label per end, checked against each
  // profile's port inventory — a switch's eth1..ethN, or free text for a
  // device that states no ports) and serial pairs (an endpoint per end).
  for (const link of manual) {
    const ends = link.ends.map((end) => ({
      ...end,
      device: devices.find((device) => device.id === end.deviceId),
    }));
    if (ends.some((end) => !end.device)) continue;
    const [a, b] = ends;
    const base = {
      id: `manual:${link.id}`,
      manualId: link.id,
      sourceDeviceId: a.device.id,
      targetDeviceId: b.device.id,
    };

    if (link.type === 'ethernet') {
      const sides = ends.map(({ device, port: portId }) => {
        const profile = device.profile;
        if (!portId) {
          return { label: `${profile.name} · port unspecified`, lines: ['No port chosen'], warnings: [] };
        }
        const port = findPort(profile, portId);
        if (!port) {
          // A device without a port inventory takes the label verbatim; a
          // switch that doesn't state the port is worth flagging.
          return {
            label: `${profile.name} · ${portId}`,
            lines: [`Port ${portId}`],
            warnings: (profile.ports ?? []).length
              ? [{ kind: 'warning', text: `${profile.name} states no port named ${portId}` }]
              : [],
          };
        }
        const vlans = [
          port.untaggedVlans?.length && `untagged ${port.untaggedVlans.join(', ')}`,
          port.taggedVlans?.length && `tagged ${port.taggedVlans.join(', ')}`,
        ].filter(Boolean).join(' · ');
        return {
          label: `${profile.name} · ${port.id}`,
          lines: [
            `Port ${port.id}${port.name ? ` — ${port.name}` : ''}`,
            port.speed && `Speed ${port.speed}`,
            vlans && `VLANs ${vlans}`,
            port.enabled ? null : 'Disabled in settings',
          ].filter(Boolean),
          warnings: port.enabled
            ? []
            : [{ kind: 'error', text: `${port.id} is disabled in ${profile.name}'s settings` }],
        };
      });

      const warnings = sides.flatMap((side) => side.warnings);
      links.push({
        ...base,
        tier: warnings.some((warning) => warning.kind === 'error') ? 'conflict' : 'manual',
        protocol: null,
        transport: 'ethernet',
        summary: 'Physical connection — drawn manually',
        a: { label: sides[0].label, lines: sides[0].lines },
        b: { label: sides[1].label, lines: sides[1].lines },
        warnings,
      });
      continue;
    }

    const [aEndpoint, bEndpoint] = ends.map(
      (end) => end.device.profile.endpoints.find((endpoint) => endpoint.id === end.endpointId),
    );
    const warnings = [];
    if (aEndpoint?.serial?.baud && bEndpoint?.serial?.baud && aEndpoint.serial.baud !== bEndpoint.serial.baud) {
      warnings.push({
        kind: 'error',
        text: `Baud mismatch — ${a.device.profile.name} at ${aEndpoint.serial.baud}, ${b.device.profile.name} at ${bEndpoint.serial.baud}`,
      });
    }
    links.push({
      ...base,
      tier: warnings.length ? 'conflict' : 'manual',
      protocol: aEndpoint?.protocol ?? null,
      transport: 'serial',
      summary: 'Serial connection — paired manually',
      a: { label: `${a.device.profile.name} · serial`, lines: aEndpoint?.lines ?? [] },
      b: { label: `${b.device.profile.name} · serial`, lines: bEndpoint?.lines ?? [] },
      warnings,
    });
  }

  return {
    links,
    // declarers is pass-internal bookkeeping for the sublabel — not payload.
    ghosts: [...ghosts.values()].map(({ declarers, ...ghost }) => ghost),
    diagnostics: networkDiagnostics(devices, byIp),
  };
}

export { linkProfiles, normalizeManualLink };
