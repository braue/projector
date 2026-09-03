// SW artifact kind — SEL managed-switch settings exports (SEL-2730M XML) in
// the project tree. Model lifecycle lives in lib/artifacts.js; this kind
// owns only the SW-shaped parts. One file describes one switch, so each
// carries exactly one profile, addressed "<path>::<name>" like every other
// artifact ref.

import path from 'node:path';

import { ArtifactKind } from '../lib/artifacts.js';
import { httpError } from '../lib/http.js';
import { flag, sectionItem, sectionNode, tablePage } from '../lib/inspect.js';
import { parseSw, switchName } from '../lib/parsers/sw/index.js';

// What a switch is called when its settings carry no name of their own: the
// file's own base name.
function fallbackName(treePath) {
  const base = path.basename(treePath ?? '');
  return base.replace(path.extname(base), '') || base;
}

// Membership the VLAN table states, turned inside out: which VLANs ride a
// given port number, as "20 (tagged)" pieces.
function portVlans(model, portNumber) {
  const pieces = [];
  for (const vlan of model.vlans) {
    if (vlan.taggedPorts.includes(portNumber)) pieces.push(`${vlan.vid} (tagged)`);
    if (vlan.untaggedPorts.includes(portNumber)) pieces.push(`${vlan.vid} (untagged)`);
  }
  return pieces;
}

class SwKind extends ArtifactKind {
  constructor({ artifacts }) {
    super({ artifacts, label: 'sw' });
    this.uploadErrorLabel = 'not a readable switch settings export';
  }

  parse(buffer) {
    return parseSw(buffer.toString('utf8'));
  }

  profilesOf(model, treePath) {
    return [{ name: switchName(model, fallbackName(treePath)), deviceType: model.nameplate.type }];
  }

  findProfile(model, name, treePath) {
    return switchName(model, fallbackName(treePath)) === name ? model : null;
  }

  // --- inspect mapping --------------------------------------------------------
  // Sectioned the way a switch is audited: identity, management addresses,
  // the physical ports, and the VLAN plan. Settings mirror each table for
  // compare signatures; pages carry the full rows.

  async tree(ref) {
    const { path: treePath, model } = await this.profile(ref);
    const sections = [
      sectionNode({ name: 'Overview', path: 'overview', kindLabel: 'Switch identity', category: 'system' }),
      sectionNode({
        name: 'Network', path: 'network', kindLabel: 'Management interfaces', category: 'connection',
        pointCount: model.interfaces.reduce((total, iface) => total + iface.addresses.length, 0),
      }),
      sectionNode({
        name: 'Ports', path: 'ports', kindLabel: 'Physical ports', category: 'connection',
        pointCount: model.ports.length,
      }),
      sectionNode({
        name: 'VLANs', path: 'vlans', kindLabel: 'VLAN plan', category: 'connection',
        pointCount: model.vlans.length,
      }),
    ];
    return {
      name: switchName(model, fallbackName(treePath)),
      schema: null,
      deviceLabel: model.nameplate.type,
      summary: { files: sections.length },
      errors: [],
      tree: sections,
    };
  }

  async item(ref, key) {
    const { model } = await this.profile(ref);
    const swItem = (overrides) => sectionItem('SwSection', overrides);

    if (key === 'overview') {
      const settings = {};
      const put = (label, value) => {
        if (value) settings[label] = value;
      };
      put('Model', model.nameplate.type);
      put('Firmware (FID)', model.nameplate.fid);
      put('Device id', model.nameplate.id);
      put('Part number', model.nameplate.partNumber);
      put('Serial number', model.nameplate.serialNumber);
      put('Hostname', model.hostname);
      put('Default gateway', model.defaultGateway);
      put('Spanning tree mode', model.rstpMode);
      if (model.vlanAware !== null) put('VLAN aware', flag(model.vlanAware));
      put('Ports', `${model.ports.filter((port) => port.enabled).length} of ${model.ports.length} enabled`);
      return swItem({
        id: key, file: 'Nameplate', category: 'system',
        kindLabel: 'Switch identity', name: 'Overview', settings,
      });
    }

    if (key === 'network') {
      const settings = {};
      const rows = [];
      for (const iface of model.interfaces) {
        settings[`${iface.id} · enabled`] = flag(iface.enabled);
        if (iface.vlan !== null) settings[`${iface.id} · VLAN`] = String(iface.vlan);
        for (const address of iface.addresses) {
          settings[`${iface.id} · ${address.alias ?? address.ip}`] =
            `${address.ip}${address.prefix ? `/${address.prefix}` : ''}`;
          rows.push([
            iface.id, address.alias, `${address.ip}${address.prefix ? `/${address.prefix}` : ''}`,
            iface.vlan !== null ? String(iface.vlan) : '', flag(iface.enabled),
            address.services.join(', '),
          ]);
        }
      }
      return swItem({
        id: key,
        file: 'network_settings',
        kindLabel: 'Management interfaces',
        name: 'Network',
        settings,
        pointCount: rows.length,
        pages: [tablePage('Interfaces',
          ['Interface', 'Alias', 'Address', 'VLAN', 'Enabled', 'Services'], rows)],
      });
    }

    if (key === 'ports') {
      const settings = {};
      const rows = [];
      for (const port of model.ports) {
        const vlans = portVlans(model, port.number);
        settings[port.id ?? `port ${port.number}`] = [
          port.enabled ? 'enabled' : 'disabled',
          port.speed,
          port.name,
          vlans.length && `VLANs ${vlans.join(', ')}`,
        ].filter(Boolean).join(' · ');
        rows.push([
          String(port.number), port.id, port.name, flag(port.enabled), port.speed,
          vlans.join(', '),
        ]);
      }
      return swItem({
        id: key,
        file: 'port_settings',
        kindLabel: 'Physical ports',
        name: 'Ports',
        settings,
        pointCount: rows.length,
        pages: [tablePage('Ports', ['#', 'Port', 'Label', 'Enabled', 'Speed', 'VLANs'], rows)],
      });
    }

    if (key === 'vlans') {
      const settings = {};
      const rows = [];
      for (const vlan of model.vlans) {
        settings[`VLAN ${vlan.vid}${vlan.name ? ` — ${vlan.name}` : ''}`] = [
          vlan.taggedPorts.length && `tagged on ports ${vlan.taggedPorts.join(', ')}`,
          vlan.untaggedPorts.length && `untagged on ports ${vlan.untaggedPorts.join(', ')}`,
        ].filter(Boolean).join(' · ') || 'no port members';
        rows.push([
          vlan.vid !== null ? String(vlan.vid) : '', vlan.name,
          vlan.taggedPorts.join(', '), vlan.untaggedPorts.join(', '),
          vlan.isDefault ? 'default' : '',
        ]);
      }
      return swItem({
        id: key,
        file: 'vlan_settings',
        kindLabel: 'VLAN plan',
        name: 'VLANs',
        settings,
        pointCount: rows.length,
        pages: [tablePage('VLANs', ['VID', 'Name', 'Tagged ports', 'Untagged ports', ''], rows)],
      });
    }

    throw httpError(404, `no such item in ${ref}: ${key}`);
  }
}

export { SwKind };
