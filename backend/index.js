// gridlink backend — settings-truth communications canvas.
//
// Loopback-only Express app: the Vite dev server proxies /api here. State is
// a data directory (artifact exports + workspace JSON) plus in-memory status.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';

import { createAcRtacClient } from './lib/acrtac/index.js';
import { compareRoutes } from './routes/compare.js';
import { projectRoutes } from './routes/projects.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { ProjectService } from './services/projects.js';
import { WorkspaceService } from './services/workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3003;
const DATA_DIR = path.join(HERE, 'data');

const client = createAcRtacClient();
const projects = new ProjectService({ client, dataDir: DATA_DIR });
await projects.init();
if (projects.listError) {
  console.warn(
    `Could not list projects from the AcRTAC database: ${projects.listError}\n` +
      'Serving previously exported projects; retry from the UI once the database is reachable.',
  );
}

const workspaces = new WorkspaceService({ dataDir: DATA_DIR, projects });
await workspaces.init();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api/projects', projectRoutes(projects));
app.use('/api/compare', compareRoutes(projects));
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
  console.log(`gridlink backend on http://127.0.0.1:${PORT}`);
});
