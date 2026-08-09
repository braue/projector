// SCD source service — uploaded IEC 61850 SCL substation configurations.
//
// Storage rides the shared UploadStore (DATA_DIR/scd/<id>/, parsed.json
// rehydration, unique ids); this service owns parsing and the inspect/compare
// shaping. A profile — one IED — is addressed "<fileId>::<iedName>". An SCD
// profile can stand alone on the canvas or augment a device placed from
// another artifact (the same physical device seen by two documents).

import { settingsSignature } from '../lib/compare.js';
import { httpError } from '../lib/http.js';
import { connectedAps, parseScd } from '../lib/parsers/scd/index.js';
import { REF_SEPARATOR, splitRef as splitSourceRef } from '../lib/refs.js';
import { UploadStore } from '../lib/uploadStore.js';

const splitRef = (ref) => splitSourceRef(ref, 'scd');

class ScdService {
  // Compare entries per IED object — models are immutable per upload.
  #comparableCache = new WeakMap();

  constructor({ dataDir }) {
    this.store = new UploadStore({
      dataDir,
      label: 'scd',
      extension: /\.(scd|ssd|sed|cid|icd)$/i,
      originalName: 'original.scd',
    });
  }

  async init() {
    await this.store.init();
  }

  async upload(fileName, buffer) {
    let model;
    try {
      model = parseScd(buffer.toString('utf8'));
    } catch (err) {
      throw httpError(400, `not a readable SCL file: ${err?.message ?? err}`);
    }
    if (!model.ieds.length) {
      throw httpError(400, 'the SCL file declares no IEDs');
    }

    const stored = { fileName, model };
    const id = await this.store.add(fileName, buffer, stored);
    return this.#summary(id, stored);
  }

  async remove(fileId) {
    await this.store.remove(fileId);
  }

