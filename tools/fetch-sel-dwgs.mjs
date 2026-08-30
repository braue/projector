#!/usr/bin/env node
// Populates backend/resources/selDevices/<model>/*.dwg, the AutoCAD sources
// that pair with the drawing PDFs already in the corpus. The dwgen tool copies
// the matching <stem>.dwg into each run's autocad/ bundle so the generated
// .lsp/.scr layer toggle has something to run against; a missing DWG degrades
// the run to "here are the scripts, supply the drawing yourself".
//
// PDFs and DWGs are two formats of the same drawing and live side by side on
// SEL's CDN, so every corpus PDF stem (i7008.E.pdf) names the DWG we want
// (i7008.E.dwg). The CDN path prefix (24-5210/i7008.E.dwg) is not guessable,
// but the public configurator part-lookup API returns it: querying a part
// number yields drawings[].files.{pdf,dwg}.path for that configuration. The
// metadata already records example part numbers - per model and per drawing
// rule - so between the recorded examples and synthesizing variants from each
// rule's position constraints, the lookups cover the drawing set.
//
// The DWGs are SEL's copyrighted works, same as the PDFs: the lookup phase is
// anonymous, but the downloads themselves sit behind a mySEL login and each
// install fetches its own copies under its own account.
//
//   --status  (default)  coverage report: which PDFs still lack their DWG
//   --lookup             resolve CDN paths via the public part-lookup API,
//                        writing them to dwg-sources.json (no login needed)
//   --fetch              download resolved DWGs using SEL_SESSION_COOKIE
//   --from-dir <dir>     file DWGs you already downloaded, matched by stem
//
// Unlike the PDF manifest there is no revision pin to verify against - these
// files were never fetched before - so a fetched DWG is validated only by its
// AC* magic, then recorded in drawings.manifest.json with its actual hash so
// future runs can detect in-place revisions.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { loadDeviceMetadata, SEL_DEVICES_DIR } from '../backend/lib/drawings/deviceMetadata.js';
import { drawingBase } from '../backend/lib/drawings/revisions.js';

const MANIFEST_PATH = path.join(SEL_DEVICES_DIR, 'drawings.manifest.json');
const SOURCES_PATH = path.join(SEL_DEVICES_DIR, 'dwg-sources.json');

const PART_LOOKUP_URL = (pn) =>
  `https://selinc.com/api/configurator/part-lookup/?partQuery=${encodeURIComponent(pn)}`;
const DOWNLOAD_URL = (cdnPath) =>
  `https://selinc.com/api/download/?link=https://cdn.selinc.com/Protected/drawings/${cdnPath}`;

// Requests are serialized with a pause between them. This runs once per
// install against someone else's servers; there is no reason to be greedy.
const DEFAULT_DELAY_MS = 1500;

// A browser UA, not an identifying one: selinc.com fronts with Incapsula,
// which binds the session cookies to the browser fingerprint they were minted
// under and rejects the same cookies presented with a non-browser UA.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ------------------------------------------------------------------ corpus

