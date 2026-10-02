// RTAC VLAN Deploy — bring a bench of RTACs onto one VLAN and load their
// projects: Ethernet 2 on each RTAC gets its VLAN IP (/24, gateway .1) over
// the RTAC's web interface at its network IP, the SEL-2730M makes the VLAN's
// members exactly those RTACs' ports plus the Raspberry Pi's, then each
// RTAC's AcRTAC project is uploaded over the network IP, one at a time.
// All of it runs in py/rtac_vlan_deploy.py (device web code py/sel_web.py,
// one upload per py/rtac_upload.py process) as ONE job.
//
// The bench itself — which identifier ("3555-1") sits at which network IP
// on which switch port — is a table kept here, in
// <dataDir>/tools/vlan-deploy/devices.json. A deploy names devices by
// identifier and this service resolves them, so the table is the one place
// an address or port is written down. (Not localStorage: the packaged app's
// origin changes every launch — see services/todos.js.)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const SCRIPT = 'rtac_vlan_deploy.py';

// A backstop above the bridge's own: uploads run one at a time, each attempt
// may take up to 3 hours (UPLOAD_TIMEOUT_S in the bridge), and there are 3
// attempts. A run that goes wrong early is aborted from the tasks popover.
const BASE_TIMEOUT_MS = 10 * 60 * 1000;
const PER_RTAC_TIMEOUT_MS = 3 * 3 * 60 * 60 * 1000;

const EXPLAIN = {
  python: 'Python was not found on PATH — install Python and the selacrtac package to deploy RTAC projects from here.',
  selacrtac: 'Python is installed but the selacrtac package is missing, so projects cannot be uploaded from here.',
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function filled(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

/** The bench table, cleaned: every row an identifier, an IPv4 network
 *  address and a switch port, none of the three repeated. */
function validateDevices(rows) {
  if (!Array.isArray(rows)) throw httpError(400, 'devices must be an array');
  const devices = rows.map((row, i) => {
    const id = filled(row?.id, `row ${i + 1} identifier`);
    const networkIp = filled(row?.networkIp, `${id} network IP`);
    if (!IPV4.test(networkIp)) throw httpError(400, `${id} network IP: "${networkIp}" is not an IPv4 address`);
    const port = filled(row?.port, `${id} switch port`);
    if (!/^\d+$/.test(port) || +port < 1 || +port > 999) {
      throw httpError(400, `${id} switch port must be a whole number 1-999`);
    }
    return { id, networkIp, port: String(+port) };
  });
  for (const [key, label] of [['id', 'identifier'], ['networkIp', 'network IP'], ['port', 'switch port']]) {
    const seen = new Set();
    for (const d of devices) {
      if (seen.has(d[key])) throw httpError(400, `two devices share the ${label} ${d[key]}`);
      seen.add(d[key]);
    }
  }
  return devices;
}

/** The form, filled in and with devices resolved from the table. What the
 *  values MEAN (addresses, ranges, duplicates) is
 *  py/rtac_vlan_deploy.py's validate(), which runs before AcRTAC starts, so a
 *  bad value still fails in a second. */
function validateDeploy(payload, devices) {
  const raw = Array.isArray(payload?.rtacs) ? payload.rtacs : [];
  if (!raw.length) throw httpError(400, 'add at least one RTAC');
  const byId = new Map(devices.map((d) => [d.id, d]));
  return {
    switchIp: filled(payload.switchIp, 'Switch IP'),
    vlan: filled(payload.vlan, 'VLAN ID'),
    piPort: filled(payload.piPort, 'Raspberry Pi port'),
    rtacs: raw.map((r, i) => {
      const id = filled(r?.device, `RTAC ${i + 1} device`);
      const device = byId.get(id);
      if (!device) throw httpError(400, `${id} is not in the bench device table`);
      return {
        label: id,
        networkIp: device.networkIp,
        port: device.port,
        vlanIp: filled(r?.vlanIp, `${id} VLAN IP`),
        project: filled(r?.project, `${id} project`),
      };
    }),
  };
}

class VlanDeployService {
  // Every write is a whole-file replace, so two in flight would drop one.
  #queue = Promise.resolve();

  constructor({ jobs, dataDir }) {
    this.jobs = jobs;
    this.file = path.join(dataDir, 'tools', 'vlan-deploy', 'devices.json');
  }

  async devices() {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      // Only a missing file means "no devices yet" — a corrupt one must fail,
      // or the next save would overwrite the lot.
      if (err?.code === 'ENOENT') return [];
      throw httpError(500, `could not read the bench device table: ${err?.message ?? err}`);
    }
  }

  /** Whole-table replace. */
  async saveDevices(rows) {
    const devices = validateDevices(rows);
    const run = this.#queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(devices, null, 2));
      return devices;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async start(payload) {
    const request = validateDeploy(payload, await this.devices());
    const n = request.rtacs.length;
    const job = this.jobs.start(`RTAC VLAN deploy: ${n} RTAC(s) → VLAN ${request.vlan}`, (handle) =>
      runStdinBridge(SCRIPT, request, {
        job: handle,
        explain: EXPLAIN,
        timeoutMs: BASE_TIMEOUT_MS + n * PER_RTAC_TIMEOUT_MS,
      }));
    return { job: job.id };
  }
}

export { VlanDeployService, validateDeploy, validateDevices };
