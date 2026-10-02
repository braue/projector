// Python bridge runner. Every AcRTAC feature (and the DAC SIM converter) is
// a script in py/ that takes one JSON request on stdin, narrates on stderr,
// and prints one JSON result on stdout. This module spawns them, queues the
// AcRTAC ones machine-wide, and shapes their failures into one-liners. The
// AcRTAC database itself (list + export) is one bridge, py/acrtac_bridge.py,
// behind createAcRtacClient below.
//
// Requires Python with the selacrtac package on PATH.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PYTHON = 'python';

// Python's stdio speaks the console code page on Windows (cp1252), with
// stderr set to backslashreplace: narration like "✓ … → …" reached the job
// log as "\u2713", and "—"/"…" as cp1252 bytes Node's UTF-8 decode turned
// into "?". Every bridge talks UTF-8 on all three pipes instead (stdin
// too — project names travel in on it). Only the pipes: PYTHONUTF8 would
// also change open()'s default, which the vendored converters rely on.
const PYTHON_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8' };

// exportxml of a large project can take a while on a busy database.
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A readable one-liner instead of a Python traceback. The packaged app ships
 * without Python — the AcRTAC-backed features are the only things that need
 * it — so "no module named selacrtac" is a normal state a user may sit in for
 * a long time, and it has to explain itself rather than look like a crash.
 *
 * `explain` swaps in per-feature wording for a failure class where the
 * default AcRTAC-panel phrasing doesn't fit (the DAC SIM converter names its
 * own feature): { timeout, python, script, selacrtac }.
 */