// The corpus itself is the want-list: every model PDF whose stem has no DWG
// beside it. Stems compare case-insensitively because SEL's own filenames
// waver (i7008.E vs i3857b).
async function scanCorpus() {
  const models = [];
  for (const entry of await fs.readdir(SEL_DEVICES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = await loadDeviceMetadata(entry.name);
    if (!metadata) continue; // not a device directory
    const files = await fs.readdir(path.join(SEL_DEVICES_DIR, entry.name));
    const pdfStems = files.filter((f) => /\.pdf$/i.test(f)).map((f) => f.slice(0, -4));
    const dwgStemList = files.filter((f) => /\.dwg$/i.test(f)).map((f) => f.slice(0, -4));
    const dwgStems = new Set(dwgStemList.map((stem) => stem.toLowerCase()));
    const dwgBases = new Set(dwgStemList.map(drawingBase));
    const missing = [];
    const superseded = []; // PDF's own rev absent, but a newer-rev DWG is here
    for (const stem of pdfStems) {
      if (dwgStems.has(stem.toLowerCase())) continue;
      (dwgBases.has(drawingBase(stem)) ? superseded : missing).push(stem);
    }
    models.push({ model: entry.name, metadata, pdfStems, missing, superseded });
  }
  return models.sort((a, b) => a.model.localeCompare(b.model));
}

// ---------------------------------------------------- candidate part numbers

// Every part number the metadata knows for a model, in the order most likely
// to cover the drawing set: the per-drawing-rule examples first (each names
// the configuration a specific drawing belongs to), then variants synthesized
// by applying a rule's position constraints to a base example, then the
// general example part numbers.
function candidatePartNumbers(metadata, model) {
  const fromRules = [];
  const synthesized = [];
  const general = (metadata.part_number?.example_part_numbers ?? [])
    .map((ex) => ex.part_number)
    .filter(Boolean);

  const rules = metadata.model_to_drawings?.front_and_rear ?? [];
  for (const rule of rules) {
    const when = rule.when ?? {};
    for (const example of when.examples ?? []) fromRules.push(example);
    for (const observed of when.observed_configurations ?? []) {
      if (observed.example_model_number) fromRules.push(observed.example_model_number);
    }
  }

  // Position constraints are applied to every distinct-length base we know:
  // submodels of one product take different part-number lengths (451-1 is 16
  // characters, 451-6 is 25), and a chassis constraint only lands when it is
  // written onto the submodel it belongs to.
  const bases = [...new Map([...fromRules, ...general].map((pn) => [pn.length, pn])).values()];
  for (const base of bases) {
    for (const rule of rules) {
      const positions = Object.entries(rule.when ?? {}).filter(([k]) => k.startsWith('position_'));
      if (!positions.length) continue;
      const chars = [...base];
      let ok = true;
      for (const [key, values] of positions) {
        const index = Number(key.slice('position_'.length)) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= chars.length || !values?.length) {
          ok = false;
          break;
        }
        chars[index] = values[0];
      }
      if (ok) synthesized.push(chars.join(''));
    }
  }

  const candidates = [...fromRules, ...synthesized, ...general];
  if (!candidates.length) {
    // No recorded part number at all. Seed with the ordering prefix (or the
    // model code) and let the length-hint retry pad it out: the API's "should
    // be N characters" error tells us what to send next.
    const prefix = metadata.part_number?.prefix?.value;
    if (prefix) candidates.push(prefix);
    candidates.push(model);
  }
  return [...new Set(candidates)];
}

// The API rejects a wrong-length part number with one code-14 error per
// submodel, each naming the length that submodel expects. An X in any option
// position means "unspecified" to the configurator, so padding a short part
// number with X is a legitimate way to address the longer submodels.
function lengthHints(result, pn) {
  const hints = new Set();
  for (const error of result?.errors ?? []) {
    const match = /should be (\d+) characters/.exec(error.message ?? '');
    if (match && Number(match[1]) > pn.length) hints.add(Number(match[1]));
  }
  return [...hints].map((len) => pn + 'X'.repeat(len - pn.length));
}

// A part number whose length fits a submodel but carries one stale option
// character (a wildcard X where the configurator demands a choice, or a
// legacy code) fails with "invalid digits in positions N". With a single bad
// position it is cheap to sweep plausible characters through that slot;
// two or more bad positions is a different part number, not a typo.
const DIGIT_ALPHABET = [...'HV0123456789ABCE'];
function digitFixHints(result, pn) {
  const out = [];
  for (const error of result?.errors ?? []) {
    const match = /has invalid digits in positions ([0-9, ]+)\s*$/.exec(error.message ?? '');
    if (!match) continue;
    const positions = match[1].split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (positions.length !== 1) continue;
    const index = positions[0] - 1;
    if (index < 0 || index >= pn.length) continue;
    for (const ch of DIGIT_ALPHABET) {
      if (ch === pn[index]) continue;
      out.push(pn.slice(0, index) + ch + pn.slice(index + 1));
    }
  }
  return out;
}

// ------------------------------------------------- manifest / sources files

const SOURCES_COMMENT = [
  'CDN paths for the corpus DWGs, resolved from the public SEL configurator',
  'part-lookup API by tools/fetch-sel-dwgs.mjs --lookup. The path goes into',
  'https://selinc.com/api/download/?link=https://cdn.selinc.com/Protected/drawings/<path>',
  'which needs a mySEL session (--fetch). viaPartNumber records which lookup',
  'produced the path, for re-resolving after SEL revises a drawing.',
];

