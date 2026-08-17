// SCD source service — uploaded IEC 61850 SCL substation configurations.
//
// Lifecycle (storage, versioned re-parse, refs, compare adapter) lives in
// lib/uploadService.js; this service owns only what is SCD-shaped: which
// profiles a file carries (its IEDs) and the inspect sections. A profile —
// one IED — is addressed "<fileId>::<iedName>". An SCD profile can stand
// alone on the canvas or augment a device placed from another artifact (the
// same physical device seen by two documents).

import { httpError } from '../lib/http.js';
import { flag, sectionItem, sectionNode, tablePage } from '../lib/inspect.js';
import { connectedAps, ldevicesOf, parseScd, wireAddressFor } from '../lib/parsers/scd/index.js';
import { UploadService } from '../lib/uploadService.js';

// Bumped when the parsed model's shape changes; stale uploads re-parse from
// their original bytes in the background on startup.
const MODEL_VERSION = 2;

class ScdService extends UploadService {
  constructor({ dataDir }) {
    super({
      dataDir,
      label: 'scd',
      extension: /\.(scd|ssd|sed|cid|icd)$/i,
      originalName: 'original.scd',
      modelVersion: MODEL_VERSION,
      uploadErrorLabel: 'not a readable SCL file',
    });
  }

  parse(buffer) {
    return parseScd(buffer.toString('utf8'));
  }

  validate(model) {
    if (!model.ieds.length) {
      throw httpError(400, 'the SCL file declares no IEDs');
    }
  }

  profilesOf(model) {
    return model.ieds.map((ied) => ({ name: ied.name, deviceType: ied.type }));
  }

  findProfile(model, name) {
    return model.ieds.find((ied) => ied.name === name) ?? null;
  }

  // --- inspect mapping --------------------------------------------------------
  // Sectioned the way the Architect workbook extractor sections an IED — the
  // five comm truths an engineer audits, each a table, not a settings soup:
  //
  //   Network          access points with IP/subnet/gateway per port
  //   GOOSE Transmit   control blocks merged with their wire addresses
  //   GOOSE Receive    bound ExtRefs point-by-point (path 'subscriptions' —
  //                    the same declared links the canvas linker consumes)
  //   Reports          full trigger/option configuration per ReportControl
  //   one per dataset  every FCDA resolved to 61850 path + device source
  //
  // plus a Logical devices roll-up (LN counts, unbound template slots).
  // Settings mirror each table's identity for compare signatures; pages carry
  // the full rows for the inspect sheets.

  tree(ref) {
    const { profile: ied, model } = this.profile(ref);
    const ldevices = ldevicesOf(ied);
    const pick = (of) => ldevices.flatMap(({ ldevice }) => of(ldevice));
    const gooseControls = pick((ld) => ld.gooseControls);
    const reportControls = pick((ld) => ld.reportControls);
    const boundPoints = pick((ld) => ld.extRefs).length;

    const items = [
      sectionNode({
        name: 'Network', path: 'network', kindLabel: 'Connected access points',
        category: 'connection', pointCount: connectedAps(model, ied.name).length,
      }),
      ...(gooseControls.length
        ? [sectionNode({
            name: 'GOOSE Transmit', path: 'tx', kindLabel: 'GOOSE control blocks',
            category: 'connection', pointCount: gooseControls.length,
          })]
        : []),
      ...(boundPoints
        ? [sectionNode({
            name: 'GOOSE Receive', path: 'subscriptions', kindLabel: 'Bound ExtRefs',
            category: 'connection', pointCount: boundPoints,
          })]
        : []),
      ...(reportControls.length
        ? [sectionNode({
            name: 'Reports', path: 'reports', kindLabel: 'Report control blocks',
            category: 'connection', pointCount: reportControls.length,
          })]
        : []),
      ...ldevices.flatMap(({ accessPoint, ldevice }) =>
        ldevice.datasets.map((ds) =>
          // No '/' — that reads as a folder separator when compare folds paths.
          sectionNode({
            name: ds.desc ? `${ds.name} — ${ds.desc}` : ds.name,
            path: `ds:${accessPoint.name}:${ldevice.inst}:${ds.name}`,
            kindLabel: 'Dataset', category: 'tagList', pointCount: ds.points.length,
          }))),
      sectionNode({
        name: 'Logical devices', path: 'structure', kindLabel: 'Logical devices',
        category: 'system', pointCount: ldevices.length,
      }),
    ];

    return {
      name: ied.name,
      schema: null,
      deviceLabel: ied.type,
      summary: { files: items.length },
      errors: [],
      tree: items,
    };
  }

