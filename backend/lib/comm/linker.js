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

/**
 * A port's VLAN membership, or null when its export states none.
 *
 * The null matters: a switch that does not state its VLAN table has not
 * disagreed with anything, and must never be read as carrying nothing.
 */
function portVlans(port) {
  if (!port) return null;
  const vlans = new Set([...(port.taggedVlans ?? []), ...(port.untaggedVlans ?? [])]);
  return vlans.size ? vlans : null;
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

// --- checks -----------------------------------------------------------------
//
// A link's checks are the whole list of questions the linker asked of it, each
// with the answer it got. A reader should be able to see what was verified,
// not only what failed — and an unanswered question is itself worth showing,
// because it marks where the settings are silent rather than agreed.
//
//   pass     asked and both ends agree
//   fail     asked and they disagree — this is what makes a link a conflict
//   warn     worth knowing, not proof of a fault
//   unknown  could not be asked: one side states nothing. Never guessed.

function check(label, status, detail) {
  return { label, status, detail };
}

/** "8N1" — the framing both ends of a serial pair have to agree on. */
function serialFraming(endpoint) {
  const { dataBits, parity, stopBits } = endpoint?.serial ?? {};
  if (dataBits == null || !parity || stopBits == null) return null;
  return `${dataBits}${parity[0].toUpperCase()}${stopBits}`;
}

/**
 * The shape almost every check has: one value each side, which either agree,
 * disagree, or cannot be compared because a side is silent.
 */
function compare(label, mine, theirs, { agree, differ, silent }) {
  if (mine == null || theirs == null) return check(label, 'unknown', silent);
  if (String(mine) === String(theirs)) return check(label, 'pass', agree(mine));
  return check(label, 'fail', differ(mine, theirs));
}

// Off-subnet traffic needs a router. A client that dials outside every subnet
// it states, and states no gateway, has no route to the far end — whatever
// the far end's settings say.
function routeCheck(profile, endpoint, onLink) {
  if (onLink === null) {
    return check('Route to the far end', 'unknown',
      `${profile.name} states no complete address and mask to judge the route by`);
  }
  if (onLink === true) {
    return check('Route to the far end', 'pass',
      `${endpoint.remoteAddress} is on ${profile.name}'s own subnet — no router involved`);
  }
  const gateway = (profile.interfaces ?? []).find((iface) => iface.gateway)?.gateway;
  return gateway
    ? check('Route to the far end', 'pass',
      `${endpoint.remoteAddress} is off-subnet and reached via gateway ${gateway}`)
    : check('Route to the far end', 'warn',
      `${profile.name} dials ${endpoint.remoteAddress} outside its stated subnets and states no gateway — traffic has no route`);
}

// --- the drawn fabric -------------------------------------------------------------

// What the user drew, as a plain undirected graph: one segment per ethernet
// run, with each end's port resolved once. Everything else the fabric is asked
// — where a device plugs in, which runs are trunks, what a frame can cross —
// is a walk over these, not a second index of them.
function buildFabric(devices, manualLinks) {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const segments = [];
  for (const manual of manualLinks) {
    if (manual.type !== 'ethernet') continue;
    const ends = manual.ends.map((end) => ({ ...end, device: byId.get(end.deviceId) }));
    if (ends.some((end) => !end.device)) continue;
    segments.push({
      manualId: manual.id,
      // A free-text port on a device that states no inventory resolves to
      // nothing, which is exactly right: it has no VLAN table to consult.
      ends: ends.map((end) => ({
        deviceId: end.device.id,
        port: end.port ? findPort(end.device.profile, end.port) : null,
      })),
    });
  }
  return { segments, byId };
}

const isSwitch = (fabric, deviceId) => fabric.byId.get(deviceId)?.profile.kind === 'switch';

/** The two ends of a segment, oriented for a traveller arriving from `fromId`. */
function sides(segment, fromId) {
  const [a, b] = segment.ends;
  if (a.deviceId === fromId) return { near: a, far: b };
  if (b.deviceId === fromId) return { near: b, far: a };
  return null;
}

/** The switch ports a frame crosses on one segment, entering it from `fromId`. */
function segmentHops(fabric, segment, fromId) {
  const { near, far } = sides(segment, fromId);
  return [near, far]
    .filter((end) => isSwitch(fabric, end.deviceId))
    .map((end) => ({ switchName: fabric.byId.get(end.deviceId).profile.name, port: end.port }));
}

/**
 * Carry a VLAN set across one segment.
 *
 * A frame entering an access port is on that port's VLAN and can only cross a
 * hop that also carries it, so the set narrows at every switch port and the
 * route dies when it empties. Ports that state no membership are counted and
 * stepped over — they constrain nothing, but they do leave the answer partial.
 */
function crossSegment(fabric, segment, fromId, vlans, silent) {
  for (const hop of segmentHops(fabric, segment, fromId)) {
    const carries = portVlans(hop.port);
    if (!carries) {
      silent += 1;
      continue;
    }
    if (vlans === null) {
      vlans = carries;
      continue;
    }
    const survives = [...vlans].filter((vlan) => carries.has(vlan));
    if (!survives.length) return { blockedAt: hop, wanted: vlans };
    vlans = new Set(survives);
  }
  return { vlans, silent, blockedAt: null };
}

/** Crossing a segment costs nothing — the walk that only cares about topology. */
const unconstrained = () => ({ vlans: null, silent: 0, blockedAt: null });

/**
 * Breadth-first from one device to another over the drawn cables, returning
 * the run it found and whatever the traveller carried out of it.
 *
 * Only switches forward: a cable landing on an end device is where that run
 * stops, never a hop on someone else's path. `cross` decides what surviving a
 * segment means — topology alone for the run the canvas draws, VLAN membership
 * for the layer-2 check — so the search is written once for both.
 */
function walkFabric(fabric, fromId, toId, { vlans = null, cross }) {
  if (fromId === toId) return null;
  const stateKey = (id, carried) =>
    `${id}|${carried ? [...carried].sort((x, y) => x - y).join(',') : '*'}`;
  const seen = new Set([stateKey(fromId, vlans)]);
  let frontier = [{ id: fromId, vlans, silent: 0, path: [] }];

  while (frontier.length) {
    const next = [];
    for (const state of frontier) {
      for (const segment of fabric.segments) {
        const ends = sides(segment, state.id);
        if (!ends) continue;
        const crossed = cross(segment, state);
        if (crossed.blockedAt) continue;
        const path = [...state.path, segment.manualId];
        if (ends.far.deviceId === toId) return { ...crossed, path };
        if (!isSwitch(fabric, ends.far.deviceId)) continue;
        const key = stateKey(ends.far.deviceId, crossed.vlans);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ id: ends.far.deviceId, ...crossed, path });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The drawn cable run a logical link travels: the shortest one, which is the
 * run a reader would trace by eye. VLAN membership is deliberately not
 * consulted — the cables go where they go, and a run that drops the traffic
 * should still be the run drawn red rather than vanishing into a chord.
 */
function fabricPath(fabric, fromId, toId) {
  return walkFabric(fabric, fromId, toId, { cross: unconstrained })?.path ?? null;
}

/**
 * Is there a drawn path between these two on which one VLAN survives every
 * hop? Redundant fabric is why this searches rather than walking the shortest
 * run: if any path carries the traffic, the traffic gets through.
 *
 * `required` pins the VLAN (a GOOSE publication states its own); null means
 * any VLAN common to the whole run will do.
 */
function vlanWalk(fabric, fromId, toId, required) {
  return walkFabric(fabric, fromId, toId, {
    vlans: required == null ? null : new Set([required]),
    cross: (segment, state) => crossSegment(fabric, segment, state.id, state.vlans, state.silent),
  });
}

/** Where along one drawn run the VLAN dies — for naming the port at fault. */
function blockingHop(fabric, path, fromId, required) {
  const byManual = new Map(fabric.segments.map((segment) => [segment.manualId, segment]));
  let vlans = required == null ? null : new Set([required]);
  let here = fromId;
  for (const manualId of path) {
    const segment = byManual.get(manualId);
    if (!segment) return null;
    const crossed = crossSegment(fabric, segment, here, vlans, 0);
    if (crossed.blockedAt) return { hop: crossed.blockedAt, wanted: crossed.wanted };
    vlans = crossed.vlans;
    here = sides(segment, here).far.deviceId;
  }
  return null;
}

/**
 * Every switch port an end device plugs into, read off the drawn cables. A
 * switch-to-switch run is a trunk, not an attachment, so it is not one of
 * these — the walk is what judges trunks.
 */
function accessPorts(fabric, deviceId) {
  if (isSwitch(fabric, deviceId)) return [];
  return fabric.segments
    .map((segment) => sides(segment, deviceId)?.far)
    .filter((far) => far && isSwitch(fabric, far.deviceId))
    .map((far) => ({ switchName: fabric.byId.get(far.deviceId).profile.name, port: far.port }));
}

/**
 * Universal layer-2 check: can these two devices actually exchange frames over
 * the fabric as drawn? Asked of every link that needs layer-2 adjacency, not
 * just of the VLAN-pinned publications that used to be the only ones checked.
 */
function vlanPathCheck(fabric, fromId, toId, required = null) {
  const label = 'Layer-2 path';

  // Locally decidable, and worth saying even when the rest of the run is not
  // drawn: an end plugged into a port that cannot carry its VLAN is wrong on
  // its own evidence.
  if (required != null) {
    for (const endId of [fromId, toId]) {
      for (const { switchName, port } of accessPorts(fabric, endId)) {
        if (portVlans(port) && !portVlans(port).has(required)) {
          return check(label, 'fail',
            `${switchName} port ${port.id} (${fabric.byId.get(endId).profile.name}'s connection) does not carry VLAN ${required}`);
        }
      }
    }
  }

  const walk = vlanWalk(fabric, fromId, toId, required);
  if (walk) {
    if (walk.vlans === null) {
      return check(label, 'unknown', 'No switch on the drawn path states its VLAN membership');
    }
    const named = `VLAN ${[...walk.vlans].sort((a, b) => a - b).join(', ')}`;
    return walk.silent
      ? check(label, 'unknown',
        `${named} carries across every port that states one, but ${walk.silent} port${walk.silent === 1 ? ' states' : 's state'} no VLAN membership`)
      : check(label, 'pass', `${named} carries end to end across the drawn path`);
  }

  // Nothing carries it. Say where it dies, if a run is drawn at all.
  const drawn = fabricPath(fabric, fromId, toId);
  if (!drawn) {
    return check(label, 'unknown', 'No cables drawn between these two — draw the run to check it');
  }
  const blocked = blockingHop(fabric, drawn, fromId, required);
  const wanted = required != null
    ? `VLAN ${required}`
    : blocked ? `VLAN ${[...blocked.wanted].sort((a, b) => a - b).join(' or ')}` : 'a common VLAN';
  return check(label, 'fail', blocked
    ? `${blocked.hop.switchName} port ${blocked.hop.port.id} does not carry ${wanted} — frames stop here`
    : `No drawn path between these two carries ${wanted}`);
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
  const declared = (base, ghost, summary, bLabel, bLines, checks) =>
    links.push({
      ...base,
      targetGhostId: ghost.id,
      tier: 'declared',
      summary,
      b: { label: bLabel, lines: bLines },
      checks,
    });

  // One ghost per key, MERGING every declarer that references it — several
  // connections (even from several sources) can dial one address or
  // subscribe to one absent publisher, and the ghost must name them all.
  // The sublabel reads "<pre · >declared by A, B< · post>"; lines union.
  // Bookkeeping lives in this pass-local map, never on the payload object.
  const ghostMeta = new Map(); // key -> { declarers: Set, lines: Set, pre, post }
  const ghostFor = (key, label, { pre = null, post = null, declarer, lines = [] }) => {
    let meta = ghostMeta.get(key);
    if (!meta) {
      meta = { declarers: new Set(), lines: new Set(), pre, post };
      ghostMeta.set(key, meta);
      ghosts.set(key, { id: `ghost:${key}`, label, sublabel: '', lines: [] });
    }
    meta.declarers.add(declarer);
    for (const line of lines) meta.lines.add(line);
    const ghost = ghosts.get(key);
    ghost.sublabel = [meta.pre, `declared by ${[...meta.declarers].join(', ')}`, meta.post]
      .filter(Boolean)
      .join(' · ');
    ghost.lines = [...meta.lines];
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
          { pre: 'serial', declarer: profile.name, lines: ['No file paired with this serial line'] },
        );
        declared(base, ghost,
          summarize(endpoint, 'the other end is unknown'),
          `${ghost.label} · unknown device`, ghost.lines,
          [check('Far end identified', 'unknown',
            'No file is paired with this serial line — load it, or pair it by hand')]);
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
        // The ghost keeps one line per declaring connection, led by its RTAC
        // navigator name — the address alone doesn't tell the reader WHICH
        // connection is dangling.
        const line = [
          endpoint.name,
          endpoint.protocol ?? 'unknown protocol',
          endpoint.remotePort && `port ${endpoint.remotePort}`,
        ].filter(Boolean).join(' · ');
        const ghost = ghostFor(address, address, {
          post: 'not loaded',
          declarer: profile.name,
          lines: [line],
        });
        declared(base, ghost,
          summarize(endpoint, 'the other end is not loaded'),
          `${address} · unknown device`, ['No file loaded for this address'],
          [
            check('Far end identified', 'unknown',
              `Nothing on the canvas owns ${address} — load its RDB or SCD to verify this link`),
            routeCheck(profile, endpoint, remoteOnLink(profile, endpoint)),
          ]);
        continue;
      }

      // The address pins the pair — now the far side's own settings testify.
      // Every question asked is recorded, answered or not: a reader should be
      // able to see what was verified, not just what went wrong.
      const server = findServerEndpoint(owner.profile, endpoint);
      const checks = [];

      const claimedBy = `${address} is owned by ${owner.profile.name}${owner.iface.name ? ` (${owner.iface.name})` : ''}`;
      // Contested ownership: other artifacts also claim this address (the same
      // physical device placed twice, or a real address collision).
      const otherClaimants = claimants
        .filter((claimant) => claimant !== owner)
        .map((claimant) =>
          claimant.deviceId === deviceId ? `${profile.name} (this device)` : claimant.profile.name,
        );
      checks.push(otherClaimants.length
        ? check('Address ownership', 'warn',
          `${claimedBy}, but also claimed by ${otherClaimants.join(', ')}`)
        : check('Address ownership', 'pass', claimedBy));

      checks.push(compare('Protocol', endpoint.protocol, server?.protocol, {
        agree: (value) => `Both ends speak ${value}`,
        differ: (dialed, heard) => `${profile.name} speaks ${dialed}, ${owner.profile.name} speaks ${heard}`,
        silent: `${owner.profile.name} states no matching ${endpoint.protocol ?? ''} server`.replace('  ', ' '),
      }));

      checks.push(compare('TCP port', endpoint.remotePort, server?.localPort, {
        agree: (value) => `Both ends on port ${value}`,
        differ: (dialed, heard) =>
          `${profile.name} connects to port ${dialed}, ${owner.profile.name} listens on port ${heard}`,
        silent: `${owner.profile.name} states no ${endpoint.protocol ?? ''} port`.replace('  ', ' '),
      }));

      // Only asked of protocols that carry one; a Modbus link is not missing
      // a DNP address, it simply has none.
      const expected = endpoint.addressing?.peerDnp;
      const actual = server?.addressing?.selfDnp;
      if (expected != null || actual != null) {
        checks.push(compare('DNP addressing', expected, actual, {
          agree: (value) => `${owner.profile.name} is set to DNP address ${value}, which is what ${profile.name} expects`,
          differ: (want, is) => `${profile.name} expects ${want}, ${owner.profile.name} is set to ${is}`,
          silent: `Only one end states a DNP address`,
        }));
      }

      // Route sanity: off-subnet without a gateway is unreachable however well
      // the far end agrees. Advisory — masks can be stale.
      const onLink = remoteOnLink(profile, endpoint);
      checks.push(routeCheck(profile, endpoint, onLink));

      // Where the frames physically go. Same-subnet traffic never routes, so
      // the drawn path has to carry a VLAN end to end; routed traffic may
      // legitimately change VLAN at a gateway and is not judged here.
      const path = fabricPath(fabric, deviceId, owner.deviceId);
      if (onLink === true) checks.push(vlanPathCheck(fabric, deviceId, owner.deviceId));

      let tier = checks.some((entry) => entry.status === 'fail')
        ? 'conflict'
        : server ? 'confirmed' : 'probable';
      // The far side agrees on protocol but is silent on the port the client
      // dials — enough to pair, not enough to confirm.
      if (tier === 'confirmed' && endpoint.remotePort && !server.localPort) tier = 'probable';

      links.push({
        ...base,
        targetDeviceId: owner.deviceId,
        ...(path ? { path } : {}),
        tier,
        summary: summarize(endpoint, `matched by IP ${address}`),
        b: {
          label: `${owner.profile.name} · server`,
          lines: [
            `IP ${address}${owner.iface.name ? ` (${owner.iface.name})` : ''}`,
            ...(server?.lines ?? []),
          ],
        },
        checks,
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
          {
            pre: serviceType,
            declarer: profile.name,
            lines: [sub.control ? `Publishes ${sub.control}` : `${serviceType} publisher`],
          },
        );
        declared(base, ghost,
          `${serviceType} subscription — the publisher is not on the canvas`,
          `${sub.publisher} · not on canvas`, ghost.lines,
          [check('Publisher on the canvas', 'unknown',
            `${sub.publisher} is declared in the same document — place it (or attach it to its device) to resolve this link`)]);
        continue;
      }

      const publication = sub.publisherEndpointId
        ? (owner.profile.endpoints ?? []).find((endpoint) => endpoint.id === sub.publisherEndpointId)
        : null;

      // The document confirms the subscription; the drawn fabric can still
      // refute it — a VLAN-pinned publication that a switch port drops never
      // reaches the subscriber, whatever the SCL declares.
      const vlan = publication?.goose?.vlan ?? null;
      const vlanRaw = publication?.goose?.vlanId;
      const path = fabricPath(fabric, owner.id, deviceId);
      const checks = [];

      checks.push(owners.length > 1
        ? check('Publisher on the canvas', 'warn',
          `${sub.publisher} is carried by ${owners.length} canvas devices (${owners.map((device) => device.profile.name).join(', ')}) — matched against ${owner.profile.name}`)
        : check('Publisher on the canvas', 'pass',
          `${owner.profile.name} carries the identity ${sub.publisher} declares`));

      checks.push(check('Declared in the source', 'pass',
        `${profile.name} binds ${sub.points} point${sub.points === 1 ? '' : 's'} from ${sub.control ?? serviceType}`));

      // The publication states its own VLAN, so the path must carry that one
      // rather than merely some shared VLAN.
      const rides = vlan
        ? `${serviceType} rides VLAN ${vlan}${vlanRaw && String(vlan) !== vlanRaw ? ` (VLAN-ID ${vlanRaw})` : ''}`
        : null;
      const result = vlanPathCheck(fabric, owner.id, deviceId, vlan);
      checks.push(rides ? { ...result, detail: `${rides}; ${result.detail}` } : result);

      links.push({
        ...base,
        targetDeviceId: owner.id,
        ...(path ? { path } : {}),
        tier: checks.some((entry) => entry.status === 'fail') ? 'conflict' : 'confirmed',
        summary: checks.some((entry) => entry.status === 'fail')
          ? `${serviceType} connection — declared in the source document, but the drawn network path drops its VLAN`
          : `${serviceType} connection — declared in the source document`,
        b: {
          label: `${owner.profile.name} · publisher`,
          lines: publication?.lines ?? [`Publishes ${sub.control ?? serviceType}`],
        },
        checks,
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
      // One check per end: does the stated port exist, and is it switched on?
      // A cable is only as good as the two things it plugs into.
      const sides = ends.map(({ device, port: portId }) => {
        const profile = device.profile;
        if (!portId) {
          return {
            label: `${profile.name} · port unspecified`,
            lines: ['No port chosen'],
            checks: [check(`${profile.name} port`, 'unknown', 'No port was chosen for this end')],
          };
        }
        const port = findPort(profile, portId);
        if (!port) {
          // A device without a port inventory takes the label verbatim; a
          // switch that doesn't state the port is worth flagging.
          return {
            label: `${profile.name} · ${portId}`,
            lines: [`Port ${portId}`],
            checks: [(profile.ports ?? []).length
              ? check(`${profile.name} port`, 'warn', `${profile.name} states no port named ${portId}`)
              : check(`${profile.name} port`, 'unknown',
                `${profile.name} states no port inventory — ${portId} is taken as written`)],
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
          checks: [port.enabled
            ? check(`${profile.name} port`, 'pass',
              `${port.id} exists and is enabled${vlans ? ` · ${vlans}` : ''}`)
            : check(`${profile.name} port`, 'fail',
              `${port.id} is disabled in ${profile.name}'s settings`)],
        };
      });

      const checks = sides.flatMap((side) => side.checks);
      links.push({
        ...base,
        // A cable stays a cable: only a failing check reddens it. Something
        // unstated about a physical run is not a fault.
        tier: checks.some((entry) => entry.status === 'fail') ? 'conflict' : 'manual',
        protocol: null,
        transport: 'ethernet',
        summary: 'Physical connection — drawn manually',
        a: { label: sides[0].label, lines: sides[0].lines },
        b: { label: sides[1].label, lines: sides[1].lines },
        checks,
      });
      continue;
    }

    const [aEndpoint, bEndpoint] = ends.map(
      (end) => end.device.profile.endpoints.find((endpoint) => endpoint.id === end.endpointId),
    );
    const checks = [
      compare('Baud rate', aEndpoint?.serial?.baud, bEndpoint?.serial?.baud, {
        agree: (value) => `Both ends at ${value} baud`,
        differ: (mine, theirs) =>
          `${a.device.profile.name} at ${mine}, ${b.device.profile.name} at ${theirs}`,
        silent: 'One end states no baud rate',
      }),
      compare('Framing', serialFraming(aEndpoint), serialFraming(bEndpoint), {
        agree: (value) => `Both ends at ${value}`,
        differ: (mine, theirs) =>
          `${a.device.profile.name} at ${mine}, ${b.device.profile.name} at ${theirs}`,
        silent: 'One end states no data bits, parity and stop bits',
      }),
    ];
    links.push({
      ...base,
      tier: checks.some((entry) => entry.status === 'fail') ? 'conflict' : 'manual',
      protocol: aEndpoint?.protocol ?? null,
      transport: 'serial',
      summary: 'Serial connection — paired manually',
      a: { label: `${a.device.profile.name} · serial`, lines: aEndpoint?.lines ?? [] },
      b: { label: `${b.device.profile.name} · serial`, lines: bEndpoint?.lines ?? [] },
      checks,
    });
  }

  return { links, ghosts: [...ghosts.values()], diagnostics: networkDiagnostics(devices, byIp) };
}

export { linkProfiles, normalizeManualLink };
