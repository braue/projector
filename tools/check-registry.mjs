#!/usr/bin/env node
// Can this machine's npm registry supply every package Projector installs?
//
//   node tools/check-registry.mjs [--registry <url>] [--platform win32-x64] [--json <file>]
//
// For the company Artifactory: `npm ci` stops at the first package a policy
// (JFrog Curation, Xray) blocks, so proving the whole build is allowed takes
// one blocked package at a time. This asks for every tarball in the three
// lockfiles (root = Electron + electron-builder, backend, frontend) — the
// exact versions an install would fetch, dev dependencies included since
// building the installer needs them — and reports every refusal at once.
//
// Each tarball is requested the way npm would: the lockfile's
// registry.npmjs.org URL rewritten onto the configured registry, with the
// .npmrc credentials for it. The download is a real GET (Curation decides
// on the download, not the metadata), cut off once the status is known.
//
// Platform-specific optional packages for another OS (the frontend's native
// rolldown/lightningcss builds) are checked but reported apart: a Windows
// build never installs them. Exit code 1 when a needed package fails.
//
// Not covered: what electron-builder downloads at build time from GitHub
// rather than npm (the Electron zip, NSIS, winCodeSign). The Electron zip is
// probed at the end; see ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR
// if those are blocked too.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILES = ['package-lock.json', 'backend/package-lock.json', 'frontend/package-lock.json'];
const PUBLIC = 'https://registry.npmjs.org/';
const CONCURRENCY = 8;
const TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function npmConfig(key) {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['config', 'get', key],
      { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  } catch {
    return '';
  }
}

const registry = (opt('--registry') || npmConfig('registry') || PUBLIC).replace(/\/?$/, '/');
const [targetOs, targetCpu] = (opt('--platform') || 'win32-x64').split('-');

// --- credentials, as npm finds them --------------------------------------------
//
// `npm config get` prints "(protected)" for auth values, so the .npmrc files
// are read directly: project, user, global. The most specific
// "//host/path/:key" whose path prefixes the registry wins.

function npmrcFiles() {
  const files = [path.join(ROOT, '.npmrc'), process.env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), '.npmrc')];
  const global = npmConfig('globalconfig');
  if (global) files.push(global);
  return files.filter((f) => existsSync(f));
}

function readNpmrc() {
  const entries = new Map();
  // later files are less specific: keep the first value seen
  for (const file of npmrcFiles()) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
        .replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
      if (!entries.has(key)) entries.set(key, value);
    }
  }
  return entries;
}

function authHeader(npmrc) {
  const url = new URL(registry);
  const target = `//${url.host}${url.pathname}`;
  let best = null;
  for (const key of npmrc.keys()) {
    const m = key.match(/^(\/\/.+?):(_authToken|_auth|_password|username)$/);
    if (!m || !target.startsWith(m[1].replace(/\/?$/, '/'))) continue;
    if (!best || m[1].length > best.length) best = m[1];
  }
  const get = (k) => (best ? npmrc.get(`${best}:${k}`) : undefined) ?? (k === '_auth' ? npmrc.get('_auth') : undefined);
  if (get('_authToken')) return `Bearer ${get('_authToken')}`;
  if (get('_auth')) return `Basic ${get('_auth')}`;
  if (get('username') && get('_password')) {
    const pass = Buffer.from(get('_password'), 'base64').toString();
    return `Basic ${Buffer.from(`${get('username')}:${pass}`).toString('base64')}`;
  }
  return null;
}

// --- the packages ------------------------------------------------------------------

function lockedPackages() {
  const byKey = new Map();
  for (const rel of LOCKFILES) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) continue;
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    for (const [where, p] of Object.entries(lock.packages ?? {})) {
      if (!where || p.link || !p.resolved) continue;
      const name = p.name ?? where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const key = `${name}@${p.version}`;
      const otherPlatform = (p.os && !p.os.includes(targetOs)) || (p.cpu && !p.cpu.includes(targetCpu));
      const seen = byKey.get(key);
      byKey.set(key, {
        name,
        version: p.version,
        resolved: p.resolved,
        lockfiles: [...new Set([...(seen?.lockfiles ?? []), rel])],
        // needed if ANY lockfile installs it on the target platform
        otherPlatform: seen ? seen.otherPlatform && otherPlatform : Boolean(otherPlatform),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function tarballUrl(resolved) {
  // npm's replace-registry-host: registry.npmjs.org URLs go to the configured registry
  return resolved.startsWith(PUBLIC) ? registry + resolved.slice(PUBLIC.length) : resolved;
}

// --- requests ------------------------------------------------------------------------

let ca;
const cafile = npmConfig('cafile');
if (cafile && cafile !== 'null' && existsSync(cafile)) ca = readFileSync(cafile);
const strictSsl = npmConfig('strict-ssl') !== 'false';

/** GET `url`, resolve to { status, message } as soon as the status is in;
 *  the body is read only for a refusal (Curation says why there). */
function probe(url, headers, redirects = 3) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers, ca, rejectUnauthorized: strictSsl, timeout: TIMEOUT_MS }, (res) => {
      const { statusCode: status } = res;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.destroy();
        // a redirect off the registry host (a CDN) must not carry the credentials
        const next = new URL(res.headers.location, url).toString();
        const same = new URL(next).host === new URL(url).host;
        resolve(probe(next, same ? headers : {}, redirects - 1));
        return;
      }
      if (status < 400) {
        res.destroy();
        resolve({ status, message: '' });
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 4000) body += chunk;
      });
      res.on('end', () => resolve({ status, message: summarize(body) }));
      res.on('error', () => resolve({ status, message: summarize(body) }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ status: 0, message: err.code ? `${err.code} ${err.message}` : err.message }));
  });
}

