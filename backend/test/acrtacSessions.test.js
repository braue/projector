// inOwnSessions in lib/acrtac/pythonClient.js: a job's projects each get
// their own bridge, all at once; narration is tagged per project; one
// bridge failing is that project's failure, every bridge failing is the
// call's. Drives a real Python child, skipped without Python.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PYTHON, inOwnSessions, runStdinBridge } from '../lib/acrtac/pythonClient.js';

const hasPython = spawnSync(PYTHON, ['-c', 'pass']).status === 0;

// A bridge that narrates, sleeps, then reports when it ran (or fails).
const SCRIPT = `
import json, sys, time
req = json.load(sys.stdin)
print("working", file=sys.stderr, flush=True)
start = time.time()
time.sleep(0.4)
if req.get("fail"):
    print("boom " + req["id"], file=sys.stderr); sys.exit(1)
json.dump({"id": req["id"], "success": True, "start": start, "end": time.time()}, sys.stdout)
`;

test('acrtac sessions: one bridge per item, all at once, failures per item',
  { skip: !hasPython && `no ${PYTHON} on PATH` }, async () => {
    // bridgePath() resolves names against backend/py, so the stand-in goes there.
    const name = `_sessions_probe_${process.pid}.py`;
    await writeFile(path.join(import.meta.dirname, '..', 'py', name), SCRIPT);
    try {
      const lines = [];
      const job = { log: (line) => lines.push(line) };
      const run = (items) => inOwnSessions(items, {
        label: (item) => item.id,
        job,
        failed: (item, error) => ({ id: item.id, success: false, error }),
      }, (item, onStderrLine) => runStdinBridge(name, item, { job, onStderrLine }));

      const results = await run([{ id: 'a' }, { id: 'b', fail: true }, { id: 'c' }]);
      assert.deepEqual(results.map((r) => [r.id, r.success]), [['a', true], ['b', false], ['c', true]]);
      assert.match(results[1].error, /boom b/);
      const [a, , c] = results;
      assert.ok(c.start < a.end && a.start < c.end, 'a and c ran at the same time');
      assert.ok(lines.includes('[a] working') && lines.includes('[c] working'), 'narration tagged per item');

      // A lone item's narration is untagged.
      lines.length = 0;
      await run([{ id: 'solo' }]);
      assert.ok(lines.includes('working'));

      // Every bridge failing is the call failing, with the bridge's message.
      await assert.rejects(run([{ id: 'x', fail: true }, { id: 'y', fail: true }]), /boom/);
    } finally {
      await rm(path.join(import.meta.dirname, '..', 'py', name), { force: true });
    }
  });
