// Drawing Generator (DWGEN) — configured connection drawings from an SEL
// part number, rebuilt on projector's drawing corpus (64 models' layer
// metadata + master configuration PDFs) instead of the old tool's small
// hand-built pdfData table.
//
// From a MOT it: identifies the model, decodes the ordering positions,
// selects the drawing PDF(s), computes the enabled optional-content layers,
// and writes the filtered full-page PDFs plus front/rear preview PNGs into a
// run. For each drawing it also emits an AutoCAD bundle — the local .dwg
// source, a layer-toggle .lsp, and a batch .scr. The DWG pass itself is on
// demand: openDwg launches the local full AutoCAD on a bundled drawing with
// its layer script ("Open as DWG" in the UI); without AutoCAD the bundle is
// the hand-off. Nothing here reaches the network: the whole tool runs
// against the bundled corpus, and AutoCAD (when used) is the local install.

import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  configurePdfLayers,
  createImages,
  resolveDrawings,
  resolveEnabledLayers,
} from '../../lib/drawings/createImages.js';
import { decodeWithMetadata } from '../../lib/drawings/decodePartNumber.js';
import { loadDeviceMetadata, SEL_DEVICES_DIR } from '../../lib/drawings/deviceMetadata.js';
import { latestDwgRevision } from '../../lib/drawings/revisions.js';
import { httpError } from '../../lib/http.js';
import { normalizePartNumber } from '../../lib/selPartNumberRules.js';

/** Identify the model from the MOT via each model's part_number.prefix
 *  (positions like "1-4", value like "0351"); longest matching value wins. */
