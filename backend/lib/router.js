// The HTTP layer, on node:http alone. Routes are written the Express way —
// Router(), router.get('/:id', ...handlers), router.use('/prefix', child) —
// and see the same req/res surface they always did (req.params, req.query,
// req.body; res.status().json(), sendFile, download), so the route modules
// read as before. Only what this app uses is here: no view engines, no
// regex paths, no case folding.
//
// A handler may be async; a rejection (or a throw) goes to the app's error
// handler, the one place a coded error ({ status }) becomes a JSON response.
// A handler that takes `next` passes control on, the way upload middleware
// does.

import { createReadStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { httpError } from './http.js';

/** JSON request bodies above this are refused (413). */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

// --- responses -----------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function typeOf(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** RFC 6266 filename for a Content-Disposition header. */
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** One `bytes=a-b` range of a file of `size` bytes, or null to send it all. */
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  return start <= end ? { start, end } : 'unsatisfiable';
}

/** Stream a file. A missing file is a 404 for the error handler. */
async function sendFile(req, res, file, { attachment = null } = {}) {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw httpError(404, 'file not found');
  }
  if (!info.isFile()) throw httpError(404, 'file not found');
  if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', typeOf(file));
  if (attachment !== null) res.setHeader('Content-Disposition', disposition('attachment', attachment));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', info.mtime.toUTCString());
  const range = byteRange(req.headers.range, info.size);
  if (range === 'unsatisfiable') {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${info.size}`);
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  res.setHeader('Content-Length', info.size === 0 ? 0 : end - start + 1);
  if (req.method === 'HEAD' || info.size === 0) {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file, { start, end });
    stream.on('error', (err) => {
      if (res.headersSent) res.destroy(err);
      reject(err);
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

/** The Express-style helpers the routes call, on a plain ServerResponse. */
function decorate(req, res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (fields) => {
    for (const [name, value] of Object.entries(fields)) res.setHeader(name, value);
    return res;
  };
  res.type = (mime) => {
    res.setHeader('Content-Type', mime);
    return res;
  };
  res.send = (body) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body ?? '');
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/octet-stream');
    }
    res.setHeader('Content-Length', bytes.length);
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return res;
  };
  res.json = (value) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(JSON.stringify(value));
  };
  res.sendFile = (file) => sendFile(req, res, file);
  res.download = (file, name = path.basename(file)) => sendFile(req, res, file, { attachment: name });
}

// --- requests ------------------------------------------------------------------

/** The request's chunks, without destroying the socket when the reader
 *  stops early — the response still has to go out on it. */
function chunksOf(req) {
  return req.iterator({ destroyOnReturn: false });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of chunksOf(req)) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw httpError(413, 'request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The JSON body, when the request says it carries one. */
async function parseJson(req) {
  if (!/^application\/(.+\+)?json\b/i.test(req.headers['content-type'] ?? '')) return undefined;
  const text = (await readBody(req, MAX_JSON_BYTES)).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'request body is not valid JSON');
  }
}

/** URLSearchParams as an object; a repeated key becomes an array. */
function queryOf(search) {
  const out = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(out, key)) out[key] = value;
    else out[key] = [].concat(out[key], value);
  }
  return out;
}

// --- routing -------------------------------------------------------------------

function splitPath(p) {
  return p.split('/').filter(Boolean);
}

/** Match pattern segments against path segments; params, or null. With
 *  `prefix`, the path may run on past the pattern. */
function matchSegments(pattern, segments, prefix) {
  if (prefix ? segments.length < pattern.length : segments.length !== pattern.length) return null;
  const params = {};
  for (const [i, part] of pattern.entries()) {
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(segments[i]);
      } catch {
        return null;
      }
    } else if (part !== segments[i]) {
      return null;
    }
  }
  return params;
}

class Router {
  #layers = [];

  #add(method, pattern, handlers) {
    this.#layers.push({ method, pattern: splitPath(pattern), handlers: handlers.flat() });
    return this;
  }

  get(pattern, ...handlers) { return this.#add('GET', pattern, handlers); }
  post(pattern, ...handlers) { return this.#add('POST', pattern, handlers); }
  put(pattern, ...handlers) { return this.#add('PUT', pattern, handlers); }
  patch(pattern, ...handlers) { return this.#add('PATCH', pattern, handlers); }
  delete(pattern, ...handlers) { return this.#add('DELETE', pattern, handlers); }

  /** Mount a child router (or a handler) under `prefix`. */
  use(prefix, ...handlers) {
    if (typeof prefix !== 'string') return this.use('/', prefix, ...handlers);
    this.#layers.push({ method: null, pattern: splitPath(prefix), handlers: handlers.flat() });
    return this;
  }

  /**
   * Run the request through this router. `segments` is the path left after
   * the mounts above; resolves true once a handler has taken the request.
   */
  async handle(req, res, segments) {
    for (const layer of this.#layers) {
      const mount = layer.method === null;
      if (!mount && layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) continue;
      const params = matchSegments(layer.pattern, segments, mount);
      if (!params) continue;
      const outer = req.params;
      req.params = { ...outer, ...params };
      const rest = mount ? segments.slice(layer.pattern.length) : segments;
      if (await runHandlers(layer.handlers, req, res, rest)) return true;
      req.params = outer;
    }
    return false;
  }
}

/** Handlers in order; each either answers or calls next(). True when one
 *  answered (or a child router did). */
async function runHandlers(handlers, req, res, segments) {
  for (const handler of handlers) {
    if (handler instanceof Router) {
      if (await handler.handle(req, res, segments)) return true;
      continue;
    }
    let passed = false;
    await handler(req, res, () => {
      passed = true;
    });
    if (!passed) return true;
  }
  return false;
}

function createRouter() {
  return new Router();
}

/**
 * The node:http server for a root router. `fallback` answers what no route
 * took; `onError` shapes failures (default: JSON { error }).
 */
function createServer(router, { fallback = null } = {}) {
  // No whole-request deadline (node's default is 5 minutes): the server is
  // loopback-only, and a tool can stream GBs from a slow drive in one body.
  return http.createServer({ requestTimeout: 0 }, async (req, res) => {
    decorate(req, res);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      req.path = url.pathname;
      req.query = queryOf(url.search);
      req.params = {};
      req.body = await parseJson(req);
      const segments = splitPath(url.pathname);
      if (!(await router.handle(req, res, segments)) && fallback) await fallback(req, res);
      if (!res.headersSent && !res.writableEnded) res.status(404).json({ error: 'not found' });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.status(err?.status ?? 500).json({ error: err?.message ?? 'internal error' });
    }
  });
}

/** Serve files out of `root` for GET/HEAD; true when one was sent. */
async function serveStatic(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const base = path.resolve(root);
  let rel;
  try {
    rel = decodeURIComponent(req.path);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  let file = path.resolve(base, `.${rel}`);
  if (file !== base && !file.startsWith(base + path.sep)) return false;
  const info = await stat(file).catch(() => null);
  if (info?.isDirectory()) file = path.join(file, 'index.html');
  else if (!info?.isFile()) return false;
  await sendFile(req, res, file);
  return true;
}

// --- multipart -----------------------------------------------------------------

/** Name/value parameters of a header (`form-data; name="x"; filename*=…`). */
function headerParams(value) {
  const out = {};
  for (const m of String(value).matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    const key = m[1].toLowerCase();
    let v = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3].trim();
    if (key.endsWith('*')) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
      if (ext) {
        try {
          v = decodeURIComponent(ext[2]);
        } catch {
          continue;
        }
      }
      out[key.slice(0, -1)] = v;
    } else if (!Object.hasOwn(out, key)) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Parse a multipart/form-data request as it streams in. Text fields land in
 * req.body; files land in memory (`file.buffer`) or as temp files on disk
 * (`file.path`), each { fieldname, originalname, mimetype, size }. Over the
 * limits is a 413, before the rest of the body is read.
 */
async function parseMultipart(req, { disk, maxFileSize, maxFiles, fields }) {
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\b/i.test(type)) return { body: undefined, files: [] };
  const boundary = headerParams(type).boundary;
  if (!boundary) throw httpError(400, 'multipart boundary missing');

  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const body = {};
  const files = [];
  let buffer = Buffer.from('\r\n'); // so the first boundary reads like the rest
  let state = 'preamble';
  let part = null;
  let textBytes = 0;

  const startPart = async (headerText) => {
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const at = line.indexOf(':');
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const params = headerParams(headers['content-disposition'] ?? '');
    const name = params.name ?? '';
    if (params.filename === undefined) {
      part = { kind: 'text', name, chunks: [] };
      return;
    }
    if (fields && !fields.includes(name)) throw httpError(400, `unexpected file field "${name}"`);
    if (files.length >= maxFiles) throw httpError(413, 'too many files');
    const file = {
      fieldname: name,
      originalname: path.basename(params.filename.replaceAll('\\', '/')),
      mimetype: headers['content-type'] ?? 'application/octet-stream',
      size: 0,
    };
    files.push(file);
    if (disk) {
      file.path = path.join(os.tmpdir(), `projector-upload-${randomUUID()}`);
      part = { kind: 'file', file, handle: await open(file.path, 'w') };
    } else {
      part = { kind: 'file', file, chunks: [] };
    }
  };

  const write = async (bytes) => {
    if (!bytes.length) return;
    if (part.kind === 'text') {
      textBytes += bytes.length;
      if (textBytes > 1024 * 1024) throw httpError(413, 'form fields too large');
      part.chunks.push(bytes);
      return;
    }
    part.file.size += bytes.length;
    if (part.file.size > maxFileSize) throw httpError(413, `file too large: ${part.file.originalname}`);
    if (part.handle) await part.handle.write(bytes);
    else part.chunks.push(Buffer.from(bytes));
  };

  const endPart = async () => {
    if (part.kind === 'text') {
      body[part.name] = Buffer.concat(part.chunks).toString('utf8');
    } else if (part.handle) {
      await part.handle.close();
      part.handle = null;
    } else {
      part.file.buffer = Buffer.concat(part.chunks);
    }
    part = null;
  };

  try {
    for await (const chunk of chunksOf(req)) {
      // Past the closing boundary is the epilogue: read and ignored.
      if (state === 'done') continue;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (state === 'preamble') {
          const at = buffer.indexOf(delimiter);
          if (at < 0) {
            buffer = buffer.subarray(Math.max(0, buffer.length - delimiter.length));
            break;
          }
          buffer = buffer.subarray(at + delimiter.length);
          state = 'delimited';
        } else if (state === 'delimited') {
          if (buffer.length < 2) break;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            state = 'done';
            break;
          }
          const eol = buffer.indexOf('\r\n');
          if (eol < 0) break;
          buffer = buffer.subarray(eol + 2); // transport padding, then CRLF
          state = 'headers';
        } else if (state === 'headers') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 16 * 1024) throw httpError(400, 'multipart headers too large');
            break;
          }
          await startPart(buffer.subarray(0, end).toString('utf8'));
          buffer = buffer.subarray(end + 4);
          state = 'body';
        } else if (state === 'body') {
          const at = buffer.indexOf(delimiter);
          if (at < 0) {
            const safe = Math.max(0, buffer.length - delimiter.length + 1);
            await write(buffer.subarray(0, safe));
            buffer = buffer.subarray(safe);
            break;
          }
          await write(buffer.subarray(0, at));
          await endPart();
          buffer = buffer.subarray(at + delimiter.length);
          state = 'delimited';
        } else {
          break;
        }
      }
    }
    if (state !== 'done') throw httpError(400, 'multipart body ended early');
  } catch (err) {
    await part?.handle?.close().catch(() => {});
    await removeUploads(files);
    // Drain the rest of a refused upload so the answer can go out.
    req.resume();
    throw err;
  }
  return { body, files };
}

function removeUploads(files) {
  return Promise.all(files.filter((f) => f.path).map((f) => rm(f.path, { force: true })));
}

/**
 * Upload middleware. `single(field)` sets req.file, `array(field)` and
 * `fields([...names])` set req.files (an array, or { name: [file] }).
 * `disk` keeps files as temp files the route removes after use.
 */
function uploads({ disk = false, maxFileSize, maxFiles = 1 }) {
  const parse = (fields) => async (req) => {
    const { body, files } = await parseMultipart(req, { disk, maxFileSize, maxFiles, fields });
    if (body) req.body = body;
    return files;
  };
  return {
    single: (field) => async (req, _res, next) => {
      const [file] = await parse([field])(req);
      if (file) req.file = file;
      next();
    },
    array: (field) => async (req, _res, next) => {
      req.files = await parse([field])(req);
      next();
    },
    fields: (names) => async (req, _res, next) => {
      const files = await parse(names)(req);
      req.files = {};
      for (const file of files) (req.files[file.fieldname] ??= []).push(file);
      next();
    },
  };
}

export { createRouter as Router, createServer, serveStatic, uploads };
