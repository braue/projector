// Workspace service — named canvases. A workspace stores only what the user
// decided: which artifacts are placed and where, plus manual links. Links are
// never stored: every graph read re-runs the extractor + linker over the
// current artifacts, so a re-downloaded project immediately re-links.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { linkProfiles } from '../lib/comm/linker.js';
import { httpError, resolveChild } from '../lib/http.js';

const DEFAULT_WORKSPACE = 'Default';

class WorkspaceService {
  // `resolvers` maps a source type to an async (ref) => DeviceProfile — one
  // per artifact kind (rtac, rdb, scd). `augment` merges an attached second
  // document into a base profile: async (profile, ref) => { profile,
  // warning }. Both are built in index.js so this service stays ignorant of
  // parsers, extractors, and other services.
  constructor({ dataDir, resolvers, augment }) {
    this.dir = path.join(dataDir, 'workspaces');
    this.resolvers = resolvers;
    this.augment = augment;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    if (!(await this.#names()).length) {
      await this.#save({ name: DEFAULT_WORKSPACE, devices: [], manualLinks: [] });
    }
  }

  #file(name) {
    return resolveChild(this.dir, `${name}.json`, `invalid workspace name: ${name}`);
  }

  async #names() {
    const entries = await readdir(this.dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.replace(/\.json$/, ''));
  }

  async list() {
    return (await this.#names()).sort((a, b) => a.localeCompare(b));
  }

  async #load(name) {
    try {
      return JSON.parse(await readFile(this.#file(name), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        throw httpError(404, `unknown workspace: ${name}`);
      }
      throw err;
    }
  }

  async #save(workspace) {
    await writeFile(this.#file(workspace.name), JSON.stringify(workspace, null, 2));
  }

  async create(name) {
    const trimmed = name?.trim();
    if (!trimmed) throw httpError(400, 'workspace name required');
    if ((await this.#names()).includes(trimmed)) {
      throw httpError(409, `workspace already exists: ${trimmed}`);
    }
    const workspace = { name: trimmed, devices: [], manualLinks: [] };
    await this.#save(workspace);
    return workspace;
  }

  async remove(name) {
    await rm(this.#file(name), { force: true });
  }

  // Place an artifact on the canvas. One node per artifact per workspace —
  // placing it again just moves it.
  async addDevice(name, { source, x = 120, y = 120 }) {
    if (!source?.type || !source?.ref) {
      throw httpError(400, 'source { type, ref } required');
    }
    if (!this.resolvers[source.type]) {
      throw httpError(400, `unsupported source type: ${source.type}`);
    }
    const workspace = await this.#load(name);
    const existing = workspace.devices.find(
      (device) => device.source.type === source.type && device.source.ref === source.ref,
    );
    if (existing) {
      existing.x = x;
      existing.y = y;
      await this.#save(workspace);
      return existing;
    }
    const device = { id: randomUUID(), source: { type: source.type, ref: source.ref }, x, y };
    workspace.devices.push(device);
    await this.#save(workspace);
    return device;
  }

  // Find a placed device, apply a mutation, persist, return it.
  async #withDevice(name, deviceId, mutate) {
    const workspace = await this.#load(name);
    const device = workspace.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw httpError(404, `unknown device: ${deviceId}`);
    mutate(device);
    await this.#save(workspace);
    return device;
  }

  async moveDevice(name, deviceId, { x, y }) {
    return this.#withDevice(name, deviceId, (device) => {
      device.x = x;
      device.y = y;
    });
  }

  // Attach an SCD profile to an already-placed device: the same physical
  // device seen by a second document. One attachment per device — dropping
  // another replaces it.
  async attachScd(name, deviceId, ref) {
    if (!ref) throw httpError(400, 'scd ref required');
    return this.#withDevice(name, deviceId, (device) => {
      device.scdRef = ref;
    });
  }

  async detachScd(name, deviceId) {
    return this.#withDevice(name, deviceId, (device) => {
      delete device.scdRef;
    });
  }

  async removeDevice(name, deviceId) {
    const workspace = await this.#load(name);
    workspace.devices = workspace.devices.filter((device) => device.id !== deviceId);
    workspace.manualLinks = (workspace.manualLinks ?? []).filter(
      (link) => link.aDeviceId !== deviceId && link.bDeviceId !== deviceId,
    );
    await this.#save(workspace);
  }

  // The canvas payload: placed devices with their extracted profiles, plus
  // whatever the linker can infer right now. A device whose artifact fails to
  // load (deleted export, parse failure) stays on the canvas with the error
  // attached rather than vanishing.
  async graph(name) {
    const workspace = await this.#load(name);

    // Devices resolve independently (each may trigger a project parse), so
    // resolve them concurrently; order is preserved by Promise.all. An SCD
    // attachment augments the base profile; a broken attachment (deleted
    // upload) degrades to the base profile with the failure noted.
    const results = await Promise.all(workspace.devices.map(async (device) => {
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

    const { links, ghosts } = linkProfiles(
      resolved.map(({ device, profile }) => ({ id: device.id, profile })),
      workspace.manualLinks ?? [],
    );

    const tiers = { confirmed: 0, conflict: 0, probable: 0, declared: 0, manual: 0 };
    for (const link of links) tiers[link.tier] += 1;

    return {
      name: workspace.name,
      devices: [
        ...resolved.map(({ device, profile, scdError, scdWarning }) => ({
          id: device.id,
          x: device.x,
          y: device.y,
          source: device.source,
          name: profile.name,
          model: profile.model,
          endpointCount: profile.endpoints.length,
          scd: device.scdRef
            ? {
                ref: device.scdRef,
                ...(scdError ? { error: scdError } : {}),
                ...(scdWarning ? { warning: scdWarning } : {}),
              }
            : null,
        })),
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
      summary: {
        devices: workspace.devices.length,
        confirmed: tiers.confirmed,
        conflicts: tiers.conflict,
        probable: tiers.probable,
        declared: tiers.declared,
        manual: tiers.manual,
      },
    };
  }
}

export { WorkspaceService };
