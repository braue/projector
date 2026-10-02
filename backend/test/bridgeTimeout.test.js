// A bridge that times out or is aborted takes its whole process tree with it
// (killTree in lib/acrtac/pythonClient.js): the stand-in bridge starts a
// grandchild — as a real one starts AcRtacCmd.exe — then hangs; after the
// timeout or abort both must be gone and the call must say which. An abort
// while still queued never starts the bridge. Skipped without Python.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { PYTHON, runStdinBridge } from '../lib/acrtac/pythonClient.js';
import { JobRegistry } from '../services/jobs.js';

const hasPython = spawnSync(PYTHON, ['-c', 'pass']).status === 0;

// Starts a long sleeper, reports its pid on stderr, then hangs.
const SCRIPT = `
import subprocess, sys, time
kid = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
print(f"grandchild {kid.pid}", file=sys.stderr, flush=True)
time.sleep(120)
`;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('bridge timeout: kills the grandchild too, and says it timed out',
  { skip: !hasPython && `no ${PYTHON} on PATH` }, async () => {
    // bridgePath() resolves names against backend/py, so the stand-in goes there.
    const name = `_timeout_probe_${process.pid}.py`;
    const script = path.join(import.meta.dirname, '..', 'py', name);
    await writeFile(script, SCRIPT);
    let pid = null;
    try {
      const call = runStdinBridge(name, {}, {
        acrtac: false,
        timeoutMs: 1500,
        onStderrLine: (line) => { pid = Number(line.match(/grandchild (\d+)/)?.[1]) || pid; },
      });
      // An orphaned grandchild holds the bridge's pipes, so the call would
      // hang until it ends by itself: settling promptly is half the point.
      const deadline = new Promise((_, reject) => setTimeout(
        () => reject(new Error('the call hung past its timeout')), 10000).unref());
      await assert.rejects(Promise.race([call, deadline]), /timed out/);
      assert.ok(pid, 'the bridge reported its grandchild');
      // the kill is asynchronous on Windows (taskkill); give it a moment
      for (let i = 0; i < 20 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(pid), false, 'the grandchild outlived the timeout');
    } finally {
      if (pid && alive(pid)) process.kill(pid);
      await rm(script, { force: true });
    }
  });

test('bridge abort: ■ kills the tree; a queued call never starts',
  { skip: !hasPython && `no ${PYTHON} on PATH` }, async () => {
    const name = `_abort_probe_${process.pid}.py`;
    const script = path.join(import.meta.dirname, '..', 'py', name);
    await writeFile(script, SCRIPT);
    const jobs = new JobRegistry();
    let pid = null;
    let queuedStarted = false;
    let first;
    let second;
    try {
      // the first holds the AcRTAC queue; the second waits behind it
      const a = jobs.start('first', (handle) => {
        first = runStdinBridge(name, {}, {
          job: handle,
          onStderrLine: (line) => { pid = Number(line.match(/grandchild (\d+)/)?.[1]) || pid; },
        });
        return first;
      });
      const b = jobs.start('second', (handle) => {
        second = runStdinBridge(name, {}, { job: handle, onStderrLine: () => { queuedStarted = true; } });
        return second;
      });
      for (let i = 0; i < 100 && !pid; i += 1) await new Promise((r) => setTimeout(r, 50));
      assert.ok(pid, 'the first bridge started its grandchild');

      jobs.abort(b.id); // still queued
      jobs.abort(a.id);
      const deadline = new Promise((_, reject) => setTimeout(
        () => reject(new Error('an aborted call hung')), 10000).unref());
      await assert.rejects(Promise.race([first, deadline]), /^Error: Aborted$/);
      await assert.rejects(Promise.race([second, deadline]), /^Error: Aborted$/);
      assert.equal(queuedStarted, false, 'the queued bridge ran after its abort');
      assert.equal(a.error, 'Aborted');
      for (let i = 0; i < 20 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(pid), false, 'the grandchild outlived the abort');
    } finally {
      if (pid && alive(pid)) process.kill(pid);
      await rm(script, { force: true });
    }
  });
