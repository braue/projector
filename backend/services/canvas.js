// Canvas service — one per purview project. The canvas stores only what the
// user decided: which artifacts are placed and where, plus manual links.
// Links are never stored: every graph read re-runs the extractor + linker
// over the current artifacts, so a re-exported or re-uploaded source
// immediately re-links.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { linkProfiles, normalizeManualLink } from '../lib/comm/linker.js';
import { graphDevice } from '../lib/comm/model.js';
import { httpError } from '../lib/http.js';

class CanvasService {
  // `resolvers` maps a source type to an async (ref) => DeviceProfile — one
  // per artifact kind in this project (rtac, rdb, scd, sw). `augment` merges
  // an attached second document into a base profile: async (profile, ref) =>
  // { profile, warning }. Both are built by the project registry so this
  // service stays ignorant of parsers, extractors, and other services.
  constructor({ file, resolvers, augment }) {
    this.file = file;
    this.resolvers = resolvers;
    this.augment = augment;
  }

  async init() {
    try {
      await readFile(this.file);
    } catch {
      await this.#save({ devices: [], manualLinks: [] });
    }
  }

  async #load() {
    return JSON.parse(await readFile(this.file, 'utf8'));
  }

  // Atomic: write beside, then rename over. A process killed mid-write must
  // never leave a truncated canvas.json — that would break every graph read
  // of the project with a JSON parse error.
  async #save(canvas) {
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(canvas, null, 2));
    await rename(tmp, this.file);
  }

  // Place an artifact on the canvas. One node per artifact per canvas —
  // placing it again just moves it.
  async addDevice({ source, x = 120, y = 120 }) {
    if (!source?.type || !source?.ref) {
      throw httpError(400, 'source { type, ref } required');
    }
    if (!this.resolvers[source.type]) {
      throw httpError(400, `unsupported source type: ${source.type}`);
    }
    const canvas = await this.#load();
    const existing = canvas.devices.find(
      (device) => device.source.type === source.type && device.source.ref === source.ref,
    );
    if (existing) {
      existing.x = x;
      existing.y = y;
      await this.#save(canvas);
      return existing;
    }
    const device = { id: randomUUID(), source: { type: source.type, ref: source.ref }, x, y };
    canvas.devices.push(device);
    await this.#save(canvas);
    return device;
  }

  // Find a placed device, apply a mutation, persist, return it.
  async #withDevice(deviceId, mutate) {
    const canvas = await this.#load();
    const device = canvas.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw httpError(404, `unknown device: ${deviceId}`);
    mutate(device);
    await this.#save(canvas);
    return device;
  }

  async moveDevice(deviceId, { x, y }) {
    return this.#withDevice(deviceId, (device) => {
      device.x = x;
      device.y = y;
    });
  }

  // Attach an SCD profile to an already-placed device: the same physical
  // device seen by a second document. One attachment per device — dropping
  // another replaces it.
  async attachScd(deviceId, ref) {
    if (!ref) throw httpError(400, 'scd ref required');
    return this.#withDevice(deviceId, (device) => {
      device.scdRef = ref;
    });
  }

  async detachScd(deviceId) {
    return this.#withDevice(deviceId, (device) => {
      delete device.scdRef;
    });
  }

  // Rewrite source refs after an identity rename (an RTAC export or an
  // upload id changed). `mapRef` maps each ref of `type` to its replacement
  // (returning the input for refs it doesn't touch); SCD attachments ride
  // device.scdRef and are rewritten alongside scd sources.
  async renameRefs(type, mapRef) {
    const canvas = await this.#load();
    for (const device of canvas.devices) {
      if (device.source.type === type) device.source.ref = mapRef(device.source.ref);
      if (type === 'scd' && device.scdRef) device.scdRef = mapRef(device.scdRef);
    }
    await this.#save(canvas);
  }

  async removeDevice(deviceId) {
    const canvas = await this.#load();
    canvas.devices = canvas.devices.filter((device) => device.id !== deviceId);
    canvas.manualLinks = (canvas.manualLinks ?? []).filter(
      (link) => !normalizeManualLink(link).ends.some((end) => end.deviceId === deviceId),
    );
    await this.#save(canvas);
  }

  // A connection the user drew between two placed devices. `type: 'ethernet'`
  // carries a port label per end (a switch port id like "eth3", or free text
  // for a device that states no ports); `type: 'serial'` carries endpoint
  // ids. Stored in canonical ends form as the user's claim — the linker
  // validates it on every read.
  async addManualLink({ type = 'ethernet', aDeviceId, bDeviceId, aPort, bPort, aEndpointId, bEndpointId }) {
    if (type !== 'ethernet' && type !== 'serial') {
      throw httpError(400, `unsupported link type: ${type}`);
    }
    if (!aDeviceId || !bDeviceId) throw httpError(400, 'aDeviceId and bDeviceId required');
    if (aDeviceId === bDeviceId) throw httpError(400, 'a device cannot connect to itself');
    if (type === 'serial' && (!aEndpointId || !bEndpointId)) {
      throw httpError(400, 'a serial pair names an endpoint on both sides');
    }
    const canvas = await this.#load();
    for (const id of [aDeviceId, bDeviceId]) {
      if (!canvas.devices.some((device) => device.id === id)) {
        throw httpError(404, `unknown device: ${id}`);
      }
    }
    const link = normalizeManualLink({
      id: randomUUID(), type, aDeviceId, bDeviceId, aPort, bPort, aEndpointId, bEndpointId,
    });
    // The same wire drawn twice is a slip, not a second connection.
    const endsKey = (candidate) => candidate.ends
      .map((end) => `${end.deviceId}|${end.port ?? ''}|${end.endpointId ?? ''}`)
      .sort()
      .join('~');
    if ((canvas.manualLinks ?? []).some((existing) => {
      const normalized = normalizeManualLink(existing);
      return normalized.type === link.type && endsKey(normalized) === endsKey(link);
    })) {
      throw httpError(409, 'this connection is already drawn');
    }
    canvas.manualLinks = [...(canvas.manualLinks ?? []), link];
    await this.#save(canvas);
    return link;
  }

  async removeManualLink(linkId) {
    const canvas = await this.#load();
    const remaining = (canvas.manualLinks ?? []).filter((link) => link.id !== linkId);
    if (remaining.length === (canvas.manualLinks ?? []).length) {
      throw httpError(404, `unknown manual link: ${linkId}`);
    }
    canvas.manualLinks = remaining;
    await this.#save(canvas);
  }

  // The canvas payload: placed devices with their extracted profiles, plus
  // whatever the linker can infer right now. A device whose artifact fails to
  // load (deleted export, parse failure) stays on the canvas with the error
  // attached rather than vanishing.
  async graph() {
    const canvas = await this.#load();

    // Devices resolve independently (each may trigger a project parse), so
    // resolve them concurrently; order is preserved by Promise.all. An SCD
    // attachment augments the base profile; a broken attachment (deleted
    // upload) degrades to the base profile with the failure noted.
    const results = await Promise.all(canvas.devices.map(async (device) => {
      try {
        const resolver = this.resolvers[device.source.type];
        if (!resolver) throw new Error(`unsupported source type: ${device.source.type}`);
        let profile = await resolver(device.source.ref);
        let scdError;
        let scdWarning;
        if (device.scdRef) {
          try {
            ({ profile, warning: scdWarning } = await this.augment(profile, device.scdRef));
          } catch (err) {
            scdError = err?.message ?? String(err);
          }
        }
        return { device, profile, scdError, scdWarning };
      } catch (err) {
        return { device, error: err?.message ?? String(err) };
      }
    }));
    const resolved = results.filter((result) => 'profile' in result);
    const broken = results.filter((result) => 'error' in result);

    const { links, ghosts, diagnostics } = linkProfiles(
      resolved.map(({ device, profile }) => ({ id: device.id, profile })),
      canvas.manualLinks ?? [],
    );

    const tiers = { confirmed: 0, conflict: 0, probable: 0, declared: 0, manual: 0 };
    for (const link of links) tiers[link.tier] += 1;

    return {
      devices: [
        ...resolved.map(({ device, profile, scdError, scdWarning }) => graphDevice(
          device,
          profile,
          device.scdRef
            ? {
                ref: device.scdRef,
                ...(scdError ? { error: scdError } : {}),
                ...(scdWarning ? { warning: scdWarning } : {}),
              }
            : null,
        )),
        ...broken.map(({ device, error }) => ({
          id: device.id,
          x: device.x,
          y: device.y,
          source: device.source,
          name: device.source.ref,
          model: null,
          error,
        })),
      ],
      ghosts,
      links,
      diagnostics,
      summary: {
        devices: canvas.devices.length,
        confirmed: tiers.confirmed,
        conflicts: tiers.conflict,
        probable: tiers.probable,
        declared: tiers.declared,
        manual: tiers.manual,
      },
    };
  }
}

export { CanvasService };
