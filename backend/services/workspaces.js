// Workspace service — named canvases. A workspace stores only what the user
// decided: which artifacts are placed and where, plus manual links. Links are
// never stored: every graph read re-runs the extractor + linker over the
// current artifacts, so a re-downloaded project immediately re-links.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { linkProfiles } from '../lib/comm/linker.js';

const DEFAULT_WORKSPACE = 'Default';

class WorkspaceService {
  // `resolvers` maps a source type to an async (ref) => DeviceProfile — one
  // per artifact kind (rtac, rdb; scd in phase 3). Built in index.js so this
  // service stays ignorant of parsers and other services.
  constructor({ dataDir, resolvers }) {
    this.dir = path.join(dataDir, 'workspaces');
    this.resolvers = resolvers;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    if (!(await this.#names()).length) {
      await this.#save({ name: DEFAULT_WORKSPACE, devices: [], manualLinks: [] });
    }
  }

  #file(name) {
    const file = path.resolve(this.dir, `${name}.json`);
    if (path.dirname(file) !== path.resolve(this.dir)) {
      throw Object.assign(new Error(`invalid workspace name: ${name}`), { status: 400 });
    }
    return file;
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
        throw Object.assign(new Error(`unknown workspace: ${name}`), { status: 404 });
      }
      throw err;
    }
  }

  async #save(workspace) {
    await writeFile(this.#file(workspace.name), JSON.stringify(workspace, null, 2));
  }

  async create(name) {
    if (!name?.trim()) throw Object.assign(new Error('workspace name required'), { status: 400 });
    const workspace = { name: name.trim(), devices: [], manualLinks: [] };
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
      throw Object.assign(new Error('source { type, ref } required'), { status: 400 });
    }
    if (!this.resolvers[source.type]) {
      throw Object.assign(new Error(`unsupported source type: ${source.type}`), { status: 400 });
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

  async moveDevice(name, deviceId, { x, y }) {
    const workspace = await this.#load(name);
    const device = workspace.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw Object.assign(new Error(`unknown device: ${deviceId}`), { status: 404 });
    device.x = x;
    device.y = y;
    await this.#save(workspace);
    return device;
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
    const resolved = [];
    const broken = [];

    for (const device of workspace.devices) {
      try {
        const resolver = this.resolvers[device.source.type];
        if (!resolver) throw new Error(`unsupported source type: ${device.source.type}`);
        const profile = await resolver(device.source.ref);
        resolved.push({ device, profile });
      } catch (err) {
        broken.push({ device, error: err?.message ?? String(err) });
      }
    }

    const { links, ghosts } = linkProfiles(
      resolved.map(({ device, profile }) => ({ id: device.id, profile })),
      workspace.manualLinks ?? [],
    );

    const count = (tier) => links.filter((link) => link.tier === tier).length;

    return {
      name: workspace.name,
      devices: [
        ...resolved.map(({ device, profile }) => ({
          id: device.id,
          x: device.x,
          y: device.y,
          source: device.source,
          name: profile.name,
          model: profile.model,
          endpointCount: profile.endpoints.length,
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
        confirmed: count('confirmed'),
        conflicts: count('conflict'),
        probable: count('probable'),
        declared: count('declared'),
        manual: count('manual'),
      },
    };
  }
}

export { DEFAULT_WORKSPACE, WorkspaceService };