async function detectModel(pn, devicesDir) {
  let dirs;
  try {
    dirs = (await readdir(devicesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let best = null;
  const loaded = await Promise.all(dirs.map((dir) => loadDeviceMetadata(dir, devicesDir)));
  for (const [index, metadata] of loaded.entries()) {
    const prefix = metadata?.part_number?.prefix;
    if (!prefix?.value || !prefix.positions) continue;
    const [a, b] = String(prefix.positions).split('-').map(Number);
    const start = (a || 1) - 1;
    const slice = pn.slice(start, b ? b : start + 1);
    const value = String(prefix.value).toUpperCase();
    if (slice === value && (!best || value.length > best.length)) {
      best = { model: dirs[index], length: value.length };
    }
  }
  return best?.model ?? null;
}

// DWG layer names track the PDF layer names' option prefix ("3.10__K__…")
// more reliably than their full description text, so the AutoCAD matcher
// gets the prefix where one exists. (The .lsp matches by substring.)
function layerFragment(name) {
  const match = String(name).match(/^\d+\.\d+__[^_]*__/);
  return match ? match[0] : String(name);
}

// Where the "Open as DWG" pass launches AutoCAD (the old tool's
// find_autocad). Full AutoCAD only: LT ships no LISP engine, so a found
// acadlt.exe would open the drawing and toggle nothing. Resolution order:
// the tool setting (autocadPath, editable via /api/tools/settings), the
// PROJECTOR_AUTOCAD env var (the test hook), then a newest-year-wins scan of
// the standard install root — memoized, since installs don't change
// mid-session, while the setting is re-read so a UI change takes effect.
let autodeskScan;
async function scanForAutoCad() {
  if (process.platform !== 'win32') return null;
  const base = 'C:\\Program Files\\Autodesk';
  let entries;
  try {
    entries = await readdir(base);
  } catch {
    return null;
  }
  const years = entries
    .map((name) => ({ name, year: name.match(/^AutoCAD (\d{4})$/)?.[1] }))
    .filter((entry) => entry.year)
    .sort((a, b) => b.year.localeCompare(a.year));
  for (const { name } of years) {
    const exe = path.join(base, name, 'acad.exe');
    try {
      await access(exe);
      return exe;
    } catch {
      // an LT-only install has no acad.exe; keep looking
    }
  }
  return null;
}

async function findAutoCad(settings) {
  const configured = (await settings?.get())?.autocadPath || process.env.PROJECTOR_AUTOCAD;
  if (configured) return configured;
  return (autodeskScan ??= scanForAutoCad());
}

// The old tool's AutoCAD artifacts (grab.py write_lisp_and_scr), with the
// absolute paths replaced by run-from-the-folder relative names.
function autocadLisp(fragments) {
  const list = fragments.map((f) => `"${f}"`).join(' ');
  return `(setq enabledFragments (list ${list}))

(defun layer-matches (lname patterns)
  (if patterns
    (or (vl-string-search (car patterns) lname)
        (layer-matches lname (cdr patterns)))
  )
)

(setvar "CMDDIA" 0)
(setvar "FILEDIA" 0)

(setq rec (tblnext "LAYER" T))
(while rec
  (setq lname (cdr (assoc 2 rec)))
  (if (layer-matches lname enabledFragments)
    (command "-LAYER" "ON" lname "" "THAW" lname "" "")
    (if (/= lname "0")
      (command "-LAYER" "OFF" lname "" "")
    )
  )
  (setq rec (tblnext "LAYER"))
)
`;
}

// Per-drawing batch script: open the bundled source DWG, apply its layer
// script, save the configured DWG. Names are relative so it runs from the
// folder (acad.exe /nologo /b <stem>.scr).
// quit:true is the batch shape (headless run, AutoCAD exits when done);
// quit:false is the "Open as DWG" shape — the configured copy is saved and
// the user is left inside AutoCAD with the drawing open.
const autocadScr = (stem, { quit = true } = {}) => `FILEDIA 0
CMDDIA 0
OPEN "${stem}.dwg"
(load "${stem}.lsp")
SAVEAS
2018
"${stem}.configured.dwg"
${quit ? 'QUIT\n' : ''}`;

const AUTOCAD_README = `AutoCAD layer pass (run on a machine with full AutoCAD - LT has no LISP engine)

This folder has one set of files per drawing:
  <stem>.dwg       the source drawing (already the right one for this part number)
  <stem>.lsp       turns ON the ordered options' layers, OFF everything else
  <stem>.scr       the headless batch script (saves the configured copy, quits)
  <stem>.open.scr  the interactive variant (saves the copy, stays open)

For each drawing, from this folder run:
  acad.exe /nologo /b <stem>.scr
The configured drawing is written as  <stem>.configured.dwg

If a layer is wrongly off, its DWG layer name differs from the PDF layer name -
add the right fragment to the list at the top of that drawing's .lsp.
`;

class DwgenService {
  constructor({ workspace, jobs, settings, devicesDir = SEL_DEVICES_DIR }) {
    this.settings = settings;
    this.workspace = workspace;
    this.jobs = jobs;
    this.devicesDir = devicesDir;
  }

  /** The 64 known models, for the UI's manual override. */
  async listModels() {
    try {
      const entries = await readdir(this.devicesDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  async generate({ partNumber, model }) {
    const pn = normalizePartNumber(partNumber);
    if (!pn) throw httpError(400, 'part number required');
    const resolvedModel = String(model ?? '').trim() || await detectModel(pn, this.devicesDir);
    if (!resolvedModel) {
      throw httpError(400, 'could not identify the model from this part number — pick the model explicitly');
    }
    const metadata = await loadDeviceMetadata(resolvedModel, this.devicesDir);
    if (!metadata) throw httpError(400, `no drawing metadata for model: ${resolvedModel}`);

    const decoded = decodeWithMetadata(metadata, pn);
    const drawings = resolveDrawings(metadata, metadata.device, pn);
    const uniquePdfs = [...new Set(Object.values(drawings))];
    const deviceDir = path.join(this.devicesDir, metadata.device);

    const { runId, dir } = await this.workspace.createRun('dwgen');
    const reports = [];
    const warnings = [];
    const layerNames = new Set();
    // Per-drawing enabled layers, for the AutoCAD bundles below.
    const perPdf = [];

    // Configured bytes are kept for the preview render below, so the
    // expensive layer-configure pass runs once per PDF, not twice.
    const configuredPdfs = new Map();
    for (const pdfName of uniquePdfs) {
      const enabled = resolveEnabledLayers(metadata, pdfName, pn);
      let bytes;
      try {
        bytes = await readFile(path.join(deviceDir, pdfName));
      } catch {
        warnings.push(`${pdfName} is not in the drawing library — drop it into resources/selDevices/${metadata.device}/`);
        continue;
      }
      const configured = await configurePdfLayers(bytes, enabled);
      const outName = `${pn} ${pdfName}`;
      await writeFile(path.join(dir, outName), configured);
      configuredPdfs.set(pdfName, configured);
      reports.push({ path: outName, label: `Configured drawing (${pdfName})` });
      perPdf.push({ pdfName, enabled });
      for (const name of enabled?.names ?? []) layerNames.add(name);
    }

    // Front/rear preview PNGs — best-effort; the PDFs are the deliverable.
    let previews = [];
    try {
      const previewDir = path.join(dir, 'preview');
      const views = await createImages(metadata.device, pn, previewDir, { devicesDir: this.devicesDir, configuredPdfs });
      previews = views.map((view) => `preview/${view}.png`);
    } catch (err) {
      warnings.push(`preview render failed: ${err?.message ?? err}`);
    }

    // AutoCAD bundle: one .dwg + .lsp + both .scr shapes per drawing. The
    // source DWG is copied straight from the corpus when present — no
    // network — so the whole DWG pass is ready offline. Bundle rows carry
    // kind:'bundle' so the UI can show only the headline outputs.
    const wanted = [];
    for (const { pdfName, enabled } of perPdf) {
      const fragments = [...new Set([...(enabled?.names ?? [])].map(layerFragment))];
      if (!fragments.length) continue;
      const stem = pdfName.replace(/\.pdf$/i, '');
      const exact = await access(path.join(deviceDir, `${stem}.dwg`)).then(() => true, () => false);
      // SEL revises drawings in place under a new revision suffix, so when
      // the PDF's own revision is absent the corpus may still hold the same
      // drawing number one letter on.
      const dwgStem = exact ? stem : await latestDwgRevision(deviceDir, stem);
      wanted.push({ pdfName, stem, dwgStem, fragments });
    }

    const bundle = path.join(dir, 'autocad');
    const dwgs = [];
    if (wanted.length) {
      await mkdir(bundle, { recursive: true });
      await writeFile(path.join(bundle, 'README.txt'), AUTOCAD_README);
      reports.push({ path: 'autocad/README.txt', label: 'AutoCAD instructions', kind: 'bundle' });
    }
    for (const { pdfName, stem, dwgStem, fragments } of wanted) {
      const scriptStem = dwgStem ?? stem;
      await writeFile(path.join(bundle, `${scriptStem}.lsp`), autocadLisp(fragments));
      await writeFile(path.join(bundle, `${scriptStem}.scr`), autocadScr(scriptStem));
      await writeFile(path.join(bundle, `${scriptStem}.open.scr`), autocadScr(scriptStem, { quit: false }));
      reports.push(
        { path: `autocad/${scriptStem}.lsp`, label: `AutoCAD layer script (${scriptStem}.lsp)`, kind: 'bundle' },
        { path: `autocad/${scriptStem}.scr`, label: `AutoCAD batch script (${scriptStem}.scr)`, kind: 'bundle' },
        { path: `autocad/${scriptStem}.open.scr`, label: `AutoCAD open script (${scriptStem}.open.scr)`, kind: 'bundle' },
      );
      if (!dwgStem) {
        warnings.push(`no local ${stem}.dwg — the .lsp/.scr are ready, but supply ${stem}.dwg to run the AutoCAD pass`);
        continue;
      }
      if (dwgStem !== stem) {
        warnings.push(`${stem}.dwg is not in the corpus — using ${dwgStem}.dwg, a newer revision of the same drawing`);
      }
      await copyFile(path.join(deviceDir, `${dwgStem}.dwg`), path.join(bundle, `${dwgStem}.dwg`));
      reports.push({ path: `autocad/${dwgStem}.dwg`, label: `AutoCAD source drawing (${dwgStem}.dwg)`, kind: 'bundle' });
      dwgs.push({ stem: dwgStem, pdf: pdfName });
    }

    return {
      tool: 'dwgen',
      run: runId,
      model: metadata.device,
      product: metadata.part_number?.product ?? null,
      partNumber: pn,
      decoded,
      layers: [...layerNames].sort(),
      previews,
      reports,
      // Drawings whose DWG is in this run's bundle, and whether this machine
      // can open them — the UI's per-drawing "Open as DWG" button.
      dwgs,
      autocad: Boolean(await findAutoCad(this.settings)),
      warnings,
    };
  }

  /**
   * The DWG pass, on demand: launch AutoCAD on a run's bundled drawing with
   * its layer-toggle script. The .open.scr variant skips the batch QUIT, so
   * the user lands in AutoCAD with the layers set and the configured copy
   * already saved as <stem>.configured.dwg. Fire-and-forget by design — the
   * GUI session belongs to the user, not this request.
   */
  async openDwg({ run, stem }) {
    const name = String(stem ?? '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw httpError(400, 'invalid drawing stem');
    const acad = await findAutoCad(this.settings);
    if (!acad) {
      throw httpError(400, 'AutoCAD not found on this machine — download the autocad/ bundle and run it where AutoCAD is installed');
    }
    // Validates the run id, path containment, and that the bundle really has
    // this drawing and its scripts — generate wrote them; this only spawns.
    const dwgPath = await this.workspace.filePath('dwgen', run, `autocad/${name}.dwg`);
    await this.workspace.filePath('dwgen', run, `autocad/${name}.open.scr`);
    spawn(acad, ['/nologo', '/b', `${name}.open.scr`], {
      cwd: path.dirname(dwgPath),
      detached: true,
      stdio: 'ignore',
    }).unref();
    return { ok: true, configured: `autocad/${name}.configured.dwg` };
  }
}

export { DwgenService, detectModel, layerFragment };