function summarize(body) {
  try {
    const json = JSON.parse(body);
    const errors = json.errors?.map((e) => e.message).filter(Boolean);
    return (errors?.join('; ') || json.message || json.error || body).toString().slice(0, 300);
  } catch {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
}

async function pool(items, worker) {
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
      done += 1;
      if (process.stderr.isTTY) process.stderr.write(`\r  ${done}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  if (process.stderr.isTTY) process.stderr.write('\r');
}

// --- main ----------------------------------------------------------------------------

const npmrc = readNpmrc();
const auth = authHeader(npmrc);
const headers = { 'User-Agent': `npm/check-registry node/${process.version}`, Accept: '*/*' };
if (auth) headers.Authorization = auth;

const packages = lockedPackages();
console.log(`Registry  ${registry}`);
console.log(`Auth      ${auth ? auth.split(' ')[0] : 'none found in .npmrc'}`);
console.log(`Packages  ${packages.length} (target ${targetOs}-${targetCpu}) from ${LOCKFILES.join(', ')}\n`);

for (const p of packages) p.url = tarballUrl(p.resolved);
await pool(packages, async (p) => Object.assign(p, await probe(p.url, headers)));

const label = (s) => (s === 0 ? 'unreachable' : s === 401 ? 'not logged in (401)' : s === 403 ? 'BLOCKED (403)'
  : s === 404 ? 'not found (404)' : `HTTP ${s}`);
const failed = packages.filter((p) => p.status === 0 || p.status >= 400);
const needed = failed.filter((p) => !p.otherPlatform);
const elsewhere = failed.filter((p) => p.otherPlatform);

if (needed.length) {
  console.log(`FAILED — ${needed.length} package(s) the ${targetOs}-${targetCpu} build needs:\n`);
  for (const p of needed) {
    console.log(`  ${p.name}@${p.version}  ${label(p.status)}  [${p.lockfiles.join(', ')}]`);
    if (p.message) console.log(`      ${p.message}`);
  }
  console.log();
}
if (elsewhere.length) {
  console.log(`${elsewhere.length} other-platform optional package(s) failed (not installed on ${targetOs}-${targetCpu}):`);
  for (const p of elsewhere) console.log(`  ${p.name}@${p.version}  ${label(p.status)}`);
  console.log();
}
if (failed.length && failed.every((p) => p.status === 401)) {
  console.log('Every request was 401: the registry wants credentials this script did not find. Run `npm login`');
  console.log('against it (or check the _authToken line in your .npmrc), then try again.\n');
}
console.log(`${packages.length - failed.length} of ${packages.length} available.`);

// The Electron zip electron-builder downloads (not an npm package).
const electron = packages.find((p) => p.name === 'electron');
if (electron) {
  const mirror = (process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download/').replace(/\/?$/, '/');
  const zip = `${mirror}v${electron.version}/electron-v${electron.version}-${targetOs}-${targetCpu}.zip`;
  const r = await probe(zip, { 'User-Agent': headers['User-Agent'] });
  console.log(`\nElectron zip  ${r.status && r.status < 400 ? 'reachable' : label(r.status)}  ${zip}`);
  if (r.message && r.status >= 400) console.log(`      ${r.message}`);
}

const out = opt('--json');
if (out) {
  writeFileSync(out, JSON.stringify({
    registry, platform: `${targetOs}-${targetCpu}`, checkedAt: new Date().toISOString(),
    packages: packages.map(({ name, version, url, status, message, lockfiles, otherPlatform }) =>
      ({ name, version, url, status, message, lockfiles, otherPlatform })),
  }, null, 2));
  console.log(`\nWrote ${out}`);
}

process.exitCode = needed.length ? 1 : 0;
