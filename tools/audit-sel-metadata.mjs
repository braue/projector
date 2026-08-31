#!/usr/bin/env node
// Drawing-metadata audit harness (tools/metadata-audit-plan.md, Phase 0).
//
// The corpus metadata was largely reverse-engineered from sampled units; the
// SEL-487E incident showed how that goes wrong (a layer group hardcoded to one
// option, another reading the wrong MOT digit). This tool turns that one-off
// diagnosis into a repeatable process:
//
//   --lint                offline defect census across every model's metadata:
//                         hardcoded layer sources, group codes that don't fit
//                         their source position's decode table (wrong-position
//                         candidates included), double-booked positions, blob
//                         positions, observed-only decode entries. No network.
//   --verify              for each corpus MOT: local decode + drawing/layer
//                         resolution, then a configurator part-lookup diff.
//                         Responses are cached under tools/audit-cache/, so
//                         re-runs (and --offline runs) never touch the network.
//   --propose <model>     draft part_number.positions rebuild from the cached
//                         configurator decodes plus the PDF layer catalogs —
//                         the 487E rebuild procedure, scripted. A draft for
//                         human review; never lands anywhere by itself.
//
// Ground truth ranking (see the plan): configurator part-lookup > the PDFs'
// own layer catalogs > real fleet MOTs. Requests are serialized ~1.5 s apart,
// the same etiquette as fetch-sel-dwgs.mjs.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'timers/promises';

import { loadDeviceMetadata, SEL_DEVICES_DIR } from '../backend/lib/drawings/deviceMetadata.js';
import { decodeWithMetadata } from '../backend/lib/drawings/decodePartNumber.js';
import { resolveDrawings, resolveEnabledLayers } from '../backend/lib/drawings/createImages.js';
import { drawingBase } from '../backend/lib/drawings/revisions.js';
import { detectModel } from '../backend/services/tools/dwgen.js';
import { normalizePartNumber } from '../backend/lib/selPartNumberRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(HERE, 'audit-cache');
const SOURCES_PATH = path.join(SEL_DEVICES_DIR, 'dwg-sources.json');

const PART_LOOKUP_URL = (pn) =>
  `https://selinc.com/api/configurator/part-lookup/?partQuery=${encodeURIComponent(pn)}`;
const DEFAULT_DELAY_MS = 1500;
// Browser UA — Incapsula fronts selinc.com and dislikes obvious bots even on
// the anonymous endpoint (same string fetch-sel-dwgs.mjs uses).
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ----------------------------------------------------------------- utilities

const norm = (v) => String(v ?? '').trim().toUpperCase();

/** Group option keys can pad with a trailing '-' filler; compare without it. */
function keyVariants(key) {
  const k = norm(key);
  return k.endsWith('-') ? [k, k.slice(0, -1)] : [k];
}

/** Prefix-compatible in either direction ('2A' fits decode code '2'; '0-'→'0' fits '0'). */
function codesCompatible(groupKey, decodeCode) {
  const c = norm(decodeCode);
  if (!c) return false;
  return keyVariants(groupKey).some((k) => k && (k.startsWith(c) || c.startsWith(k)));
}

async function listModels() {
  const entries = await fs.readdir(SEL_DEVICES_DIR, { withFileTypes: true });
  const models = [];
  for (const entry of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const metadata = await loadDeviceMetadata(entry);
    if (metadata) models.push({ model: entry, metadata });
  }
  return models;
}

// Decode-table index: every option code the part_number spec knows, keyed by
// the 1-based MOT position where the code starts. Composite `components`
// contribute at position+offset. Spans record which positions are described
// at all.
function decodeIndex(metadata) {
  const codesByStart = new Map(); // start position -> Set<code>
  const spans = []; // {start, end, entry}
  const add = (start, code) => {
    if (!codesByStart.has(start)) codesByStart.set(start, new Set());
    codesByStart.get(start).add(norm(code));
  };
  const spec = metadata.part_number ?? {};
  const tables = [spec.positions ?? [], ...(spec.submodels ?? []).map((sub) => sub.positions ?? [])];
  for (const entry of tables.flat()) {
    const start = Number(entry.position);
    const length = Number(entry.length) || 1;
    if (!Number.isInteger(start) || start < 1) continue;
    spans.push({ start, end: start + length - 1, entry });
    for (const code of Object.keys(entry.options ?? {})) add(start, code);
    for (const comp of entry.components ?? []) {
      const offset = Number(comp.offset) || 0;
      for (const code of Object.keys(comp.options ?? {})) add(start + offset, code);
    }
  }
  return { codesByStart, spans };
}

// --------------------------------------------------------------------- lint

