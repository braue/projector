// purview backend — settings-truth communications canvas.
//
// Loopback-only Express app: the Vite dev server proxies /api here. State is
// a data directory of self-contained projects (each holding its own RTAC
// exports, uploads, and canvas) plus the machine-global AcRTAC catalog.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { createAcRtacClient } from './lib/acrtac/pythonClient.js';
import { projectRoutes } from './routes/projects.js';
import { ProjectsService } from './services/projects.js';
import { RtacCatalog } from './services/rtacCatalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PURVIEW_API_PORT ?? process.env.PORT ?? 3003);
const DATA_DIR = path.join(HERE, 'data');

const catalog = new RtacCatalog({ client: createAcRtacClient() });
const projects = new ProjectsService({ dataDir: DATA_DIR, catalog });
await projects.init();

// The database list can take a while (it spawns the Python bridge) and the
// server is useful without it — projects on disk are fully browsable — so
// refresh it in the background rather than blocking listen().
catalog.refresh().then((listError) => {
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
app.use('/api/projects', projectRoutes(projects, catalog));

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
