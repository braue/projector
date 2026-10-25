// DRAFT ONLY — a canned test network (PROJECTOR_TEST_NETWORK_DEMO=1), shaped
// like py/test_network.py's output, for building the Test page away from
// the bench. Delete once the page has been run against 10.42.44.12.

const bench = [
  { id: '3555-1', kind: 'rtac', networkIp: '10.42.44.34', port: '3' },
  { id: '3532-3', kind: 'rtac', networkIp: '10.42.44.35', port: '4' },
  { id: '3555-2', kind: 'rtac', networkIp: '10.42.44.36', port: '5' },
  { id: '3350-1', kind: 'rtac', networkIp: '10.42.44.25', port: '7' },
  { id: '3350-2', kind: 'rtac', networkIp: '10.42.44.26', port: '8' },
  { id: '3530-1', kind: 'rtac', networkIp: '10.42.44.40', port: '11' },
  { id: '3555-3', kind: 'rtac', networkIp: '10.42.44.37', port: '12' },
  { id: 'Pi', kind: 'other', networkIp: '10.42.44.50', port: '24' },
  { id: 'Laptop', kind: 'other', networkIp: '', port: '23' },
];

const vlans = [
  { vid: 1, name: 'Default', untagged: [1, 2, 6, 9, 10, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23], tagged: [] },
  { vid: 14, name: 'Eunice', untagged: [3, 4, 5], tagged: [24] },
  { vid: 16, name: 'Gulfport', untagged: [7, 8], tagged: [24] },
  { vid: 20, name: 'Evergreen', untagged: [11, 12], tagged: [24] },
  { vid: 30, name: 'Spare', untagged: [], tagged: [] },
];

const devices = [
  { id: '3555-1', eth02: '172.16.14.10/24', gateway: '172.16.14.1', project: { name: 'Eunice_35KV_DAC', state: 'running' }, error: null },
  { id: '3532-3', eth02: '172.16.14.11/24', gateway: '172.16.14.1', project: { name: 'Eunice_35KV_REM1', state: 'running' }, error: null },
  { id: '3555-2', eth02: '172.16.14.12/24', gateway: '172.16.14.1', project: { name: 'Eunice_35KV_REM2', state: 'stopped' }, error: null },
  { id: '3350-1', eth02: '172.16.16.10/24', gateway: '172.16.16.1', project: { name: 'Gulfport_DAC', state: 'running' }, error: null },
  { id: '3350-2', eth02: '172.16.16.11/24', gateway: '172.16.16.1', project: { name: 'Gulfport_SIM_Master', state: 'running' }, error: null },
  { id: '3530-1', eth02: '172.16.20.10/24', gateway: '172.16.20.1', project: { name: 'Evergreen_DAC', state: 'running' }, error: null },
  { id: '3555-3', eth02: null, gateway: null, project: null, error: 'https://10.42.44.37/: timed out' },
];

async function demoBridge(request) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (request.command === 'eth02') {
    const id = bench.find((d) => d.networkIp === request.networkIp)?.id;
    const device = devices.find((d) => d.id === id);
    if (!device || device.error) throw new Error(`https://${request.networkIp}/: timed out`);
    const after = `${request.ip.replace(/\/24$/, '')}/24`;
    const before = device.eth02;
    Object.assign(device, { eth02: after, gateway: after.replace(/\.\d+\/24$/, '.1') });
    return { before, after, gateway: device.gateway, changed: before !== after };
  }
  if (request.command === 'move') {
    const from = vlans.find((v) => v.untagged.includes(request.port));
    for (const v of vlans) v.untagged = v.untagged.filter((p) => p !== request.port);
    const to = vlans.find((v) => v.vid === request.vid);
    to.untagged = [...to.untagged, request.port].sort((a, b) => a - b);
    return { port: request.port, from: from?.vid ?? null, to: to.vid, changed: true, vlans: structuredClone(vlans) };
  }
  return {
    bench,
    switch: {
      ip: '10.42.44.12',
      ports: Array.from({ length: 24 }, (_, i) => i + 1),
      error: null,
      vlans: structuredClone(vlans),
    },
    devices: structuredClone(devices),
  };
}

export { demoBridge };
