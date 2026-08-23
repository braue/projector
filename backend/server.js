// projector backend — settings-truth communications canvas.
//
// Loopback-only Express app. Two ways in:
//
//   - DEVELOPMENT: `npm run dev` runs index.js, the Vite dev server serves the
//     UI on its own port and proxies /api here.
//   - PACKAGED: the Electron main process calls startServer() and points a
//     window at the returned URL. There is no proxy then — this server also
//     serves the built frontend, so the UI and the API share one origin.
//
// State is a data directory of self-contained projects (each holding its own
// RTAC exports, uploads, and canvas) plus the machine-global AcRTAC catalog
// and SEL document library. The data directory is a parameter because the
// packaged app must write under the user's profile, not into Program Files.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { createAcRtacClient } from './lib/acrtac/pythonClient.js';
import { DEFAULT_SEL_ROOT } from './lib/selPaths.js';
import { projectRoutes } from './routes/projects.js';
import { selRoutes } from './routes/sel.js';
import { ProjectsService } from './services/projects.js';
import { RtacCatalog } from './services/rtacCatalog.js';
import { SelFullText } from './services/selFullText.js';
import { SelLibrary } from './services/selLibrary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';

/** Where projects live when nobody says otherwise (the dev-server layout). */
const DEFAULT_DATA_DIR = path.join(HERE, 'data');

/**
 * The app version, so the UI can show what is running — the first question
 * to ask anyone reporting a problem, and the only way to tell at a glance
 * whether an upgrade took. Electron passes its own (authoritative); this
 * fallback covers running from source.
 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the app on the loopback interface.
 *
 * @param {object} [options]
 * @param {number} [options.port]      0 asks the OS for a free one — what the
 *                                     packaged app wants, since 3003 may be
 *                                     taken by anything.
 * @param {string} [options.dataDir]   project store.
 * @param {string|null} [options.staticDir] built frontend to serve at /, or
 *                                     null to run API-only behind Vite.
 * @param {string} [options.version]   shown in the UI; Electron passes its own.
 * @param {string|null} [options.selIndex] the SEL full-text index shipped with
 *                                     the app, when there is one. Packaged
 *                                     only; running from source has none.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer(options = {}) {
  const {
    port = Number(process.env.PROJECTOR_API_PORT ?? process.env.PORT ?? 3003),
    dataDir = process.env.PROJECTOR_DATA ?? DEFAULT_DATA_DIR,
    staticDir = null,
    version = readVersion(),
    selIndex = null,
    log = console.log,
  } = options;

  // The SEL PDF library — this machine's own folder rather than project state;
  // override with SEL_LIBRARY if it lives somewhere else.
  const selRoot = process.env.SEL_LIBRARY ?? DEFAULT_SEL_ROOT;

  const catalog = new RtacCatalog({ client: createAcRtacClient() });
  const selLibrary = new SelLibrary({ root: selRoot });
  const selText = new SelFullText();
  selText.open({ libraryRoot: selRoot, dataDir, bundled: selIndex });
  const projects = new ProjectsService({ dataDir, catalog });
  await projects.init();

  // The database list can take a while (it spawns the Python bridge) and the
  // server is useful without it — projects on disk are fully browsable — so
  // refresh it in the background rather than blocking listen(). The packaged
  // app ships without Python at all, which lands here every time.
  catalog.refresh().then((listError) => {
    if (listError) log(`AcRTAC database unavailable: ${listError}`);
  });

  const textStatus = selText.status();
  if (textStatus.available) {
    log(`SEL full text: ${textStatus.pages} pages from ${textStatus.documents} documents (${textStatus.sizeMb} MB)`);
  } else if (textStatus.error) {
    log(`SEL full-text index unusable: ${textStatus.error}`);
  } else {
    // Different advice depending on who is reading: a packaged install has no
    // npm scripts, and its index should have shipped with it.
    log(selIndex
      ? `No SEL full-text index — none shipped at ${selIndex}, and none beside the library.`
      : 'No SEL full-text index; run `npm run sel:index` to build one.');
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version });
  });
  app.use('/api/projects', projectRoutes(projects, catalog));
  app.use('/api/sel', selRoutes(selLibrary, selText));

  // The API always speaks JSON, including for failures the routers never see.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'no such endpoint' });
  });

  // Packaged mode: serve the built UI from this same origin. The SPA has no
  // router, so the index fallback is only there to survive a manual reload on
  // a deep URL.
  if (staticDir) {
    app.use(express.static(staticDir, { index: 'index.html' }));
    app.use((_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars -- Express keys on the arity.
  app.use((err, _req, res, _next) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'internal error' });
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const actual = server.address().port;
  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    /**
     * Shut down without hanging. `server.close()` alone waits for existing
     * connections to end, and the UI holds keep-alive sockets — which is
     * enough to stop the app from ever quitting, and to leave an installer
     * that is waiting for it to exit stuck forever. Drop the sockets, and
     * give up after a moment regardless.
     */
    close: () =>
      new Promise((resolve) => {
        const done = setTimeout(resolve, 2000);
        server.close(() => {
          clearTimeout(done);
          resolve();
        });
        server.closeAllConnections?.();
      }),
  };
}
