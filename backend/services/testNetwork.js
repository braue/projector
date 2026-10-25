// The test network — the bench of RTACs (and anything else) plugged into the
// SEL-2730M, read as it stands: which switch port sits on which VLAN, which
// bench device is on that port, its Eth_02 address and the project it runs.
// Over the devices' web interfaces (py/test_network.py, which needs no
// selacrtac). Three writes: moving one switch port onto a VLAN (the page's
// drag and drop), setting an RTAC's Eth_02 address, and sending a database
// project to an RTAC through AcRTAC's upload, as a job in the AcRTAC queue.
//
// The bench itself — which identifier ("3555-1") is at which network IP on
// which switch port — is a table kept in <dataDir>/test-network/devices.json,
// the one place an address or port is written down. (It was the old RTAC
// VLAN Deploy tool's table; its file is carried over on first read.)
//
// Machine-global like hours and todos, so it lives at the top of the data
// directory and the window hears a `test-network` event after every scan.

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../lib/http.js';
import { JsonFile } from '../lib/jsonFile.js';
import { runStdinBridge } from '../lib/acrtac/pythonClient.js';

const SCAN_SCRIPT = 'test_network.py';
const ACRTAC_BRIDGE = 'acrtac_bridge.py';
// Each device is one web login with a 20 s socket timeout; a dead network
// should come back as errors, not hang the page.
const SCAN_TIMEOUT_MS = 2 * 60 * 1000;
const KINDS = ['rtac', 'other'];

