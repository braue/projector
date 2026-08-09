// SCD IED -> DeviceProfile.
//
// An SCL file states three comm truths per IED: where it sits (access-point
// addresses), what it publishes (GOOSE control blocks with multicast wire
// addresses), and what it consumes (bound ExtRefs naming the publishing
// IED). The first two become interfaces and endpoints; the third becomes the
// profile's format-neutral `identity` + `subscriptions` evidence (see
// model.js) — the identity namespace is this upload, so declared links
// resolve only between profiles from the same authored document.
//
// A profile extracted here can stand alone on the canvas, or augment a
// device placed from another artifact via augmentProfile — the same physical
// device seen by two documents (an RDB says what the relay is set to, the
// SCD says where it sits on the 61850 network).

import { connectedAps } from '../../parsers/scd/index.js';

function gooseEndpoints(ied, aps) {
  const wires = aps.flatMap((ap) => ap.gses);
  const endpoints = [];

  for (const accessPoint of ied.accessPoints) {
    for (const ldevice of accessPoint.ldevices) {
      for (const cb of ldevice.gooseControls) {
        const wire = wires.find(
          (candidate) => candidate.cbName === cb.name
            && (!candidate.ldInst || candidate.ldInst === ldevice.inst),
        );
        const lines = [`publishes dataset ${cb.datSet ?? '?'}${cb.appId ? ` · APPID ${cb.appId}` : ''}`];
        if (wire) {
          const mac = wire.address['MAC-Address'];
          const vlan = wire.address['VLAN-ID'];
          lines.push([mac && `multicast ${mac}`, vlan && `VLAN ${vlan}`].filter(Boolean).join(' · '));
        }
        endpoints.push({
          id: `goose:${ldevice.inst}/${cb.name}`,
          name: cb.name,
          role: 'server',
          protocol: 'GOOSE',
          transport: 'ethernet',
          remoteAddress: null,
          remotePort: null,
          localPort: null,
          serial: null,
          addressing: {},
          goose: wire ? { mac: wire.address['MAC-Address'] ?? null, appId: wire.address.APPID ?? null } : null,
          lines: lines.filter(Boolean),
        });
      }
    }
  }
  return endpoints;
}

// `profile` is ScdService.profile(ref) output: { fileId, model, ied }.
function extractScdProfile({ fileId, model, ied }, ref) {
  const aps = connectedAps(model, ied.name).map(({ ap }) => ap);

  return {
    name: ied.name,
    manufacturer: ied.manufacturer ?? null,
    model: ied.type ?? 'IED',
    source: { type: 'scd', ref },
    interfaces: aps.map((ap) => ({
      kind: 'ethernet',
      name: ap.apName,
      ip: ap.address.IP ?? null,
      mask: ap.address['IP-SUBNET'] ?? null,
    })),
    endpoints: gooseEndpoints(ied, aps),
    identity: { namespace: `scd:${fileId}`, name: ied.name },
    // The control ref is `<ldInst>/<cbName>`, exactly how this extractor
    // mints publication endpoint ids — stamp the join key here so the linker
    // never parses control paths.
    subscriptions: ied.subscriptions.map((sub) => ({
      publisher: sub.publisher,
      serviceType: sub.serviceType,
      control: sub.control,
      publisherEndpointId: sub.control ? `goose:${sub.control}` : null,
      points: sub.points,
    })),
  };
}

// Merge an SCD profile into a device placed from another artifact. The base
// artifact keeps the device's identity; the SCD adds interfaces it didn't
// state (RTAC exports carry no NIC addresses — the SCD does), its GOOSE
// publications, and the identity/subscription evidence the linker draws
// declared links from.
function augmentProfile(base, scdProfile) {
  const knownIps = new Set(base.interfaces.map((iface) => iface.ip).filter(Boolean));
  return {
    ...base,
    interfaces: [
      ...base.interfaces,
      ...scdProfile.interfaces.filter((iface) => !iface.ip || !knownIps.has(iface.ip)),
    ],
    endpoints: [...base.endpoints, ...scdProfile.endpoints],
    identity: scdProfile.identity,
    subscriptions: scdProfile.subscriptions,
  };
}

// Evidence-based sanity check on an attachment: both documents may state the
// device's model ("SEL-735" from an RDB, "SEL_487B" as an SCD IED type).
// Normalized to their digit-bearing token, one should contain the other
// (751 ⊂ 751A); when neither does, the IED probably belongs to a different
// physical device. Null when either side states nothing comparable.
function modelToken(value) {
  const normalized = String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^SEL/, '');
  return /\d/.test(normalized) ? normalized : null;
}

function attachmentWarning(base, scdProfile) {
  const baseToken = modelToken(base.model);
  const scdToken = modelToken(scdProfile.model);
  if (!baseToken || !scdToken) return null;
  if (baseToken.includes(scdToken) || scdToken.includes(baseToken)) return null;
  return `SCD IED type ${scdProfile.model} may not match this device (${base.model})`;
}

export { attachmentWarning, augmentProfile, extractScdProfile };
