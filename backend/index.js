// Development entry point: the API alone, on a fixed port, with the Vite dev
// server in front of it. The app itself lives in server.js, which the packaged
// Electron build starts directly — see ../electron/main.js.

import { startServer } from './server.js';

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
});

const { url } = await startServer();
console.log(`projector backend on ${url}`);
