// AcRTAC client — spawns py/acrtac_bridge.py for each call. The bridge owns
// the selacrtac session (login happens inside it) and prints one JSON
// document on stdout; anything on stderr becomes the error message.
//
// Requires Python with the selacrtac package on PATH.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaged, this file lives inside app.asar — but Python is a separate process
// and cannot read into the archive, so the bridge script is listed in
// electron-builder's asarUnpack and we point at the unpacked copy.
const BRIDGE = path
  .join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'py', 'acrtac_bridge.py')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const PYTHON = 'python';

// exportxml of a large project can take a while on a busy database.
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A readable one-liner instead of a Python traceback. The packaged app ships
 * without Python — the AcRTAC database panel is the only thing that needs it —
 * so "no module named selacrtac" is a normal state a user may sit in for a
 * long time, and it has to explain itself rather than look like a crash.
 */
function bridgeMessage(err, stderr) {
  if (err.killed) return `AcRTAC bridge timed out after ${BRIDGE_TIMEOUT_MS / 60000} minutes`;
  const text = String(stderr ?? '');
  if (err.code === 'ENOENT') {
    return 'Python was not found on PATH, so the AcRTAC database cannot be reached. Everything else works; install Python and the selacrtac package to browse and export projects from the database.';
  }
  if (/can't open file|No such file or directory/.test(text)) {
    return 'The AcRTAC bridge script could not be found, so the database cannot be reached. Everything else works.';
  }
  if (/No module named ['"]?selacrtac/.test(text)) {
    return "Python is installed but the selacrtac package is missing, so the AcRTAC database cannot be reached. Everything else works; install selacrtac to browse and export projects from the database.";
  }
  // Anything else: last non-empty stderr line, which is where Python puts the
  // actual error, rather than the whole traceback.
  const lines = text.trim().split(/[\r\n]+/).filter((l) => l.trim());
  return lines[lines.length - 1]?.trim() || err.message;
}

function runBridge(args) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [BRIDGE, ...args],
      { timeout: BRIDGE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // A killed process is almost always our timeout; execFile's own
          // message for it is unhelpfully generic.
          reject(new Error(bridgeMessage(err, stderr)));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`acrtac bridge returned non-JSON output: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

function createAcRtacClient() {
  return {
    async listProjects() {
      const result = await runBridge(['list']);
      return result.projects; // [{ name }]
    },

    async exportXml({ name, directory }) {
      await runBridge(['export', '--name', name, '--directory', directory]);
    },
  };
}

export { createAcRtacClient };