  #summary(id, stored) {
    return {
      id,
      fileName: stored.fileName,
      profiles: stored.model.ieds.map((ied) => ({
        name: ied.name,
        ref: `${id}${REF_SEPARATOR}${ied.name}`,
        deviceType: ied.type,
      })),
    };
  }

  list() {
    return [...this.store.entries()].map(([id, stored]) => this.#summary(id, stored));
  }

  // The IED plus everything the extractor needs alongside it (the model's
  // Communication section names the IED's addresses).
  profile(ref) {
    const { fileId, profileName } = splitRef(ref);
    const stored = this.store.get(fileId);
    const ied = stored?.model.ieds.find((candidate) => candidate.name === profileName);
    if (!ied) {
      throw httpError(404, `unknown scd profile: ${ref}`);
    }
    return { fileId, fileName: stored.fileName, model: stored.model, ied };
  }

  // Compare adapter entries: the IED's inspect items (network, subscriptions,
  // logical devices), signature = canonical (key-sorted) JSON of each item's
  // settings. Cached per IED object.
  comparable(ref) {
    const { fileName, ied } = this.profile(ref);
    if (!this.#comparableCache.has(ied)) {
      this.#comparableCache.set(ied, this.tree(ref).tree.map((treeNode) => {
        const item = this.item(ref, treeNode.path);
        return {
          path: treeNode.path,
          name: treeNode.name,
          item,
          signature: settingsSignature(item.settings),
        };
      }));
    }
    return { label: `${fileName} · ${ied.name}`, entries: this.#comparableCache.get(ied) };
  }

  // --- inspect mapping --------------------------------------------------------
  // Same shapes as RTAC/RDB: one item per logical device, plus a Network item
  // for the IED's access-point addresses and a Subscriptions item when the
  // file binds any.

  tree(ref) {
    const { ied, model } = this.profile(ref);
    const ldevices = ied.accessPoints.flatMap((accessPoint) =>
      accessPoint.ldevices.map((ldevice) => ({ accessPoint, ldevice })),
    );

    const items = [
      {
        type: 'item',
        name: 'Network',
        path: 'network',
        kind: 'ScdNetwork',
        kindLabel: 'Connected access points',
        category: 'connection',
        protocol: null,
        connectionType: null,
        pointCount: connectedAps(model, ied.name).length,
      },
      ...(ied.subscriptions.length
        ? [{
            type: 'item',
            name: 'Subscriptions',
            path: 'subscriptions',
            kind: 'ScdSubscriptions',
            kindLabel: 'Bound ExtRefs',
            category: 'connection',
            protocol: null,
            connectionType: null,
            pointCount: ied.subscriptions.reduce((total, sub) => total + sub.points, 0),
          }]
        : []),
      ...ldevices.map(({ accessPoint, ldevice }) => ({
        type: 'item',
        name: ldevice.desc ? `${ldevice.inst} — ${ldevice.desc}` : ldevice.inst,
        // No '/' — that reads as a folder separator when compare folds paths.
        path: `ld:${accessPoint.name}:${ldevice.inst}`,
        kind: 'LDevice',
        kindLabel: 'Logical device',
        category: 'system',
        protocol: null,
        connectionType: null,
        pointCount: ldevice.logicalNodes,
      })),
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
    const { ied, model } = this.profile(ref);
    const base = {
      kind: 'ScdSection',
      category: 'system',
      schema: null,
      points: [],
      pointCount: 0,
      pages: [],
    };

    if (key === 'network') {
      const settings = {};
      for (const { subNetwork, ap } of connectedAps(model, ied.name)) {
        settings[`${ap.apName} · subnetwork`] = `${subNetwork.name}${subNetwork.type ? ` (${subNetwork.type})` : ''}`;
        for (const [type, value] of Object.entries(ap.address)) {
          settings[`${ap.apName} · ${type}`] = value;
        }
        for (const gse of ap.gses) {
          for (const [type, value] of Object.entries(gse.address)) {
            settings[`${ap.apName} · GOOSE ${gse.cbName} · ${type}`] = value;
          }
        }
      }
      return { ...base, id: key, file: 'Communication', kindLabel: 'Connected access points', name: 'Network', category: 'connection', settings };
    }

    if (key === 'subscriptions') {
      const settings = {};
      for (const sub of ied.subscriptions) {
        settings[`${sub.publisher}${sub.control ? ` · ${sub.control}` : ''}`] =
          `${sub.serviceType ?? '?'} · ${sub.points} point${sub.points === 1 ? '' : 's'} bound`;
      }
      return { ...base, id: key, file: 'Inputs/ExtRef', kindLabel: 'Bound ExtRefs', name: 'Subscriptions', category: 'connection', settings };
    }

    if (key.startsWith('ld:')) {
      const [apName, inst] = key.slice(3).split(':');
      const accessPoint = ied.accessPoints.find((candidate) => candidate.name === apName);
      const ldevice = accessPoint?.ldevices.find((candidate) => candidate.inst === inst);
      if (ldevice) {
        const settings = {};
        for (const ds of ldevice.datasets) {
          settings[`DataSet ${ds.name}`] = `${ds.points} point${ds.points === 1 ? '' : 's'}${ds.desc ? ` · ${ds.desc}` : ''}`;
        }
        for (const cb of ldevice.gooseControls) {
          settings[`GOOSE ${cb.name}`] = `dataset ${cb.datSet ?? '?'}${cb.appId ? ` · APPID ${cb.appId}` : ''}`;
        }
        for (const cb of ldevice.reportControls) {
          settings[`Report ${cb.name}`] = `dataset ${cb.datSet ?? '?'} · ${cb.buffered ? 'buffered' : 'unbuffered'}`;
        }
        for (const cb of ldevice.smvControls) {
          settings[`SMV ${cb.name}`] = `dataset ${cb.datSet ?? '?'}`;
        }
        if (ldevice.unboundExtRefs) {
          settings['Unbound ExtRef slots'] = String(ldevice.unboundExtRefs);
        }
        return {
          ...base,
          id: key,
          file: `${apName}/${inst}`,
          kindLabel: 'Logical device',
          name: ldevice.desc ? `${inst} — ${ldevice.desc}` : inst,
          settings,
        };
      }
    }

    throw httpError(404, `no such item in ${ref}: ${key}`);
  }
}

export { ScdService };