function bridgeMessage(err, stderr, explain = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  if (err.killed) {
    return explain.timeout
      ?? `Python bridge timed out after ${Math.round(timeoutMs / 60000)} minutes`;
  }
  const text = String(stderr ?? '');
  if (err.code === 'ENOENT') {
    return explain.python
      ?? 'Python was not found on PATH, so the AcRTAC database cannot be reached. Everything else works; install Python and the selacrtac package to browse and export projects from the database.';
  }
  if (/can't open file/.test(text)) {
    return explain.script
      ?? 'The AcRTAC bridge script could not be found, so the database cannot be reached. Everything else works.';
  }
  if (/No module named ['"]?selacrtac/.test(text)) {
    return explain.selacrtac
      ?? "Python is installed but the selacrtac package is missing, so the AcRTAC database cannot be reached. Everything else works; install selacrtac to browse and export projects from the database.";
  }
  // Anything else: last non-empty stderr line, which is where Python puts the
  // actual error, rather than the whole traceback.
  const lines = text.trim().split(/[\r\n]+/).filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() || err.message || 'Python bridge failed with no error output';
}

// One AcRTAC session at a time, machine-wide. Every AcRTAC bridge starts its
// own AcRtacCmd process against the one local database; two at once race each
// other (an export mid-flight while an import or upload opens projects), so
// bridge calls queue here rather than each feature inventing its own
// batching. A waiting call's job says so (its `waiting` reason, shown in the
// tasks popover), and its timeout starts when its session does. Held until
// the call settles — for acrtac_open, when the bridge exits, leaving the GUI
// it launched behind.
let acrtacTail = Promise.resolve();
let acrtacQueued = 0;

function inAcrtacQueue(job, fn) {
  if (acrtacQueued > 0) job?.waiting?.('Waiting for another AcRTAC session to finish…');
  acrtacQueued += 1;
  const run = acrtacTail.then(() => {
    job?.running?.();
    return fn();
  });
  acrtacTail = run.then(() => {}, () => {}).finally(() => { acrtacQueued -= 1; });
  return run;
}

/** Resolve a bridge script path. Packaged, this file lives inside app.asar —
 *  but Python is a separate process and cannot read into the archive, so the
 *  scripts are listed in electron-builder's asarUnpack and we point at the
 *  unpacked copy. */
function bridgePath(scriptName) {
  return path
    .join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'py', scriptName)
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

/**
 * One bridge invocation: `request` travels as JSON on stdin, the result is
 * the JSON document printed on stdout. Stderr is the bridge's narration
 * channel; its tail is kept either way to shape a failure via bridgeMessage,
 * with `explain` passed through for per-feature wording.
 *
 * `job`: the job handle (services/jobs.js) this call works for. Its
 * narration streams into the job's log, and a wait in the AcRTAC queue shows
 * as the job's `waiting` reason. `onStderrLine` overrides where lines go.
 *
 * `timeoutMs`: kill the bridge after this long (default 30 minutes) — for a
 * bridge whose work scales with its request, like a run of device uploads.
 *
 * `acrtac` (default true): the bridge opens an AcRTAC session, so it waits
 * its turn in the machine-wide queue (see inAcrtacQueue). Pass false for a
 * bridge that never touches AcRTAC.
 *
 * `settleOnExit`: for a bridge that deliberately leaves a GRANDCHILD running
 * (acrtac_open.py's GUI). The grandchild inherits the stdio pipes and holds
 * them open, so 'close' — which waits for every piped fd — never fires;
 * 'exit' fires when the bridge itself ends. Its final stdout gets a beat to
 * drain, then the call settles on what arrived.
 */
function runStdinBridge(script, request, {
  job = null, onStderrLine = job?.log, explain, settleOnExit = false,
  timeoutMs = BRIDGE_TIMEOUT_MS, acrtac = true,
} = {}) {
  const run = () => spawnStdinBridge(script, request, { onStderrLine, explain, settleOnExit, timeoutMs });
  return acrtac ? inAcrtacQueue(job, run) : run();
}

/**
 * Kill a bridge AND everything it started. A bridge's AcRtacCmd.exe (and its
 * upload workers, and acrtac_open's GUI) are its children; killing only the
 * Python process orphans them, still logged in to the database, to collide
 * with the next session the queue lets through. Windows: taskkill /T walks
 * the tree by parent pid (so it must run while the bridge is alive). Elsewhere
 * the bridge leads its own process group (spawned `detached`), and the group
 * goes.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function spawnStdinBridge(script, request, { onStderrLine, explain, settleOnExit, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [bridgePath(script)], {
      windowsHide: true,
      env: PYTHON_ENV,
      // its own process group, so a timeout can kill the whole tree (killTree);
      // on Windows `detached` would mean a new console instead, and taskkill
      // needs no group
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let settled = false;
    let timedOut = false;
    const lastLines = [];
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const fail = (err) => reject(new Error(bridgeMessage(err, lastLines.join('\n'), explain, timeoutMs)));
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || signal || timedOut) {
        // taskkill ends the bridge with an exit code, not a signal
        fail({ killed: timedOut || Boolean(signal), code });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${script} returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      onStderrLine?.(line);
      lastLines.push(line);
      if (lastLines.length > 30) lastLines.shift();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(err);
    });
    child.on('close', finish);
    if (settleOnExit) {
      child.on('exit', (code, signal) => setTimeout(() => {
        finish(code, signal);
        // The grandchild keeps the pipes open forever; let go of our ends.
        child.stdout.destroy();
        child.stderr.destroy();
      }, 300));
    }
    child.stdin.end(JSON.stringify(request));
  });
}

const ACRTAC_BRIDGE = 'acrtac_bridge.py';

/** The AcRTAC database: its project list, and exports out of it. */
function createAcRtacClient() {
  return {
    /** Every project name in the database, sorted. */
    async listProjects() {
      return (await runStdinBridge(ACRTAC_BRIDGE, { command: 'list' })).projects;
    },

    /** Export `projects` into `directory` — a folder of XML or one .exp file
     *  each — narrating to `job`. Resolves to one result per project
     *  ({ project, success, output | error }); one project failing never
     *  stops the rest. `flat` puts a single project's XML straight into
     *  `directory` instead of a subfolder named after it. */
    async export({ projects, format = 'xml', directory, projectPassword = null, flat = false, job = null }) {
      const { results } = await runStdinBridge(ACRTAC_BRIDGE, {
        command: 'export', projects, format, directory, projectPassword, flat,
      }, { job });
      return results;
    },
  };
}

export { createAcRtacClient, bridgeMessage, bridgePath, killTree, runStdinBridge, PYTHON };