const EXPLAIN = {
  python: 'Python was not found on PATH — install Python to read the test network.',
  selacrtac: 'Python is installed but the selacrtac package is missing, so AcRTAC cannot upload from here.',
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function filled(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

/** The bench table, cleaned: every row an identifier, a switch port and a
 *  kind; RTACs also need an IPv4 network address. No identifier, address
 *  or port repeated. */
function validateDevices(rows) {
  if (!Array.isArray(rows)) throw httpError(400, 'devices must be an array');
  const devices = rows.map((row, i) => {
    const id = filled(row?.id, `row ${i + 1} identifier`);
    const kind = KINDS.includes(row?.kind) ? row.kind : 'rtac';
    const networkIp = String(row?.networkIp ?? '').trim();
    if (kind === 'rtac' && !networkIp) throw httpError(400, `${id} network IP is required`);
    if (networkIp && !IPV4.test(networkIp)) throw httpError(400, `${id} network IP: "${networkIp}" is not an IPv4 address`);
    const port = filled(row?.port, `${id} switch port`);
    if (!/^\d+$/.test(port) || +port < 1 || +port > 999) {
      throw httpError(400, `${id} switch port must be a whole number 1-999`);
    }
    return { id, kind, networkIp, port: String(+port) };
  });
  for (const [key, label] of [['id', 'identifier'], ['networkIp', 'network IP'], ['port', 'switch port']]) {
    const seen = new Set();
    for (const d of devices) {
      if (!d[key]) continue;
      if (seen.has(d[key])) throw httpError(400, `two devices share the ${label} ${d[key]}`);
      seen.add(d[key]);
    }
  }
  return devices;
}

class TestNetworkService {
  #scanning = null;
  #last = null;
  // Switch writes are read-modify-write of its VLAN table: one at a time.
  #moves = Promise.resolve();

  constructor({ dataDir, jobs, events = null, bridge = null }) {
    this.jobs = jobs;
    this.events = events;
    this.legacy = path.join(dataDir, 'tools', 'vlan-deploy', 'devices.json');
    this.store = new JsonFile(path.join(dataDir, 'test-network', 'devices.json'), {
      label: 'the bench device table',
      empty: () => [],
      clean: (raw) => (Array.isArray(raw) ? raw.map((d) => ({ kind: 'rtac', ...d })) : []),
    });
    // Tests (and the draft's demo mode) swap the bridge for a function.
    this.bridge = bridge ?? ((request) => runStdinBridge(SCAN_SCRIPT, request, {
      explain: EXPLAIN, timeoutMs: SCAN_TIMEOUT_MS, acrtac: false,
    }));
  }

  /** Carry the old VLAN Deploy table over the first time, if there is one. */
  async init() {
    await mkdir(path.dirname(this.store.file), { recursive: true });
    await copyFile(this.legacy, this.store.file, 1 /* COPYFILE_EXCL */).catch(() => {});
  }

  devices() {
    return this.store.read();
  }

  /** Whole-table replace. */
  saveDevices(rows) {
    return this.store.write(validateDevices(rows));
  }

  /** The last scan (null before the first), and whether one is running. */
  state() {
    return { scan: this.#last, scanning: this.#scanning !== null };
  }

  /** Read the network now. Concurrent calls share one scan. */
  scan(switchIp) {
    const ip = filled(switchIp, 'Switch IP');
    if (!IPV4.test(ip)) throw httpError(400, `Switch IP: "${ip}" is not an IPv4 address`);
    this.#scanning ??= (async () => {
      try {
        const devices = await this.devices();
        const result = await this.bridge({ switchIp: ip, devices });
        // The table rides along: the snapshot is what was true together.
        this.#last = { bench: devices, ...result, at: new Date().toISOString() };
        this.events?.publish('test-network', {});
        return this.#last;
      } finally {
        this.#scanning = null;
      }
    })();
    return this.#scanning;
  }

  /** Put bench device `device` (by identifier) on VLAN `vid`: its switch
   *  port becomes an untagged member there, off whatever VLAN had it. The
   *  device is looked up in the last scan's bench — the card that was
   *  dragged — or, when the backend has restarted since, in the table.
   *  Resolves to the snapshot with the switch's VLANs as re-read. */
  async move(payload) {
    const ip = filled(payload?.switchIp, 'Switch IP');
    const id = filled(payload?.device, 'device');
    const vid = Number(payload?.vid);
    if (!Number.isInteger(vid) || vid < 1 || vid > 4094) throw httpError(400, 'VLAN must be 1-4094');
    const bench = this.#last?.bench ?? await this.devices();
    const device = bench.find((d) => d.id === id);
    if (!device) throw httpError(400, `${id} is not on the test network`);
    const run = this.#moves.then(async () => {
      const { vlans, ...moved } = await this.bridge({ command: 'move', switchIp: ip, port: Number(device.port), vid });
      if (this.#last) this.#last = { ...this.#last, switch: { ...this.#last.switch, vlans } };
      this.events?.publish('test-network', {});
      return { ...moved, scan: this.#last };
    });
    this.#moves = run.catch(() => {});
    return run;
  }

  /** Set bench RTAC `device`'s Eth_02 to `ip` (always /24, gateway .1),
   *  over its web interface at its network IP. Resolves to the snapshot with
   *  that device's address as re-read. */
  async setEth02(payload) {
    const id = filled(payload?.device, 'device');
    const ip = filled(payload?.ip, 'Eth_02 IP').replace(/\/24$/, '');
    if (!IPV4.test(ip)) throw httpError(400, `Eth_02 IP: "${ip}" is not an IPv4 address`);
    const bench = this.#last?.bench ?? await this.devices();
    const device = bench.find((d) => d.id === id);
    if (!device) throw httpError(400, `${id} is not on the test network`);
    if (device.kind !== 'rtac') throw httpError(400, `${id} is not an RTAC`);
    const result = await this.bridge({ command: 'eth02', networkIp: device.networkIp, ip });
    if (this.#last) {
      this.#last = {
        ...this.#last,
        devices: this.#last.devices.map((d) => (d.id === id
          ? { ...d, eth02: result.after, gateway: result.gateway, error: null }
          : d)),
      };
    }
    this.events?.publish('test-network', {});
    return { ...result, scan: this.#last };
  }

  /** Send AcRTAC database project `project` to bench RTAC `device` (by
   *  identifier), as a job; the network is re-read after it lands. */
  async upload(payload) {
    const id = filled(payload?.device, 'device');
    const project = filled(payload?.project, 'project');
    const device = (await this.devices()).find((d) => d.id === id);
    if (!device) throw httpError(400, `${id} is not in the bench device table`);
    if (device.kind !== 'rtac') throw httpError(400, `${id} is not an RTAC`);
    const switchIp = payload?.switchIp;
    const job = this.jobs.start(`Upload ${project} → ${id}`, async (handle) => {
      handle.log(`Sending ${project} to ${id} at ${device.networkIp}…`);
      const result = await runStdinBridge(ACRTAC_BRIDGE, {
        command: 'upload', project, host: device.networkIp,
      }, { job: handle, explain: EXPLAIN });
      if (switchIp) this.scan(switchIp).catch(() => {});
      return result;
    }, { meta: { type: 'test-upload', device: id, project } });
    return { job: job.id };
  }
}

export { TestNetworkService, validateDevices };
