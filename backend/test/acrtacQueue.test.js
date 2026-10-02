// The machine-wide AcRTAC queue in lib/acrtac/pythonClient.js: AcRTAC bridge
// calls run one at a time, in order, a failure doesn't jam the queue, a
// waiting call says so, and a non-AcRTAC bridge never waits. Drives a real
// Python child (a tiny stand-in bridge script), skipped without Python.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PYTHON, runStdinBridge } from '../lib/acrtac/pythonClient.js';

const hasPython = spawnSync(PYTHON, ['-c', 'pass']).status === 0;

// A bridge that sleeps, then reports when it started and ended (or fails).
const SCRIPT = `
import json, sys, time
req = json.load(sys.stdin)
start = time.time()
time.sleep(req["sleep"])
if req.get("fail"):
    print("boom", file=sys.stderr); sys.exit(1)
json.dump({"id": req["id"], "start": start, "end": time.time()}, sys.stdout)
`;

test('acrtac queue: one session at a time, in order; opt-out runs alongside',
  { skip: !hasPython && `no ${PYTHON} on PATH` }, async () => {
    // bridgePath() resolves names against backend/py, so the stand-in goes there.
    const name = `_queue_probe_${process.pid}.py`;
    const script = path.join(import.meta.dirname, '..', 'py', name);
    await writeFile(script, SCRIPT);
    try {
      const waits = [];
      const job = { log: () => {}, waiting: (why) => waits.push(why), running: () => waits.push('running') };
      const a = runStdinBridge(name, { id: 'a', sleep: 0.4 });
      const b = runStdinBridge(name, { id: 'b', sleep: 0.1, fail: true }, { job });
      const c = runStdinBridge(name, { id: 'c', sleep: 0.1 });
      const free = runStdinBridge(name, { id: 'free', sleep: 0.1 }, { acrtac: false });

      const [ra, rb, rc, rfree] = await Promise.allSettled([a, b, c, free]);
      assert.equal(rb.status, 'rejected'); // a failure...
      assert.equal(rc.status, 'fulfilled'); // ...doesn't jam the queue
      assert.ok(rc.value.start >= ra.value.end, 'c waited for a (and b)');
      assert.ok(rfree.value.end < ra.value.end, 'the opt-out ran alongside a');
      // b's job showed as queued, then as working once its turn came
      assert.match(waits[0], /Waiting for another AcRTAC session/);
      assert.equal(waits[1], 'running');
    } finally {
      await rm(script, { force: true });
    }
  });
