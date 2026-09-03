// Hand a path (or a file:// URL) to whatever the OS opens it with.
//
// Loopback deployment is what makes this honest: the backend runs on the same
// machine as the browser, so "open" means the user's own default app. Callers
// are responsible for confining the path first — see resolveWithin.

import { spawn } from 'node:child_process';
import path from 'node:path';

function openWithOs(target) {
  if (process.platform === 'win32') {
    // `start` resolves file associations; the empty "" is the window title
    // slot, so paths with spaces survive.
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

// Show a path IN the file manager rather than opening it: a directory opens
// as a folder window; a file opens its folder with the file selected where
// the platform can (Windows, macOS — Linux file managers take just the dir).
function revealWithOs(target, isDirectory) {
  if (process.platform === 'win32') {
    // explorer returns nonzero even on success; fire and forget like `start`.
    const args = isDirectory ? [target] : [`/select,${target}`];
    spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', isDirectory ? [target] : ['-R', target], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  openWithOs(isDirectory ? target : path.dirname(target));
}

export { openWithOs, revealWithOs };