// One model's defects, per the plan's taxonomy. Severity: 'error' renders
// wrong output for some real configuration; 'warn' is structurally suspect;
// 'info' is a decode-table gap (cosmetic until a layer group shares it).
function lintModel(model, metadata) {
  const findings = [];
  const flag = (severity, kind, where, detail) => findings.push({ model, severity, kind, where, detail });

  const index = decodeIndex(metadata);
  const layerRules = metadata.model_to_layers?.rules_by_pdf ?? {};

  // -- decode-table checks -------------------------------------------------
  const lowSpans = [];
  const spec = metadata.part_number ?? {};
  const decodeTables = [spec.positions ?? [], ...(spec.submodels ?? []).map((sub) => sub.positions ?? [])];
  for (const entry of decodeTables.flat()) {
    const start = Number(entry.position);
    const length = Number(entry.length) || 1;
    const where = `position ${entry.position}${length > 1 ? `-${start + length - 1}` : ''} (${entry.field ?? entry.label ?? '?'})`;

    if (length >= 4 && entry.options && !entry.components) {
      flag('warn', 'blob-position', where,
        `${length}-character position decoded as ${Object.keys(entry.options).length} literal combination(s) — unseen combos decode as (unrecognized)`);
    }
    if (entry.confidence === 'low') lowSpans.push({ start, end: start + length - 1, where });
  }

  // -- layer-group checks, per PDF rule ------------------------------------
  for (const [pdfName, rule] of Object.entries(layerRules)) {
    // position -> [{group, keys}] for the double-booking check
    const readers = new Map();

    for (const [groupName, group] of Object.entries(rule.by_option_group ?? {})) {
      const where = `${pdfName}:${groupName}`;
      const source = group.source;
      const optionKeys = Object.keys(group.options ?? {});
      if (!source || typeof source !== 'object') {
        flag('error', 'missing-source', where, 'layer group has no source selector');
        continue;
      }

      if (source.value != null) {
        flag('error', 'hardcoded-source', where,
          `always resolves to "${source.value}" regardless of the part number (${optionKeys.length} options defined)`);
        continue;
      }

      // Which (position, expected-fragment) pairs does this selector read?
      // parts-composites are split back into per-part fragments by separator
      // (or by the parts' declared lengths when the separator is empty).
      const reads = []; // {position, fragments:Set, kind, readLength}
      if (Array.isArray(source.parts)) {
        const separator = source.parts.length > 1 ? source.separator ?? '' : '';
        const perPart = source.parts.map(() => new Set());
        for (const key of optionKeys) {
          const k = norm(key);
          let pieces = null;
          if (separator) {
            const split = k.split(String(separator).toUpperCase()).map((piece) => piece.trim());
            if (split.length === source.parts.length) pieces = split;
          } else if (source.parts.length === 1) {
            pieces = [k];
          } else {
            let offset = 0;
            pieces = source.parts.map((part) => {
              const piece = k.slice(offset, offset + (Number(part.length) || 1));
              offset += Number(part.length) || 1;
              return piece;
            });
            if (offset !== k.length) pieces = null;
          }
          if (pieces) pieces.forEach((piece, i) => perPart[i].add(piece));
        }
        source.parts.forEach((part, i) => reads.push({
          position: Number(part.position),
          fragments: perPart[i],
          kind: 'parts',
          readLength: Number(part.length) || 1,
        }));
      } else if (source.position != null) {
        reads.push({
          position: Number(source.position),
          fragments: new Set(optionKeys),
          kind: 'plain',
          readLength: Number(source.length) || 1,
        });
        if ((Number(source.length) || 1) >= 4) {
          flag('warn', 'blob-group-source', where,
            `group reads a ${source.length}-character slice as literal combinations`);
        }
      } else {
        flag('error', 'missing-source', where, `unrecognized source selector: ${JSON.stringify(source)}`);
        continue;
      }

      // Layer names encode their full selecting code between the double
      // underscores ('6.15__9- 70__…'). A group whose names encode MORE MOT
      // characters than its source reads can enable layers for configurations
      // it never checks — 751's combined RTD group reads only slot E (2
      // chars) while its layers are keyed '9- 70' (slot D AND slot E), so a
      // non-RTD unit with a populated slot E gets an RTD layer, silently.
      const readTotal = Array.isArray(source.parts)
        ? source.parts.reduce((sum, part) => sum + (Number(part.length) || 1), 0)
        : Number(source.length) || 1;
      // Only code-shaped fragments count: space-separated tokens of 1-2 MOT
      // characters each (a trailing '-' is the catalogs' filler for a skipped
      // digit and reads as zero width). Two tokens is a positional composite
      // ('9- 70' = slot D + slot E); three or more is an alternatives list
      // ('B C D E G H' = any of these codes) and doesn't measure positions.
      // Descriptions in the code slot ('EIA-232') have >2-char tokens — skip.
      const codeWidth = (fragment) => {
        const tokens = fragment.trim().split(/\s+/);
        if (tokens.length > 2) return 0;
        const lengths = tokens.map((token) => token.replace(/-/g, '').length);
        return lengths.every((len) => len >= 1 && len <= 2) ? lengths.reduce((a, b) => a + b, 0) : 0;
      };
      const wideName = Object.values(group.options ?? {})
        .flatMap((entries) => [entries].flat())
        .map((entry) => /^\d+\.\d+__(.*?)__/.exec(String(entry?.name ?? ''))?.[1])
        .filter((code) => code && /^[A-Z0-9\- ]+$/.test(code))
        .find((code) => codeWidth(code) > readTotal);
      if (wideName) {
        flag('error', 'under-conditioned-group', where,
          `layer names encode ${codeWidth(wideName)} MOT characters ("${wideName}") but the source reads only ${readTotal} — the group can enable layers for configurations it does not check`);
      }

      for (const { position, fragments, kind, readLength } of reads) {
        if (!Number.isInteger(position) || position < 1) {
          flag('error', 'missing-source', where, `invalid source position: ${position}`);
          continue;
        }
        if (fragments.size) {
          const prev = readers.get(position) ?? [];
          prev.push({ group: groupName, keys: [...fragments], kind, readLength });
          readers.set(position, prev);
        }

        const covered = index.spans.some((span) => position >= span.start && position <= span.end);
        const codesHere = index.codesByStart.get(position) ?? new Set();
        if (!covered) {
          flag('warn', 'source-position-undecoded', where,
            `reads position ${position}, which the decode table does not describe`);
          continue;
        }

        const unmatched = [...fragments].filter(
          (key) => ![...codesHere].some((code) => codesCompatible(key, code)),
        );
        if (!unmatched.length) continue;

        // Every key failing at the declared position but fitting wholesale at
        // another one is the 487E signature: the group reads the wrong digit.
        if (unmatched.length === fragments.size) {
          const candidates = [...index.codesByStart.entries()]
            .filter(([pos, codes]) => pos !== position
              && [...fragments].every((key) => [...codes].some((code) => codesCompatible(key, code))))
            .map(([pos]) => pos);
          const tableNote = candidates.length
            ? ` — all fit at position ${candidates.join(' or ')}`
            : codesHere.size <= 1
              ? ` — but the table only knows {${[...codesHere].join(', ')}} there; the group may be right and the decode table incomplete`
              : '';
          flag('error', 'wrong-source-position', where,
            `no group code {${[...fragments].join(', ')}} fits the decode table at position ${position}${tableNote}`);
        } else {
          flag('warn', 'unknown-group-codes', where,
            `codes {${unmatched.join(', ')}} not in the decode table at position ${position}`);
        }

        // Escalate observed-only decode entries a layer group depends on.
        const low = lowSpans.find((span) => position >= span.start && position <= span.end);
        if (low) {
          flag('warn', 'group-on-low-confidence', where,
            `layer selection reads ${low.where}, whose decode is observed-only (confidence: low)`);
        }
      }
    }

    for (const [position, groups] of readers) {
      for (let a = 0; a < groups.length; a += 1) {
        for (let b = a + 1; b < groups.length; b += 1) {
          // A combined-slot group legitimately partitions a position with the
          // individual slot groups (some code combos have a joint layer), so
          // only same-shape readers disagreeing counts as double-booked — the
          // 487E signature was two plain single-digit reads.
          const sameShape = groups[a].kind === groups[b].kind && groups[a].readLength === groups[b].readLength;
          if (!sameShape) continue;
          const overlap = groups[a].keys.some((ka) => groups[b].keys.some((kb) => codesCompatible(ka, kb)));
          if (!overlap) {
            flag('error', 'double-booked-position', `${pdfName}:${groups[a].group} vs ${groups[b].group}`,
              `both read position ${position} with disjoint code sets — one of them reads the wrong digit`);
          }
        }
      }
    }
  }

  // Observed-only entries no group depends on: cosmetic, but listed.
  for (const { where } of lowSpans) {
    if (!findings.some((f) => f.kind === 'group-on-low-confidence' && f.detail.includes(where))) {
      flag('info', 'observed-only-decode', where, 'decode options are observed-only (confidence: low)');
    }
  }

  return findings;
}

