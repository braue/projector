// The backend's own process. electron/main.js forks this as an Electron
// utility process, so a backend crash — above all a V8 out-of-memory while
// parsing a huge RTAC export — takes down only the backend: the window stays
// up, shows "reconnecting", and main restarts this on the same port.
//
// Protocol with main (process.parentPort):
//   main → here   { type: 'start', options }   startServer's options
//   here → main   { type: 'ready', url, port } | { type: 'failed', message }
//   main → here   { type: 'close' }            shut down, then exit

import { startServer } from '../backend/server.js';

// A stray async failure is logged, not fatal — same as the dev entry point.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception:', err);
});

let handle = null;

process.parentPort.on('message', async ({ data }) => {
  if (data?.type === 'start') {
    try {
      handle = await startServer(data.options);
      process.parentPort.postMessage({ type: 'ready', url: handle.url, port: handle.port });
    } catch (err) {
      process.parentPort.postMessage({ type: 'failed', message: err?.message ?? String(err) });
      process.exit(1);
    }
  } else if (data?.type === 'close') {
    await handle?.close();
    process.exit(0);
  }
});
