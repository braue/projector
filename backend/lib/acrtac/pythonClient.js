// AcRTAC client — spawns py/acrtac_bridge.py for each call. The bridge owns
// the selacrtac session (login happens inside it) and prints one JSON
// document on stdout; anything on stderr becomes the error message.
//
// Requires Python with the selacrtac package on PATH.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'py', 'acrtac_bridge.py');

const PYTHON = 'python';

// exportxml of a large project can take a while on a busy database.
const BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;

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
          const message = err.killed
            ? `acrtac bridge timed out after ${BRIDGE_TIMEOUT_MS / 60000} minutes`
            : stderr.trim() || err.message;
          reject(new Error(message));
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