  item(ref, key) {
    const { profile: ied, model } = this.profile(ref);
    const ldevices = ldevicesOf(ied);
    const scdItem = (overrides) => sectionItem('ScdSection', overrides);

    if (key === 'network') {
      // One row per connected access point; GOOSE wire addresses live with
      // their control blocks in `tx`.
      const aps = connectedAps(model, ied.name);
      const settings = {};
      const rows = [];
      for (const { subNetwork, ap } of aps) {
        const subnet = `${subNetwork.name ?? ''}${subNetwork.type ? ` (${subNetwork.type})` : ''}`;
        settings[`${ap.apName} · subnetwork`] = subnet;
        for (const [type, value] of Object.entries(ap.address)) {
          settings[`${ap.apName} · ${type}`] = value;
        }
        rows.push([
          ap.apName, subnet, ap.address.IP, ap.address['IP-SUBNET'], ap.address['IP-GATEWAY'],
          ap.ports.join(', '),
        ]);
      }
      return scdItem({
        id: key,
        file: 'Communication',
        kindLabel: 'Connected access points',
        name: 'Network',
        settings,
        pointCount: aps.length,
        pages: [tablePage('Access points',
          ['Access point', 'Subnetwork', 'IP', 'Subnet', 'Gateway', 'Physical ports'], rows)],
      });
    }

    if (key === 'tx') {
      const wires = connectedAps(model, ied.name)
        .flatMap(({ ap }) => ap.gses.map((gse) => ({ apName: ap.apName, ...gse })));
      const settings = {};
      const rows = [];
      for (const { ldevice } of ldevices) {
        for (const cb of ldevice.gooseControls) {
          const { wire, address: wireAddress } = wireAddressFor(wires, ldevice, cb);
          const address = wireAddress ?? {};
          rows.push([
            cb.name, cb.datSet, cb.appId, wire?.ldInst ?? ldevice.inst, wire?.apName,
            address['MAC-Address'], address.APPID, address['VLAN-ID'], address['VLAN-PRIORITY'],
            cb.minTime, cb.maxTime, cb.confRev,
          ]);
          settings[`GOOSE ${cb.name}`] = [
            `dataset ${cb.datSet ?? '?'}`,
            cb.appId && `App ID ${cb.appId}`,
            address['MAC-Address'] && `MAC ${address['MAC-Address']}`,
            address.APPID && `APPID ${address.APPID}`,
            address['VLAN-ID'] && `VLAN ${address['VLAN-ID']}`,
          ].filter(Boolean).join(' · ');
        }
      }
      return scdItem({
        id: key,
        file: 'GSEControl + Communication',
        kindLabel: 'GOOSE control blocks',
        name: 'GOOSE Transmit',
        protocol: 'GOOSE',
        settings,
        pointCount: rows.length,
        pages: [tablePage('Transmit',
          ['Control', 'Dataset', 'App ID', 'LDevice', 'Interface', 'MAC', 'APPID', 'VLAN ID',
            'VLAN priority', 'Min time (ms)', 'Max time (ms)', 'Conf rev'], rows)],
      });
    }

    if (key === 'subscriptions') {
      // Grouped per publisher control block for the inspect sheet and the
      // linker's summary; the page lists every bound point in receive-map
      // order. The summaries are pure roll-ups of those rows, so they are
      // flagged derived: a receive edit diffs as the per-point table, never
      // restated as cryptic "N points bound" summary changes.
      const settings = {};
      for (const sub of ied.subscriptions) {
        settings[`${sub.publisher}${sub.control ? ` · ${sub.control}` : ''}`] =
          `${sub.serviceType ?? '?'} · ${sub.points} point${sub.points === 1 ? '' : 's'} bound`;
      }
      const rows = ldevices.flatMap(({ ldevice }) =>
        ldevice.extRefs.map((ext) => [ext.intAddr, ext.source, ext.serviceType]));
      return scdItem({
        id: key,
        file: 'Inputs/ExtRef',
        kindLabel: 'Bound ExtRefs',
        name: 'GOOSE Receive',
        protocol: 'GOOSE',
        settings,
        derivedSettings: true,
        pointCount: rows.length,
        pages: [tablePage('Received points', ['Internal address', 'Source', 'Service'], rows)],
      });
    }

    if (key === 'reports') {
      const settings = {};
      const rows = [];
      for (const { ldevice } of ldevices) {
        for (const cb of ldevice.reportControls) {
          rows.push([
            cb.name, cb.datSet, cb.rptId, flag(cb.buffered), cb.bufTime,
            flag(cb.trgOps.dchg), flag(cb.trgOps.qchg), flag(cb.trgOps.dupd), flag(cb.trgOps.period),
            cb.intgPd,
            Object.entries(cb.optFields).filter(([, on]) => on).map(([name]) => name).join(', '),
            cb.maxClients, cb.confRev,
          ]);
          settings[`Report ${cb.name}`] = [
            `dataset ${cb.datSet ?? '?'}`,
            cb.buffered ? 'buffered' : 'unbuffered',
            cb.bufTime && `buf ${cb.bufTime} ms`,
            `triggers ${['dchg', 'qchg', 'dupd', 'period'].filter((t) => cb.trgOps[t]).join('+') || 'none'}`,
            cb.intgPd && `integrity ${cb.intgPd} ms`,
          ].filter(Boolean).join(' · ');
        }
      }
      return scdItem({
        id: key,
        file: 'ReportControl',
        kindLabel: 'Report control blocks',
        name: 'Reports',
        settings,
        pointCount: rows.length,
        pages: [tablePage('Reports',
          ['Report', 'Dataset', 'Report ID', 'Buffered', 'Buf time (ms)', 'Trig dchg', 'Trig qchg',
            'Trig dupd', 'Trig period', 'Integrity (ms)', 'Option fields', 'Max clients', 'Conf rev'],
          rows)],
      });
    }

    if (key.startsWith('ds:')) {
      const parts = key.slice(3).split(':');
      const [apName, inst] = parts;
      const dsName = parts.slice(2).join(':');
      const ldevice = ied.accessPoints
        .find((candidate) => candidate.name === apName)
        ?.ldevices.find((candidate) => candidate.inst === inst);
      const ds = ldevice?.datasets.find((candidate) => candidate.name === dsName);
      if (ds) {
        // Settings keyed by 61850 path so compare diffs point membership and
        // source mapping directly.
        const settings = {};
        for (const point of ds.points) {
          settings[point.path] = [point.source ?? 'unresolved', point.units].filter(Boolean).join(' · ');
        }
        return scdItem({
          id: key,
          file: `${apName}/${inst}`,
          category: 'tagList',
          kindLabel: 'Dataset',
          name: ds.desc ? `${ds.name} — ${ds.desc}` : ds.name,
          settings,
          pointCount: ds.points.length,
          pages: [tablePage(ds.name, ['61850 path', 'FC', 'Source', 'Units'],
            ds.points.map((point) => [point.path, point.fc, point.source, point.units]))],
        });
      }
    }

    if (key === 'structure') {
      const settings = {};
      const rows = [];
      for (const { accessPoint, ldevice } of ldevices) {
        settings[`${accessPoint.name}/${ldevice.inst}`] = [
          `${ldevice.logicalNodes} logical node${ldevice.logicalNodes === 1 ? '' : 's'}`,
          ldevice.datasets.length && `${ldevice.datasets.length} dataset${ldevice.datasets.length === 1 ? '' : 's'}`,
          ldevice.unboundExtRefs && `${ldevice.unboundExtRefs} unbound ExtRef slots`,
        ].filter(Boolean).join(' · ');
        rows.push([
          accessPoint.name, ldevice.inst, ldevice.desc, String(ldevice.logicalNodes),
          String(ldevice.datasets.length), String(ldevice.unboundExtRefs),
        ]);
      }
      return scdItem({
        id: key,
        file: 'IED/AccessPoint/Server',
        category: 'system',
        kindLabel: 'Logical devices',
        name: 'Logical devices',
        settings,
        pointCount: rows.length,
        pages: [tablePage('Logical devices',
          ['Access point', 'LDevice', 'Description', 'Logical nodes', 'Datasets', 'Unbound ExtRef slots'],
          rows)],
      });
    }

    throw httpError(404, `no such item in ${ref}: ${key}`);
  }
}

export { ScdService };
