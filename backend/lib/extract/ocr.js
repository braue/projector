// Optical character recognition — the text in photos, screenshots and
// scanned PDFs, which carry no text layer of their own.
//
// Tesseract (as WebAssembly, so nothing to install on the Windows machines
// this ships to) with the English model bundled — never fetched from a CDN,
// since a substation laptop is often offline. ONE worker for the process:
// recognition is CPU-bound and a second worker only splits the same cores.
// It runs in a worker thread, so the backend keeps answering while a 200-page
// scan grinds; jobs queue behind each other. Idle, the worker is terminated
// — it holds a couple of hundred MB of model and image buffers.

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Shut the worker down after this long with nothing to read. */
const IDLE_MS = 60_000;

/**
 * A path a worker thread can load. In the packaged app these modules live in
 * app.asar.unpacked (see package.json asarUnpack) because a worker thread
 * reads its script and the WASM core straight off the disk.
 */
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function resolvePaths() {
  const tesseractDir = path.dirname(require.resolve('tesseract.js/package.json'));
  return {
    workerPath: unpacked(path.join(tesseractDir, 'src', 'worker-script', 'node', 'index.js')),
    langPath: unpacked(require('@tesseract.js-data/eng').langPath),
  };
}

let worker = null;
let idleTimer = null;
let queue = Promise.resolve();

async function getWorker() {
  if (!worker) {
    const { createWorker } = require('tesseract.js');
    const { workerPath, langPath } = resolvePaths();
    worker = createWorker('eng', 1, {
      workerPath,
      langPath,
      gzip: true,
      // The model is already on disk; there is nothing worth caching.
      cacheMethod: 'none',
    }).catch((err) => {
      worker = null;
      throw err;
    });
  }
  return worker;
}

/** Stop the worker now (idle timeout, server shutdown, end of a test run). */
function shutdownOcr() {
  clearTimeout(idleTimer);
  const dying = worker;
  worker = null;
  return dying ? dying.then((w) => w.terminate()).catch(() => {}) : Promise.resolve();
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdownOcr, IDLE_MS);
  idleTimer.unref?.();
}

/**
 * The text Tesseract reads in one encoded image (PNG, JPEG, GIF, BMP, PGM).
 * Queued: callers share the one worker in arrival order. A failure is
 * marked `ocrFailure`, so a container's reader passes it up instead of
 * treating it as one unreadable entry.
 */
function recognize(image) {
  const run = queue.then(async () => {
    clearTimeout(idleTimer);
    try {
      const w = await getWorker();
      const { data } = await w.recognize(Buffer.from(image));
      return data.text ?? '';
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { ocrFailure: true });
    } finally {
      armIdle();
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** An RGBA (or BGRA) bitmap as a binary PGM: grey is all OCR wants, and the
 *  format is a 15-byte header over raw bytes — no encoder, no compression
 *  pass over a 25-megapixel drawing page. */
function bitmapToPgm({ data, width, height }) {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, 'ascii');
  const out = Buffer.allocUnsafe(header.length + width * height);
  header.copy(out, 0);
  for (let i = 0, o = header.length; i < width * height; i += 1, o += 1) {
    const p = i * 4;
    // Channel order does not matter much for luma; transparent = paper.
    const alpha = data[p + 3];
    const grey = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    out[o] = alpha === 0 ? 255 : grey;
  }
  return out;
}

export { bitmapToPgm, recognize, shutdownOcr };
