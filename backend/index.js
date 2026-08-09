// purview backend — settings-truth communications canvas.
//
// Loopback-only Express app: the Vite dev server proxies /api here. State is
// a data directory (artifact exports + workspace JSON) plus in-memory status.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { createAcRtacClient } from './lib/acrtac/pythonClient.js';
import { extractRdbProfile } from './lib/comm/extract/rdb.js';
import { extractRtacProfile } from './lib/comm/extract/rtac.js';
import { attachmentWarning, augmentProfile, extractScdProfile } from './lib/comm/extract/scd.js';
import { compareRoutes } from './routes/compare.js';
import { projectRoutes } from './routes/projects.js';
import { rdbRoutes } from './routes/rdb.js';
import { scdRoutes } from './routes/scd.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { CompareService } from './services/compare.js';
import { ProjectService } from './services/projects.js';
import { RdbService } from './services/rdb.js';
import { ScdService } from './services/scd.js';
import { WorkspaceService } from './services/workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURVIEW_API_PORT ?? process.env.PORT ?? 3003);
const DATA_DIR = path.join(HERE, 'data');

const client = createAcRtacClient();
const projects = new ProjectService({ client, dataDir: DATA_DIR });
const rdb = new RdbService({ dataDir: DATA_DIR });
const scd = new ScdService({ dataDir: DATA_DIR });
const workspaces = new WorkspaceService({
  dataDir: DATA_DIR,
  resolvers: {
    rtac: async (ref) => extractRtacProfile(await projects.model(ref), ref),
    rdb: async (ref) => extractRdbProfile(rdb.profile(ref), ref),
    scd: async (ref) => extractScdProfile(scd.profile(ref), ref),
  },
  augment: async (baseProfile, ref) => {
    const scdProfile = extractScdProfile(scd.profile(ref), ref);
    return {
      profile: augmentProfile(baseProfile, scdProfile),
      warning: attachmentWarning(baseProfile, scdProfile),
    };
  },
});
const compare = new CompareService({
  adapters: {
    rtac: (ref) => projects.comparable(ref),
    rdb: (ref) => rdb.comparable(ref),
    scd: (ref) => scd.comparable(ref),
  },
});
await Promise.all([projects.init(), rdb.init(), scd.init(), workspaces.init()]);

// The database list can take a while (it spawns the Python bridge) and the
// server is useful without it — exports on disk, RDB uploads, workspaces —
// so refresh it in the background rather than blocking listen().
projects.refreshList().then((listError) => {
  if (listError) {
    console.warn(
      `Could not list projects from the AcRTAC database: ${listError}\n` +
        'Serving previously exported projects; retry from the UI once the database is reachable.',
    );
  }
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/projects', projectRoutes(projects));
app.use('/api/compare', compareRoutes(compare));
app.use('/api/rdb', rdbRoutes(rdb));
app.use('/api/scd', scdRoutes(scd));
app.use('/api/workspaces', workspaceRoutes(workspaces));

// The API always speaks JSON, including for failures the routers never see.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'no such endpoint' });
});
// eslint-disable-next-line no-unused-vars -- Express keys on the arity.
app.use((err, _req, res, _next) => {
  res.status(err?.status ?? 500).json({ error: err?.message ?? 'internal error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`purview backend on http://127.0.0.1:${PORT}`);
});