async function commandLint(options) {
  const models = await listModels();
  const selected = options.model
    ? models.filter(({ model }) => model.toUpperCase() === options.model.toUpperCase())
    : models;
  if (options.model && !selected.length) {
    console.error(`unknown model: ${options.model}`);
    process.exitCode = 2;
    return;
  }

  const all = [];
  for (const { model, metadata } of selected) all.push(...lintModel(model, metadata));

  if (options.json) {
    console.log(JSON.stringify({ findings: all }, null, 2));
    return;
  }

  const order = { error: 0, warn: 1, info: 2 };
  const byModel = new Map();
  for (const finding of all) {
    if (!byModel.has(finding.model)) byModel.set(finding.model, []);
    byModel.get(finding.model).push(finding);
  }
  for (const [model, findings] of byModel) {
    console.log(`${model}:`);
    for (const f of findings.sort((a, b) => order[a.severity] - order[b.severity])) {
      console.log(`  [${f.severity}] ${f.kind} ${f.where}`);
      console.log(`      ${f.detail}`);
    }
  }

  const counts = {};
  for (const f of all) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  const defectModels = new Set(all.filter((f) => f.severity !== 'info').map((f) => f.model));
  console.log(`\n${defectModels.size} of ${selected.length} models with defects (info-only excluded).`);
  for (const [kind, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${kind}`);
  }
  if (options.strict && all.some((f) => f.severity === 'error')) process.exitCode = 1;
}

// ------------------------------------------------------------------- corpus

// The default MOT corpus (plan Phase 1): every example part number the
// metadata records, the lookup PNs that resolved DWGs during the corpus
// fetch, and — when tools/audit-mots.json exists — the curated corpus file
// (real fleet PARTNOs plus synthesized MOTs for otherwise-uncovered models).
// A --mots file (JSON [{model?, mot}] or "MODEL MOT" lines) replaces all of
// that for one-off runs.
const MOTS_PATH = path.join(HERE, 'audit-mots.json');

async function sweepCorpus() {
  const mots = new Map(); // pn -> {model, mot, via}
  const put = (model, pn, via) => {
    const mot = normalizePartNumber(pn);
    if (mot && !/^X+$/.test(mot) && !mots.has(mot)) mots.set(mot, { model, mot, via });
  };

  for (const { model, metadata } of await listModels()) {
    for (const example of metadata.part_number?.example_part_numbers ?? []) {
      put(model, example.part_number, 'metadata example');
    }
    for (const rule of metadata.model_to_drawings?.front_and_rear ?? []) {
      for (const example of rule.when?.examples ?? []) put(model, example, 'drawing-rule example');
      for (const observed of rule.when?.observed_configurations ?? []) {
        put(model, observed.example_model_number, 'observed configuration');
      }
    }
  }

  try {
    const sources = JSON.parse(await fs.readFile(SOURCES_PATH, 'utf8')).sources ?? {};
    for (const [key, source] of Object.entries(sources)) {
      if (source.viaPartNumber) put(key.split('/')[0], source.viaPartNumber, 'dwg-sources lookup PN');
    }
  } catch {
    // no dwg-sources.json yet — the sweep still has the metadata examples
  }

  try {
    for (const entry of JSON.parse(await fs.readFile(MOTS_PATH, 'utf8')).mots ?? []) {
      put(entry.model ?? null, entry.mot, entry.via ?? 'audit-mots.json');
    }
  } catch {
    // no curated corpus file yet
  }

  return [...mots.values()];
}

async function readMotsFile(file) {
  const text = await fs.readFile(file, 'utf8');
  const out = [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed.mots ?? [];
    for (const item of list) {
      if (typeof item === 'string') out.push({ model: null, mot: normalizePartNumber(item), via: file });
      else if (item?.mot) out.push({ model: item.model ?? null, mot: normalizePartNumber(item.mot), via: item.via ?? file });
    }
    return out;
  } catch {
    for (const line of text.split('\n')) {
      const fields = line.trim().split(/\s+/).filter(Boolean);
      if (!fields.length || fields[0].startsWith('#')) continue;
      if (fields.length >= 2) out.push({ model: fields[0], mot: normalizePartNumber(fields[1]), via: file });
      else out.push({ model: null, mot: normalizePartNumber(fields[0]), via: file });
    }
    return out;
  }
}

// ------------------------------------------------------------ lookup + cache

function cachePath(pn) {
  return path.join(CACHE_DIR, `${normalizePartNumber(pn)}.json`);
}

async function readCache(pn) {
  try {
    return JSON.parse(await fs.readFile(cachePath(pn), 'utf8'));
  } catch {
    return null;
  }
}

let networkRequests = 0;
async function partLookup(pn, options) {
  const cached = await readCache(pn);
  if (cached) return { ...cached, fromCache: true };
  if (options.offline) return null;

  if (networkRequests) await sleep(options.delayMs);
  networkRequests += 1;
  const response = await fetch(PART_LOOKUP_URL(pn), {
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://selinc.com/', Accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`part-lookup HTTP ${response.status} for ${pn}`);
  const body = await response.json();
  const record = { partQuery: pn, fetchedAt: new Date().toISOString(), response: body };
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath(pn), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// A short MOT fails with one code-14 error per submodel naming the length it
// expects; padding with X ("unspecified") legitimately addresses the longer
// submodels — the same trick the DWG fetch uses.
function lengthHints(response, pn) {
  const hints = new Set();
  for (const error of response?.errors ?? []) {
    const match = /should be (\d+) characters/.exec(error.message ?? '');
    if (match && Number(match[1]) > pn.length) hints.add(Number(match[1]));
  }
  return [...hints].sort((a, b) => a - b).map((len) => pn + 'X'.repeat(len - pn.length));
}

/** Lookup with one round of length-hint retries. Returns {record, query} or null. */
async function lookupWithRetry(pn, options) {
  let record = await partLookup(pn, options);
  if (!record) return null;
  if (record.response?.questions?.length) return { record, query: pn };
  for (const padded of lengthHints(record.response, pn)) {
    const retry = await partLookup(padded, options);
    if (retry?.response?.questions?.length) return { record: retry, query: padded };
    record = retry ?? record;
  }
  return { record, query: pn };
}

// ------------------------------------------------------------------- verify

// Drawing numbers that show up in cached responses of three or more different
// models are the generic dimension/mounting sheets every order carries
// (i7999, i9089, …), not configuration drawings. Computed once per run.
let genericBasesPromise;
function genericDrawingBases() {
  return (genericBasesPromise ??= (async () => {
    const modelsByBase = new Map();
    const dimensionSheets = new Set();
    let files = [];
    try {
      files = (await fs.readdir(CACHE_DIR)).filter((f) => f.endsWith('.json'));
    } catch {
      return new Set();
    }
    for (const file of files) {
      let record;
      try {
        record = JSON.parse(await fs.readFile(path.join(CACHE_DIR, file), 'utf8'));
      } catch {
        continue;
      }
      const model = record.partQuery && await detectModel(record.partQuery, SEL_DEVICES_DIR);
      if (!model) continue;
      for (const drawing of record.response?.drawings ?? []) {
        const cdnPath = drawing.files?.pdf?.path;
        if (!cdnPath) continue;
        const base = drawingBase(path.posix.basename(cdnPath).replace(/\.pdf$/i, ''));
        if (!modelsByBase.has(base)) modelsByBase.set(base, new Set());
        modelsByBase.get(base).add(model);
        // The per-model dimension sheets are 9000-series drawings filed in the
        // undated '000/' folder (i9018, i9164…), unlike configuration drawings
        // which live in dated folders — a real i9xxx config drawing (2431's
        // 18-0281/i9135c) keeps its dated path and is not caught by this.
        if (cdnPath.startsWith('000/') && /^i9/i.test(path.posix.basename(cdnPath))) dimensionSheets.add(base);
      }
    }
    return new Set([
      ...dimensionSheets,
      ...[...modelsByBase.entries()].filter(([, models]) => models.size >= 3).map(([base]) => base),
    ]);
  })());
}

function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { result: fn(), warnings };
  } catch (error) {
    return { result: null, warnings, error };
  } finally {
    console.warn = original;
  }
}

async function verifyOne({ model, mot, via }, options) {
  const detected = model ?? await detectModel(mot, SEL_DEVICES_DIR);
  const report = { model: detected, mot, via, problems: [] };
  if (!detected) {
    report.problems.push({ bucket: '-', kind: 'no-model', detail: 'could not identify the model' });
    return report;
  }
  const metadata = await loadDeviceMetadata(detected);
  if (!metadata) {
    report.problems.push({ bucket: '-', kind: 'no-metadata', detail: `no metadata for ${detected}` });
    return report;
  }

  // (a) local decode — unmatched positions (an all-X code means "unspecified
  // on this order", not a decode gap).
  const decoded = decodeWithMetadata(metadata, mot);
  for (const pos of decoded?.positions ?? []) {
    if (pos.code && !/^X*$/.test(pos.code) && !pos.matched) {
      report.problems.push({
        bucket: 'A', kind: 'decode-gap',
        detail: `position ${pos.position} (${pos.field ?? pos.label}): code "${pos.code}" unrecognized`,
      });
    }
  }

  // (b) local drawing + layer resolution, unresolved-group warnings captured.
  const drawingsPass = captureWarnings(() => resolveDrawings(metadata, detected, mot));
  const drawings = drawingsPass.result ?? {};
  if (drawingsPass.error) {
    report.problems.push({ bucket: 'C', kind: 'drawing-error', detail: String(drawingsPass.error.message ?? drawingsPass.error) });
  }
  for (const warning of drawingsPass.warnings) {
    // A synthesized MOT is mostly wildcards; conditional rules legitimately
    // don't match it and the fallback is expected — corpus noise, not a
    // metadata defect. Real MOTs falling back stay bucket C.
    const synthetic = String(via ?? '').includes('synthesized');
    report.problems.push(synthetic
      ? { bucket: 'A', kind: 'fallback-on-synthetic', detail: `${warning} (synthesized wildcard MOT — expected)` }
      : { bucket: 'C', kind: 'drawing-fallback', detail: warning });
  }
  report.drawings = drawings;

  const layerWarnings = [];
  for (const pdfName of new Set(Object.values(drawings))) {
    if (!pdfName) continue;
    const pass = captureWarnings(() => resolveEnabledLayers(metadata, pdfName, mot));
    layerWarnings.push(...pass.warnings);
    if (pass.error) {
      report.problems.push({ bucket: 'B', kind: 'layer-error', detail: `${pdfName}: ${pass.error.message ?? pass.error}` });
    }
  }
  for (const warning of layerWarnings) {
    // "unresolved layer option model:pdf:group for PN" where the MOT holds X
    // (unspecified) at every position the group reads is the MOT's gap, not
    // the metadata's — wildcarded example MOTs simply don't order the option.
    const match = /unresolved layer option [^:]+:([^:]+):(\S+) for/.exec(warning);
    if (match) {
      const [, pdfName, groupName] = match;
      const group = metadata.model_to_layers?.rules_by_pdf?.[pdfName]?.by_option_group?.[groupName];
      const source = group?.source ?? {};
      const spans = Array.isArray(source.parts)
        ? source.parts.map((part) => ({ start: Number(part.position), length: Number(part.length) || 1 }))
        : source.position != null
          ? [{ start: Number(source.position), length: Number(source.length) || 1 }]
          : [];
      const readChars = spans.map(({ start, length }) => mot.slice(start - 1, start - 1 + length)).join('');
      if (readChars && /^X*$/.test(readChars)) {
        report.problems.push({
          bucket: 'A', kind: 'unspecified-option',
          detail: `${pdfName}:${groupName} unresolved because the MOT is wildcarded (X) at its source position — not a metadata defect`,
        });
        continue;
      }
    }
    report.problems.push({ bucket: 'B', kind: 'unresolved-group', detail: warning });
  }

  // (c) configurator diff.
  let looked;
  try {
    looked = await lookupWithRetry(mot, options);
  } catch (error) {
    report.problems.push({ bucket: '-', kind: 'lookup-failed', detail: String(error.message ?? error) });
    return report;
  }
  if (!looked) {
    report.uncached = true; // --offline and nothing cached
    return report;
  }
  const { record, query } = looked;
  report.query = query;
  const response = record.response ?? {};

  if (!response.questions?.length) {
    const messages = (response.errors ?? []).map((e) => e.message).filter(Boolean);
    report.problems.push({
      bucket: '-', kind: 'lookup-rejected',
      detail: messages.length ? messages[0] : 'configurator returned no decode for this part number',
    });
    return report;
  }

  // Their decode vs ours: every MOT digit the configurator names should land
  // in a described span and decode to something.
  const spans = decodeIndex(metadata).spans;
  for (const question of response.questions) {
    for (const answer of question.answers ?? []) {
      for (const digit of answer.motDigits ?? []) {
        const position = Number(digit.position);
        const value = norm(digit.value);
        if (!value || value === 'X') continue;
        const span = spans.find((s) => position >= s.start && position <= s.end);
        if (!span) {
          report.problems.push({
            bucket: 'A', kind: 'undescribed-position',
            detail: `configurator decodes position ${position} ("${question.text}" = "${answer.text}"), which our table does not describe`,
          });
          continue;
        }
        const ours = decoded?.positions?.find((p) => Number(p.position) === span.start);
        if (ours && !ours.matched && ours.code && !/^X*$/.test(ours.code)) {
          // already reported as decode-gap; annotate with their meaning
          const gap = report.problems.find((p) => p.kind === 'decode-gap' && p.detail.startsWith(`position ${span.start} `));
          if (gap && !gap.detail.includes('configurator says')) {
            gap.detail += ` — configurator says "${question.text}" = "${answer.text}"`;
          }
        }
      }
    }
  }

  // Their drawings vs our selection (compare by drawing number, revision-blind:
  // SEL revises in place and the corpus may pin an older letter). Our choice
  // appearing ANYWHERE in their list is clean. On a miss, the reference set
  // shown excludes the generic dimension/mounting sheets that accompany every
  // configuration (i7999, i9089, …) — recognized as drawing numbers appearing
  // in cached responses of three or more different models — so the finding
  // names the real configuration drawings.
  const theirAll = new Set(
    (response.drawings ?? [])
      .map((d) => d.files?.pdf?.path && drawingBase(path.posix.basename(d.files.pdf.path).replace(/\.pdf$/i, '')))
      .filter(Boolean),
  );
  if (theirAll.size) {
    const generic = await genericDrawingBases();
    const theirSpecific = [...theirAll].filter((base) => !generic.has(base));
    report.theirPdfs = [...theirAll];
    for (const [view, pdfName] of Object.entries(drawings)) {
      if (!pdfName) continue;
      const base = drawingBase(pdfName.replace(/\.pdf$/i, ''));
      if (theirAll.has(base)) continue;
      if (theirSpecific.length) {
        report.problems.push({
          bucket: 'C', kind: 'drawing-mismatch',
          detail: `${view}: we select ${pdfName}, configurator lists {${theirSpecific.join(', ')}}`,
        });
      } else {
        report.problems.push({
          bucket: 'A', kind: 'no-config-drawing',
          detail: `${view}: configurator lists only generic dimension sheets ({${[...theirAll].join(', ')}}) for this configuration; our ${pdfName} is the best available`,
        });
      }
    }
  }

  return report;
}

async function commandVerify(options) {
  let corpus = options.motsFile ? await readMotsFile(options.motsFile) : await sweepCorpus();
  if (options.model) {
    const wanted = options.model.toUpperCase();
    const filtered = [];
    for (const entry of corpus) {
      const model = entry.model ?? await detectModel(entry.mot, SEL_DEVICES_DIR);
      if (model?.toUpperCase() === wanted) filtered.push({ ...entry, model });
    }
    corpus = filtered;
  }
  console.log(`verifying ${corpus.length} MOT(s)${options.offline ? ' (offline, cache only)' : ''}\n`);

  const reports = [];
  for (const entry of corpus) {
    const report = await verifyOne(entry, options);
    reports.push(report);
    const local = report.problems.length
      ? report.problems.map((p) => `${p.bucket}:${p.kind}`).join(', ')
      : 'clean';
    const status = report.uncached ? `${local} — configurator not cached (offline)` : local;
    console.log(`  ${report.model ?? '???'}  ${entry.mot}  ${status}`);
    if (options.verbose) {
      for (const p of report.problems) console.log(`      [${p.bucket}] ${p.detail}`);
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ reports }, null, 2));
    return;
  }

  // Triage: worst first (plan Phase 2).
  const buckets = { C: [], B: [], A: [], '-': [] };
  for (const report of reports) {
    for (const problem of report.problems) {
      buckets[problem.bucket]?.push({ ...problem, model: report.model, mot: report.mot });
    }
  }
  const label = {
    C: 'C — drawing-selection mismatches (wrong PDF entirely)',
    B: 'B — layer defects (wrong/missing layers on the right drawing)',
    A: 'A — decode-only gaps ("(unrecognized)" rows)',
    '-': 'unverifiable (lookup rejected/failed)',
  };
  console.log('\ntriage:');
  for (const bucket of ['C', 'B', 'A', '-']) {
    const items = buckets[bucket];
    if (!items.length) continue;
    console.log(`\n${label[bucket]} — ${items.length} finding(s), ${new Set(items.map((i) => i.model)).size} model(s):`);
    for (const item of items) console.log(`  ${item.model}  ${item.mot}\n      ${item.detail}`);
  }
  const uncached = reports.filter((r) => r.uncached).length;
  if (uncached) console.log(`\n${uncached} MOT(s) not in the cache — re-run without --offline to fetch them.`);
}

// ------------------------------------------------------------------ propose

// Draft part_number.positions rebuild for one model, from the cached
// configurator decodes plus the layer catalogs. Ground truth #1 fills the
// spans and answer texts; ground truth #2 (the PDF layer names,
// <order>__<code>__<description>) contributes descriptions for codes the
// cached lookups never ordered. Codes neither source covers stay out — the
// honesty rule: never an invented meaning.
async function commandPropose(model, options) {
  const metadata = await loadDeviceMetadata(model);
  if (!metadata) {
    console.error(`unknown model: ${model}`);
    process.exitCode = 2;
    return;
  }

  let cacheFiles = [];
  try {
    cacheFiles = (await fs.readdir(CACHE_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    // no cache yet
  }

  // Submodels of one product take different part-number LENGTHS and put the
  // same field at different positions (421-4 is 21 characters, 421-7 is 25),
  // so decodes are grouped per queried length — one draft table each.
  // length -> (question text -> {positions:Set, options: Map<code, {text, via:Set}>})
  const byLength = new Map();
  const usedMots = [];
  for (const file of cacheFiles) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(CACHE_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    const pn = record.partQuery;
    if (!pn || !record.response?.questions?.length) continue;
    if ((await detectModel(pn, SEL_DEVICES_DIR)) !== metadata.device) continue;
    usedMots.push(pn);
    if (!byLength.has(pn.length)) byLength.set(pn.length, new Map());
    const questions = byLength.get(pn.length);

    for (const question of record.response.questions) {
      const text = question.text ?? question.optionSummary?.label ?? '?';
      for (const answer of question.answers ?? []) {
        const digits = (answer.motDigits ?? [])
          .map((d) => ({ position: Number(d.position), value: norm(d.value) }))
          .filter((d) => Number.isInteger(d.position) && d.position >= 1)
          .sort((a, b) => a.position - b.position);
        if (!digits.length) continue;
        if (!questions.has(text)) questions.set(text, { positions: new Set(), options: new Map() });
        const q = questions.get(text);
        for (const d of digits) q.positions.add(d.position);
        const code = digits.map((d) => d.value).join('');
        if (!q.options.has(code)) q.options.set(code, { text: answer.text ?? '', via: new Set() });
        q.options.get(code).via.add(pn);
      }
    }
  }

  if (!byLength.size) {
    console.error(`no cached configurator decodes for ${metadata.device} — run --verify (not offline) first`);
    process.exitCode = 2;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const buildPositions = (questions) => [...questions.entries()]
    .sort((a, b) => Math.min(...a[1].positions) - Math.min(...b[1].positions))
    .map(([text, q]) => {
      const options = {};
      for (const [code, { text: answer }] of [...q.options.entries()].sort()) options[code] = answer;
      const sorted = [...q.positions].sort((a, b) => a - b);
      const start = sorted[0];
      const end = sorted[sorted.length - 1];
      const contiguous = end - start + 1 === sorted.length;
      const draft = {
        position: start,
        length: end - start + 1,
        field: text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
        label: text,
        confidence: 'high',
        source: `SEL configurator part-lookup decode (${today}) of: ${[...new Set([...q.options.values()].flatMap((o) => [...o.via]))].join(', ')}`,
        options,
      };
      // Some questions read scattered digits (487E firmware = positions 6 and
      // 11); a single position/length span misdescribes those — say so, and
      // record the true digit positions for the human rebuilding the entry.
      if (!contiguous) {
        draft._non_contiguous_mot_digits = sorted;
        draft._note = 'this question reads non-adjacent MOT digits; option codes are the digit values joined in position order — model as separate positions or a parts-composite';
      }
      return draft;
    });

  const tables = [...byLength.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([length, questions]) => ({ length, positions: buildPositions(questions) }));

  // Layer-catalog supplement: codes the layer names describe that no cached
  // lookup ordered, attached as notes on the covering position (never merged
  // silently into options — a human decides). Checked against every length's
  // draft table, since a group belongs to whichever submodel its PDF draws.
  const supplements = [];
  for (const [pdfName, rule] of Object.entries(metadata.model_to_layers?.rules_by_pdf ?? {})) {
    for (const [groupName, group] of Object.entries(rule.by_option_group ?? {})) {
      const position = Number(group.source?.position);
      if (!Number.isInteger(position)) continue;
      for (const [key, entries] of Object.entries(group.options ?? {})) {
        const name = [entries].flat()[0]?.name ?? '';
        const description = String(name).split('__')[2];
        if (!description) continue;
        const known = tables.some(({ positions }) => {
          const target = positions.find((p) => position >= p.position && position <= p.position + p.length - 1);
          return target && Object.keys(target.options).some((code) => codesCompatible(key, code));
        });
        if (!known) {
          supplements.push({ position, code: key, description, from: `${pdfName}:${groupName}` });
        }
      }
    }
  }

  const draft = {
    _draft: `part_number.positions rebuild for ${metadata.device}, generated ${today} by audit-sel-metadata --propose. `
      + 'Human review required before landing; layer-catalog supplements are candidates, not facts.',
    _from_mots: usedMots,
    ...(tables.length === 1
      ? { positions: tables[0].positions }
      : {
        _submodels_note: 'multiple part-number lengths decoded — one table per length; land as part_number.submodels entries',
        submodels: tables,
      }),
    layer_catalog_supplements: supplements,
  };

  const output = `${JSON.stringify(draft, null, 2)}\n`;
  if (options.out) {
    await fs.writeFile(options.out, output);
    console.log(`draft written to ${options.out}`);
  } else {
    console.log(output);
  }
}

// --------------------------------------------------------------------- main

function usage() {
  console.log(`SEL drawing-metadata audit (see tools/metadata-audit-plan.md)

usage:
  node tools/audit-sel-metadata.mjs --lint [--model M] [--json] [--strict]
  node tools/audit-sel-metadata.mjs --verify [--mots FILE] [--model M] [--offline] [--verbose] [--json]
  node tools/audit-sel-metadata.mjs --propose MODEL [--out FILE]

  --lint      offline metadata defect census (no network)
  --verify    decode/drawing/layer check per corpus MOT + configurator diff;
              responses cached under tools/audit-cache/ (--offline: cache only)
  --propose   draft positions rebuild from cached decodes + layer catalogs
  --mots      MOT list: JSON [{model, mot}] / ["MOT"] or "MODEL MOT" lines
  --delay MS  pause between configurator requests (default ${DEFAULT_DELAY_MS})`);
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const options = {
    json: has('--json'),
    strict: has('--strict'),
    offline: has('--offline'),
    verbose: has('--verbose'),
    model: value('--model'),
    motsFile: value('--mots'),
    out: value('--out'),
    delayMs: Number(value('--delay')) || DEFAULT_DELAY_MS,
  };

  if (has('--lint')) return commandLint(options);
  if (has('--verify')) return commandVerify(options);
  if (has('--propose')) return commandPropose(value('--propose'), options);
  usage();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
