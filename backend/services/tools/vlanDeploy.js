// RTAC VLAN Deploy — bring a bench of RTACs onto one VLAN and load their
// projects: Ethernet 2 on each RTAC gets its VLAN IP (over the RTAC's web
// interface at its network IP), the SEL-2730M puts every RTAC's port on the
// VLAN untagged, then each RTAC's AcRTAC project is uploaded, one at a time,
// over the network IP. All of it runs in py/rtac_vlan_deploy.py (the device
// web code is py/sel_web.py) as ONE job; the project dropdown reuses the RTAC
// Exporter's database listing.

import { httpError } from '../../lib/http.js';
import { runStdinBridge } from '../../lib/acrtac/pythonClient.js';

const SCRIPT = 'rtac_vlan_deploy.py';

// A project upload is minutes; allow generously per RTAC on top of the web stages.
const BASE_TIMEOUT_MS = 10 * 60 * 1000;
const PER_RTAC_TIMEOUT_MS = 20 * 60 * 1000;

const EXPLAIN = {
  python: 'Python was not found on PATH — install Python and the selacrtac package to deploy RTAC projects from here.',
  selacrtac: 'Python is installed but the selacrtac package is missing, so projects cannot be uploaded from here.',
};

function filled(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, `${label} is required`);
  return text;
}

/** Only that the form is filled in; what the values MEAN (addresses, masks,
 *  ranges, duplicates) is py/rtac_vlan_deploy.py's validate(), which runs
 *  before AcRTAC starts, so a bad value still fails in a second. */
function validateDeploy(payload) {
  const raw = Array.isArray(payload?.rtacs) ? payload.rtacs : [];
  if (!raw.length) throw httpError(400, 'add at least one RTAC');
  return {
    switchIp: filled(payload.switchIp, 'Switch IP'),
    vlan: filled(payload.vlan, 'VLAN ID'),
    rtacs: raw.map((r, i) => ({
      networkIp: filled(r?.networkIp, `RTAC ${i + 1} network IP`),
      vlanIp: filled(r?.vlanIp, `RTAC ${i + 1} VLAN IP`),
      port: filled(r?.port, `RTAC ${i + 1} switch port`),
      project: filled(r?.project, `RTAC ${i + 1} project`),
    })),
  };
}

class VlanDeployService {
  constructor({ jobs }) {
    this.jobs = jobs;
  }

  start(payload) {
    const request = validateDeploy(payload);
    const n = request.rtacs.length;
    const job = this.jobs.start(`RTAC VLAN deploy: ${n} RTAC(s) → VLAN ${request.vlan}`, (handle) =>
      runStdinBridge(SCRIPT, request, {
        onStderrLine: handle.log,
        explain: EXPLAIN,
        timeoutMs: BASE_TIMEOUT_MS + n * PER_RTAC_TIMEOUT_MS,
      }));
    return { job: job.id };
  }
}

export { VlanDeployService, validateDeploy };
