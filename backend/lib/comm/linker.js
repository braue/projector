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

// Who owns an IP: a device whose interfaces carry it. (RTAC profiles carry no
// interfaces yet, so today this resolves against RDB/SCD-style profiles and
// the machinery is exercised by tests; the canvas mostly draws ghosts until
// phase 2 loads relays.)
function buildAddressIndex(devices) {
  const byIp = new Map();
  for (const { id, profile } of devices) {
    for (const iface of profile.interfaces ?? []) {
      const ip = normalizeIp(iface.ip);
      if (ip && !byIp.has(ip)) byIp.set(ip, { deviceId: id, profile, iface });
    }
  }
  return byIp;
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

function summarize(endpoint, matchedOn) {
  const proto = endpoint.protocol ?? 'unknown protocol';
  const transport = endpoint.transport === 'serial' ? 'serial' : 'TCP';
  const base = `${proto} ${endpoint.role === 'server' ? 'server ← client' : 'client → server'} over ${transport}`;
  return matchedOn ? `${base} · ${matchedOn}` : base;
}

function linkProfiles(devices, manualLinks = []) {
  const byIp = buildAddressIndex(devices);
  const links = [];
  const ghosts = new Map(); // address/key -> ghost

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

      const aSide = {
        label: `${profile.name} · ${endpoint.role} · ${endpoint.name ?? endpoint.id}`,
        lines: endpoint.lines ?? [],
      };
      const base = {
        id: `${deviceId}:${endpoint.id}`,
        sourceDeviceId: deviceId,
        protocol: endpoint.protocol,
        transport: endpoint.transport,
        a: aSide,
      };

      // Serial: no shared address space — declared, pending a manual pair.
      if (endpoint.transport === 'serial') {
        const key = `${deviceId}:${endpoint.id}`;
        const ghost = ghostFor(
          key,
          endpoint.name ?? endpoint.serial?.port ?? 'serial device',
          `serial · declared by ${profile.name}`,
          ['no artifact paired with this serial line'],
        );
        links.push({
          ...base,
          targetGhostId: ghost.id,
          tier: 'declared',
          summary: summarize(endpoint, 'far end not paired'),
          b: { label: `${ghost.label} · unknown device`, lines: ghost.lines },
          warnings: [
            { kind: 'warning', text: 'Serial far end unknown — load its file or pair it manually' },
          ],
        });
        continue;
      }

      const address = normalizeIp(endpoint.remoteAddress);
      if (!address) continue; // nothing dialed — nothing to draw

      const owner = byIp.get(address);
      if (!owner || owner.deviceId === deviceId) {
        const ghost = ghostFor(
          address,
          address,
          `declared by ${profile.name} · not loaded`,
          [`${endpoint.protocol ?? '?'} ${endpoint.remotePort ? `: ${endpoint.remotePort}` : ''}`.trim()],
        );
        links.push({
          ...base,
          targetGhostId: ghost.id,
          tier: 'declared',
          summary: summarize(endpoint, 'far end not loaded'),
          b: { label: `${address} · unknown device`, lines: ['no artifact loaded for this address'] },
          warnings: [
            { kind: 'warning', text: 'Far end unknown — load its RDB or SCD to verify this link' },
          ],
        });
        continue;
      }

      // The address pins the pair — now the far side's own settings testify.
      const server = findServerEndpoint(owner.profile, endpoint);
      const warnings = [];

      if (server) {
        if (endpoint.remotePort && server.localPort && endpoint.remotePort !== server.localPort) {
          warnings.push({
            kind: 'error',
            text: `Port mismatch — ${profile.name} dials ${endpoint.remotePort}, ${owner.profile.name} listens on ${server.localPort}`,
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

      links.push({
        ...base,
        targetDeviceId: owner.deviceId,
        tier,
        summary: summarize(endpoint, `matched on IP ${address}`),
        b: {
          label: `${owner.profile.name} · ${server ? `server · ${server.name ?? owner.iface.name}` : owner.iface.name ?? 'interface'}`,
          lines: server
            ? [`${owner.iface.name ?? 'port'} · ${address}`, ...(server.lines ?? [])]
            : [`${owner.iface.name ?? 'port'} · ${address}`],
        },
        warnings,
      });
    }
  }

  // Manual links (serial pairs the user drew) — validated, never inferred.
  for (const manual of manualLinks) {
    const a = devices.find((d) => d.id === manual.aDeviceId);
    const b = devices.find((d) => d.id === manual.bDeviceId);
    if (!a || !b) continue;
    const aEndpoint = a.profile.endpoints.find((e) => e.id === manual.aEndpointId);
    const bEndpoint = b.profile.endpoints.find((e) => e.id === manual.bEndpointId);
    const warnings = [];
    if (aEndpoint?.serial?.baud && bEndpoint?.serial?.baud && aEndpoint.serial.baud !== bEndpoint.serial.baud) {
      warnings.push({
        kind: 'error',
        text: `Baud mismatch — ${a.profile.name} at ${aEndpoint.serial.baud}, ${b.profile.name} at ${bEndpoint.serial.baud}`,
      });
    }
    links.push({
      id: `manual:${manual.id}`,
      sourceDeviceId: a.id,
      targetDeviceId: b.id,
      tier: warnings.length ? 'conflict' : 'manual',
      protocol: aEndpoint?.protocol ?? null,
      transport: 'serial',
      summary: 'Serial pair · user-drawn',
      a: { label: `${a.profile.name} · ${aEndpoint?.name ?? ''}`, lines: aEndpoint?.lines ?? [] },
      b: { label: `${b.profile.name} · ${bEndpoint?.name ?? ''}`, lines: bEndpoint?.lines ?? [] },
      warnings,
    });
  }

  return { links, ghosts: [...ghosts.values()] };
}

export { linkProfiles };