/** The sources map from dwg-sources.json, or null when no lookup ran yet. */
async function readSources() {
  try {
    return JSON.parse(await fs.readFile(SOURCES_PATH, 'utf8')).sources ?? {};
  } catch {
    return null;
  }
}

async function writeSources(sources) {
  await fs.writeFile(
    SOURCES_PATH,
    `${JSON.stringify({ _comment: SOURCES_COMMENT, sources: sortObject(sources) }, null, 2)}\n`,
  );
}

async function readManifest() {
  return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
}

async function writeManifest(manifest) {
  manifest.drawingCount = Object.keys(manifest.drawings).length;
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

function isDwg(body) {
  return body.subarray(0, 2).toString('latin1') === 'AC';
}

/** Write one DWG into the corpus and record it in the manifest. */
async function fileDwg(manifest, key, body) {
  await fs.writeFile(path.join(SEL_DEVICES_DIR, key), body);
  manifest.drawings[key] = {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    selDocumentId: null,
  };
}

// A wanted stem counts as sourced when its own key is recorded, or when a
// newer revision of the same drawing was recorded in its place.
function isSourced(sources, model, stem) {
  if (sources[`${model}/${stem}.dwg`]) return true;
  const pdf = `${stem}.pdf`;
  return Object.entries(sources).some(
    ([key, source]) => key.startsWith(`${model}/`) && source.supersedesCorpusPdf === pdf,
  );
}

// ------------------------------------------------------------------- status

async function commandStatus() {
  const models = await scanCorpus();
  const sources = (await readSources()) ?? {};

  let pdfTotal = 0;
  let missingTotal = 0;
  let resolvedTotal = 0;
  let supersededTotal = 0;
  for (const { model, pdfStems, missing, superseded } of models) {
    pdfTotal += pdfStems.length;
    supersededTotal += superseded.length;
    if (!missing.length) continue;
    missingTotal += missing.length;
    const resolved = [];
    const guessed = [];
    for (const stem of missing) {
      if (sources[`${model}/${stem}.dwg`]?.guessCandidates) guessed.push(stem);
      else if (isSourced(sources, model, stem)) resolved.push(stem);
    }
    resolvedTotal += resolved.length + guessed.length;
    const note = resolved.length === missing.length
      ? 'all resolved, ready to --fetch'
      : `${resolved.length} resolved${guessed.length ? `, ${guessed.length} guessed` : ''}`;
    console.log(`  ${model}: ${missing.length} of ${pdfStems.length} DWGs missing (${note})`);
  }

  console.log(`\n${pdfTotal} PDFs, ${pdfTotal - missingTotal - supersededTotal} with their DWG, ${missingTotal} without${supersededTotal ? `, ${supersededTotal} covered by a newer-revision DWG` : ''}.`);
  if (missingTotal) {
    if (resolvedTotal < missingTotal) {
      console.log(`${resolvedTotal} of the missing have a resolved CDN path; run --lookup for the rest.`);
    }
    if (resolvedTotal) console.log(`Run --fetch (with SEL_SESSION_COOKIE) to download the ${resolvedTotal} resolved.`);
  } else {
    console.log('Every corpus PDF has its DWG.');
  }
}

// ------------------------------------------------------------------- lookup

async function partLookup(pn) {
  const response = await fetch(PART_LOOKUP_URL(pn), {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://selinc.com/', Accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function commandLookup(options) {
  const models = await scanCorpus();
  const sources = (await readSources()) ?? {};

  const pending = models.filter(({ model, missing }) =>
    missing.some((stem) => !isSourced(sources, model, stem)));
  if (!pending.length) {
    console.log('Every missing DWG already has a resolved CDN path. Run --fetch.');
    return;
  }

  let requestCount = 0;
  let resolvedCount = 0;
  const unresolved = [];

  // Politeness cap: no single model is worth hammering the API over.
  const MAX_REQUESTS_PER_MODEL = 30;

  for (const { model, missing, metadata } of pending) {
    const wanted = new Map(
      missing
        .filter((stem) => !isSourced(sources, model, stem))
        .map((stem) => [`${stem.toLowerCase()}.dwg`, stem]),
    );
    const queue = candidatePartNumbers(metadata, model);
    const tried = new Set();
    console.log(`${model}: ${wanted.size} to resolve, ${queue.length} part number${queue.length === 1 ? '' : 's'} to try`);

    let modelRequests = 0;
    while (queue.length && wanted.size && modelRequests < MAX_REQUESTS_PER_MODEL) {
      const pn = queue.shift();
      if (tried.has(pn)) continue;
      tried.add(pn);
      if (requestCount) await sleep(options.delayMs);
      requestCount += 1;
      modelRequests += 1;
      let result;
      try {
        result = await partLookup(pn);
      } catch (error) {
        console.log(`  ${pn}: ${error.message}`);
        continue;
      }
      const hits = [];
      for (const drawing of result.drawings ?? []) {
        const cdnPath = drawing.files?.dwg?.path;
        if (!cdnPath) continue;
        const offeredStem = path.posix.basename(cdnPath).replace(/\.dwg$/i, '');
        let stem = wanted.get(`${offeredStem.toLowerCase()}.dwg`);
        let supersedes = null;
        if (!stem) {
          // Not the revision the corpus PDF pins - take the current revision
          // under its own name if it is the same drawing number.
          const match = [...wanted.values()].find((w) => drawingBase(w) === drawingBase(offeredStem));
          if (!match) continue;
          stem = offeredStem;
          supersedes = match;
        }
        const source = {
          cdnPath,
          bytes: Number(drawing.files.dwg.fileSize) || null,
          viaPartNumber: pn,
        };
        if (supersedes) source.supersedesCorpusPdf = `${supersedes}.pdf`;
        sources[`${model}/${stem}.dwg`] = source;
        wanted.delete(`${(supersedes ?? stem).toLowerCase()}.dwg`);
        resolvedCount += 1;
        hits.push(supersedes ? `${supersedes} -> ${stem} (newer revision)` : stem);
      }
      const retries = (result.drawings ?? []).length
        ? []
        : [...lengthHints(result, pn), ...digitFixHints(result, pn)].filter((v) => !tried.has(v));
      queue.push(...retries);
      const note = hits.length
        ? `resolved ${hits.join(', ')}`
        : retries.length
          ? `rejected, queueing ${retries.length} variant${retries.length === 1 ? '' : 's'}`
          : 'no new drawings';
      console.log(`  ${pn}: ${note}`);
    }
    if (wanted.size) unresolved.push({ model, stems: [...wanted.values()] });
  }

  // Whatever the lookups did not reach gets folder guesses: SEL files a
  // model's drawings in one or two CDN folders, so a sibling's folder plus the
  // wanted stem is worth trying. Guesses are only attempted at --fetch time
  // (the download endpoint will not confirm existence anonymously) and a miss
  // there costs one failed request.
  for (const entry of unresolved) {
    const folders = new Set(
      Object.entries(sources)
        .filter(([key, source]) => key.startsWith(`${entry.model}/`) && source.cdnPath)
        .map(([, source]) => path.posix.dirname(source.cdnPath)),
    );
    if (!folders.size) continue;
    entry.guessed = true;
    for (const stem of entry.stems) {
      sources[`${entry.model}/${stem}.dwg`] = {
        guessCandidates: [...folders].map((folder) => `${folder}/${stem}.dwg`),
      };
    }
  }

  await writeSources(sources);
  console.log(`\nResolved ${resolvedCount} CDN path${resolvedCount === 1 ? '' : 's'} in ${requestCount} lookup${requestCount === 1 ? '' : 's'}; wrote ${rel(SOURCES_PATH)}.`);
  const guessed = unresolved.filter((entry) => entry.guessed);
  const dark = unresolved.filter((entry) => !entry.guessed);
  if (guessed.length) {
    console.log('\nNot confirmed, but folder-guessed from siblings (--fetch will try them):');
    for (const { model, stems } of guessed) console.log(`  ${model}: ${stems.join(', ')}`);
  }
  if (dark.length) {
    console.log('\nStill unresolved (no recorded part number reaches these drawings):');
    for (const { model, stems } of dark) console.log(`  ${model}: ${stems.join(', ')}`);
    console.log('\nAdd an example part number for the right configuration to that model\'s');
    console.log('metadata.json and rerun, or download by hand and use --from-dir.');
  }
}

// -------------------------------------------------------------------- fetch

// The session cookie the user copies out of their own logged-in browser.
// Taking a session rather than a username and password is deliberate: it
// keeps the login itself, and whatever terms and MFA it carries, between the
// operator and SEL, and it means this script never handles a credential it
// could leak.
function requireSession() {
  const cookie = process.env.SEL_SESSION_COOKIE?.trim();
  if (!cookie) {
    fail([
      'SEL_SESSION_COOKIE is not set.',
      '',
      'DWG downloads sit behind a mySEL login. To hand this script your own session:',
      '  1. Sign in at https://selinc.com/ in a browser.',
      '  2. Open developer tools, Application or Storage, Cookies, selinc.com.',
      '  3. Copy the whole cookie header value for that site.',
      "  4. export SEL_SESSION_COOKIE='<the cookies>'",
      '',
      'The session is short lived. If downloads start redirecting to the login',
      'page, sign in again and copy a fresh one.',
    ].join('\n'));
  }
  return cookie;
}

function isLoginRedirect(response) {
  const location = response.headers.get('location') ?? '';
  return response.status >= 300 && response.status < 400 && /\/login\//.test(location);
}

// SEL rotates session cookies on use, so a static Cookie header dies after
// the first request. The jar starts from SEL_SESSION_COOKIE and every
// selinc.com response's Set-Cookie is folded back in before the next request.
function cookieJar(header) {
  const map = new Map();
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  return map;
}

function jarHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function applySetCookies(jar, response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
}

// The download endpoint answers 302 with a signed CDN URL; the signed URL
// itself needs no cookie (and should not receive one).
async function downloadDwg(cdnPath, jar) {
  const gate = await fetch(DOWNLOAD_URL(cdnPath), {
    redirect: 'manual',
    headers: { Cookie: jarHeader(jar), 'User-Agent': USER_AGENT, Referer: 'https://selinc.com/', Accept: '*/*' },
  });
  applySetCookies(jar, gate);
  if (isLoginRedirect(gate)) throw new Error('login redirect - session expired or rejected');
  let body;
  if (gate.status >= 300 && gate.status < 400) {
    const signed = gate.headers.get('location');
    if (!signed) throw new Error(`HTTP ${gate.status} with no Location`);
    const cdn = await fetch(signed, { headers: { 'User-Agent': USER_AGENT } });
    if (cdn.status !== 200) throw new Error(`CDN HTTP ${cdn.status}`);
    body = Buffer.from(await cdn.arrayBuffer());
  } else if (gate.status === 200) {
    body = Buffer.from(await gate.arrayBuffer());
  } else {
    throw new Error(`HTTP ${gate.status}`);
  }
  if (!isDwg(body)) throw new Error('response was not a DWG');
  return body;
}

async function commandFetch(options) {
  const jar = cookieJar(requireSession());
  const sources = await readSources();
  if (!sources) fail(`No ${rel(SOURCES_PATH)} yet. Run --lookup first.`);
  const manifest = await readManifest();

  const targets = [];
  for (const [key, source] of Object.entries(sources)) {
    try {
      await fs.access(path.join(SEL_DEVICES_DIR, key));
    } catch {
      targets.push({ key, source });
    }
  }
  if (!targets.length) {
    console.log('Nothing to fetch: every resolved DWG is already on disk.');
    return;
  }

  console.log(`Fetching ${targets.length} DWG${targets.length === 1 ? '' : 's'}...\n`);
  let fetched = 0;
  const failures = [];

  let confirmedGuess = false;
  for (const [index, { key, source }] of targets.entries()) {
    if (index) await sleep(options.delayMs);
    const label = `[${index + 1}/${targets.length}] ${key}`;
    const candidates = source.cdnPath ? [source.cdnPath] : source.guessCandidates ?? [];
    let body = null;
    let hit = null;
    let lastError = 'no CDN path recorded';
    for (const [attempt, cdnPath] of candidates.entries()) {
      if (attempt) await sleep(options.delayMs);
      try {
        body = await downloadDwg(cdnPath, jar);
        hit = cdnPath;
        break;
      } catch (error) {
        lastError = error.message;
        if (/login redirect/.test(lastError)) break; // no point trying further paths
      }
    }
    if (!body) {
      failures.push({ key, reason: lastError });
      console.log(`${label}  ${lastError}`);
      continue;
    }
    await fileDwg(manifest, key, body);
    if (!source.cdnPath) {
      sources[key] = { cdnPath: hit, bytes: body.length, viaFolderGuess: true };
      confirmedGuess = true;
    }
    fetched += 1;
    console.log(`${label}  ok (${body.length} bytes${source.cdnPath ? '' : ', folder guess confirmed'})`);
  }

  if (fetched) await writeManifest(manifest);
  if (confirmedGuess) await writeSources(sources);
  console.log(`\nFetched ${fetched} of ${targets.length}; manifest updated.`);
  if (failures.length) {
    console.log(`\n${failures.length} failed:`);
    for (const failure of failures) console.log(`  ${failure.key}: ${failure.reason}`);
    if (failures.some((f) => /login/.test(f.reason))) {
      console.log('\nLogin redirects mean an expired session. Sign in again and copy a fresh cookie.');
    }
  }
}

// ---------------------------------------------------------------- from-dir

// Files DWGs from a directory the user filled by hand, matched by stem. There
// is no revision pin to hash against, so the stem is the identity; a drawing
// shared by several models (the generic dimension sheets) is copied to each.
async function commandFromDir(sourceDir) {
  const models = await scanCorpus();
  const wantedByStem = new Map();
  for (const { model, missing } of models) {
    for (const stem of missing) {
      const lower = stem.toLowerCase();
      if (!wantedByStem.has(lower)) wantedByStem.set(lower, []);
      wantedByStem.get(lower).push({ model, stem });
    }
  }

  let entries;
  try {
    entries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch {
    fail(`Cannot read directory: ${sourceDir}`);
  }
  const dwgs = entries.filter((entry) => entry.isFile() && /\.dwg$/i.test(entry.name));
  if (!dwgs.length) fail(`No DWGs in ${sourceDir}`);

  const manifest = await readManifest();
  let filed = 0;
  for (const dwg of dwgs) {
    const homes = wantedByStem.get(dwg.name.slice(0, -4).toLowerCase());
    if (!homes) continue;
    const body = await fs.readFile(path.join(sourceDir, dwg.name));
    if (!isDwg(body)) {
      console.log(`  ${dwg.name}: not a DWG, skipped`);
      continue;
    }
    for (const { model, stem } of homes) {
      const key = `${model}/${stem}.dwg`;
      await fileDwg(manifest, key, body);
      filed += 1;
      console.log(`  filed ${dwg.name} -> ${key}`);
    }
  }

  if (filed) await writeManifest(manifest);
  console.log(`\nFiled ${filed} DWG${filed === 1 ? '' : 's'}; manifest updated.`);
}

// -------------------------------------------------------------------- main

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function rel(target) {
  return path.relative(process.cwd(), target) || target;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Populate the corpus DWGs that pair with the SEL drawing PDFs.

  node tools/fetch-sel-dwgs.mjs                 coverage report (default)
  node tools/fetch-sel-dwgs.mjs --lookup        resolve CDN paths (no login)
  node tools/fetch-sel-dwgs.mjs --fetch         download using SEL_SESSION_COOKIE
  node tools/fetch-sel-dwgs.mjs --from-dir DIR  file DWGs you downloaded by hand

Options:
  --delay MS   pause between requests to selinc.com (default ${DEFAULT_DELAY_MS})

The drawings are SEL copyrighted works. Fetch them with your own mySEL account,
under whatever terms that account carries; this repository stays private.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return usage();

  const delayIndex = argv.indexOf('--delay');
  const options = {
    delayMs: delayIndex >= 0 ? Number(argv[delayIndex + 1]) || DEFAULT_DELAY_MS : DEFAULT_DELAY_MS,
  };

  const fromDirIndex = argv.indexOf('--from-dir');
  if (fromDirIndex >= 0) {
    const dir = argv[fromDirIndex + 1];
    if (!dir || dir.startsWith('--')) fail('--from-dir needs a directory.');
    return commandFromDir(path.resolve(dir));
  }
  if (argv.includes('--lookup')) return commandLookup(options);
  if (argv.includes('--fetch')) return commandFetch(options);
  return commandStatus();
}

main().catch((error) => fail(error.stack ?? String(error)));
