// The desktop shell. Starts projector's own Express server in this process and
// points a window at it, so the packaged app is one process and the UI and API
// share an origin (no proxy, no CORS, no second port to coordinate).
//
// Two things must differ from the dev-server layout, and both are the reason
// server.js takes them as parameters:
//
//   - The PORT is 0. The installed app cannot assume 3003 is free — the dev
//     server, or anything else, may hold it. The OS picks, and the window is
//     told where to look.
//   - The DATA DIRECTORY is under the user's profile. The install lives in
//     Program Files, which is read-only for a normal user, so projects would
//     be unsaveable if the store stayed next to the code.

import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, Menu, app, dialog, shell } from 'electron';

import { INDEX_FILENAME } from '../backend/lib/selPaths.js';
import { startServer } from '../backend/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// Set by `npm run app:dev` to attach the window to the Vite dev server instead
// of the built bundle, so the desktop shell is debuggable with hot reload.
const DEV_URL = process.env.PROJECTOR_DEV_URL ?? null;

let serverHandle = null;

// The backend runs in THIS process, and a big RTAC export parses into a
// model of a gigabyte and more. The artifacts cache bounds how many stay
// live, but one comparison of two large exports legitimately needs several
// GB — above V8's default ~4 GB ceiling, and a heap OOM here aborts the
// whole app. Raise the ceiling; the OS only commits what is actually used.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=12288');

// GPU self-healing. Chromium aborts the WHOLE app ("GPU process isn't
// usable. Goodbye.") once its GPU process has crashed too many times — seen
// in the wild here on an NVIDIA card while several inspect/compare views
// were open. The escape hatch is software rendering, which this DOM-heavy
// app barely notices. It has to be chosen before app ready, so a crash in
// one run leaves a marker that the next run reads:
//
//   - first GPU-process crash: write the marker (the next launch is safe)
//   - second crash in the same run: relaunch ourselves into software
//     rendering now, before Chromium reaches its own fatal limit
//
// The marker sticks until the user opts back in via the Help menu.
const GPU_MARKER = path.join(app.getPath('userData'), 'disable-gpu');
const gpuFallback = existsSync(GPU_MARKER);
if (gpuFallback) app.disableHardwareAcceleration();

let gpuCrashes = 0;
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return;
  if (!['crashed', 'abnormal-exit', 'killed', 'launch-failed'].includes(details.reason)) return;
  console.warn(`GPU process gone (${details.reason}, exit ${details.exitCode})`);
  try {
    writeFileSync(
      GPU_MARKER,
      'Projector runs without GPU acceleration because the GPU process crashed.\n'
      + 'Delete this file (or use Help > Re-enable GPU acceleration) to try again.\n',
    );
  } catch {
    // Losing the marker only loses the fallback, never the session.
  }
  gpuCrashes += 1;
  if (gpuCrashes >= 2 && !gpuFallback) {
    app.relaunch();
    app.exit(0);
  }
});

/**
 * One window at a time. A second launch (double-clicking the icon again)
 * raises the existing one rather than starting a second server.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });
  app.whenReady().then(start);
}

async function start() {
  let url;
  try {
    serverHandle = await startServer({
      port: 0,
      dataDir: path.join(app.getPath('userData'), 'data'),
      // In dev the Vite server owns the UI; packaged, we serve the build.
      staticDir: DEV_URL ? null : path.join(ROOT, 'frontend', 'dist'),
      version: app.getVersion(),
      // The index travels with the installer, unpacked beside app.asar so
      // SQLite can open it as a real file. From source, server.js defaults to
      // the repo-root copy that `npm run sel:index` writes.
      selIndex: app.isPackaged ? path.join(process.resourcesPath, INDEX_FILENAME) : undefined,
    });
    url = DEV_URL ?? serverHandle.url;
  } catch (err) {
    dialog.showErrorBox(
      'Projector could not start',
      `${err?.message ?? err}\n\nIf this keeps happening, the data folder may be unwritable:\n${app.getPath('userData')}`,
    );
    app.quit();
    return;
  }

  createWindow(url);
  Menu.setApplicationMenu(buildMenu());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
  });
}

/**
 * A small menu, mostly so the version and the data folder are reachable
 * without a terminal. Reload and devtools stay because a loopback web app is
 * occasionally worth poking at.
 *
 * There is no "check for updates" here on purpose: the app never reaches the
 * network. Upgrading means running a newer installer, which is a thing someone
 * hands you, not a thing the app goes looking for.
 */
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Exit Projector' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open the data folder',
          click: () => shell.openPath(path.join(app.getPath('userData'), 'data')),
        },
        ...(gpuFallback ? [{
          label: 'Re-enable GPU acceleration (restarts)',
          click: () => {
            try {
              rmSync(GPU_MARKER, { force: true });
            } catch {
              return;
            }
            app.relaunch();
            app.quit();
          },
        }] : []),
        { type: 'separator' },
        {
          label: `Projector ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ]);
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // Painting the window in the app's own background stops the white flash
    // before the first render.
    backgroundColor: '#ffffff',
    show: false,
    title: 'Projector',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      // The renderer is an ordinary web page talking to a loopback HTTP API.
      // It needs no Node access, so it does not get any.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(url);

  // Anything aimed elsewhere — a documentation link, an external site — opens
  // in the real browser rather than replacing the app with a web page.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  if (DEV_URL) win.webContents.openDevTools({ mode: 'detach' });
}

app.on('window-all-closed', () => {
  app.quit();
});

// Let the HTTP server release its port and finish any write before we go —
// but never let that stall the quit. An installer replacing this app is
// waiting for the process to exit, so a hang here is a hung upgrade.
app.on('will-quit', (event) => {
  if (!serverHandle) return;
  const handle = serverHandle;
  serverHandle = null;
  event.preventDefault();
  // Seen in the wild on Linux: the re-entered quit stalls somewhere in the
  // shutdown sequence, leaving a zombie window with a dead backend that
  // still holds the single-instance lock. The failsafe makes quit mean
  // quit: if the graceful path has not finished shortly after the server
  // is down, exit hard.
  handle.close().finally(() => {
    setTimeout(() => app.exit(0), 3000);
    app.quit();
  });
});
