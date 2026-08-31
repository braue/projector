// HMI Tag Tester — audits an AcSELerator Diagram Builder HMI project for tag
// problems, rewritten from the old Excel/VBA tool ("HMI Tag Tester.xlsm",
// Check_HMI_Tags_hprj):
//
//   - BAD TAGS: tags assigned on diagrams (PointID=) that never appear in the
//     imported tag lists (Description= entries after the TagAdapterDictionary
//     marker) — functionally dead on the HMI.
//   - DUPLICATE TAGS: tags assigned more than once, flagged when two of the
//     uses sit on the same screen.
//
// Input is the text .hprj form of the project. A binary .hprb is converted
// first via Diagram Builder's own ProjectConvert.exe (Windows + an installed
// Diagram Builder, at its standard install path) — exactly what the VBA
// shelled out to.

import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { httpError } from '../../lib/http.js';

const run = promisify(execFile);

/**
 * The LAST `Marker="value"` on the line — the VBA's descending suffix scan
 * without an Exit For lands on the rightmost occurrence.
 */
function lastQuoted(line, marker) {
  let value = null;
  let from = 0;
  for (;;) {
    const at = line.indexOf(`${marker}"`, from);
    if (at === -1) return value;
    const start = at + marker.length + 1;
    const end = line.indexOf('"', start);
    if (end === -1) return value;
    value = line.slice(start, end);
    from = at + 1;
  }
}

/**
 * Analyze .hprj text. The raw file is one giant line; like the VBA we split
 * on '>' so every element is its own line. Order inside the loop matters:
 * the imported-tag-list flag takes effect on the line AFTER its marker.
 */
function analyzeHprj(text) {
  let currentDiagram = '';
  let inTagList = false;
  const used = [];
  const imported = new Set();

  for (const piece of text.split('>')) {
    const line = `${piece}>`;
    const title = lastQuoted(line, 'DiagramTitle=');
    if (title !== null) currentDiagram = title;

    if (!line.includes('(Unassigned)')) {
      const tag = lastQuoted(line, 'PointID=');
      if (tag !== null) used.push({ tag, diagram: currentDiagram });
    }

    if (inTagList) {
      const description = lastQuoted(line, 'Description=');
      if (description !== null) imported.add(description.toLowerCase());
    }
    if (line.trimStart().startsWith('<TagAdapterDictionary') && line.includes('Analog Inputs')) {
      inTagList = true;
    }
  }

  // Bad tags: used but never imported (case-insensitive, like Excel's Find).
  const badTags = used.filter(({ tag }) => !imported.has(tag.toLowerCase()));

  // Duplicates: tags used more than once, first occurrence reporting the
  // count and whether any two uses share a screen.
  const byTag = new Map();
  for (const { tag, diagram } of used) {
    const entry = byTag.get(tag) ?? { tag, count: 0, diagrams: new Map() };
    entry.count += 1;
    entry.diagrams.set(diagram, (entry.diagrams.get(diagram) ?? 0) + 1);
    byTag.set(tag, entry);
  }
  const duplicateTags = [...byTag.values()]
    .filter((entry) => entry.count > 1)
    .map(({ tag, count, diagrams }) => ({
      tag,
      count,
      sameScreen: [...diagrams.values()].some((n) => n > 1),
    }));

  // Per-diagram rollup — which screens to open Diagram Builder on first.
  // Worst first: most bad placements, then most same-screen duplication;
  // ties keep the file's own diagram order (sort is stable).
  const byDiagram = new Map();
  for (const { diagram } of used) {
    if (!byDiagram.has(diagram)) {
      byDiagram.set(diagram, { diagram, tags: 0, bad: 0, sameScreenDuplicates: 0 });
    }
    byDiagram.get(diagram).tags += 1;
  }
  for (const { diagram } of badTags) byDiagram.get(diagram).bad += 1;
  for (const entry of byTag.values()) {
    for (const [diagram, uses] of entry.diagrams) {
      if (uses > 1) byDiagram.get(diagram).sameScreenDuplicates += 1;
    }
  }
  const diagrams = [...byDiagram.values()].sort(
    (a, b) => (b.bad - a.bad) || (b.sameScreenDuplicates - a.sameScreenDuplicates),
  );

  return {
    totalTags: used.length,
    importedCount: imported.size,
    usedTags: used,
    badTags,
    duplicateTags,
    diagrams,
  };
}

// Where Diagram Builder installs — the old tool's default, kept static.
const DIAGRAM_BUILDER_BIN = 'C:\\Program Files\\SEL\\AcSELerator\\DiagramBuilder\\bin';

class HmiTesterService {
  constructor({ workspace }) {
    this.workspace = workspace;
  }

  /**
   * Analyze one uploaded .hprj/.hprb (a multer memory-storage file). The
   * response IS the result — the UI shows the tables in place, and nothing
   * is kept for later download. A .hprb still touches disk on the way: it
   * lands in a scratch run because ProjectConvert.exe needs real files, and
   * the run is removed once the text is read.
   */
  async analyze(upload) {
    const name = String(upload.originalname ?? '');
    const lower = name.toLowerCase();
    if (!lower.endsWith('.hprj') && !lower.endsWith('.hprb')) {
      throw httpError(400, 'upload a .hprj (or a .hprb with Diagram Builder installed)');
    }

    // The project text: directly for .hprj, via ProjectConvert.exe for .hprb.
    let text;
    if (lower.endsWith('.hprb')) {
      const { runId, dir } = await this.workspace.createRun('hmi');
      try {
        const inputPath = path.join(dir, path.basename(name));
        await writeFile(inputPath, upload.buffer);
        const hprjPath = `${inputPath.slice(0, -1)}j`;
        await this.#convert(inputPath, hprjPath);
        text = await readFile(hprjPath, 'latin1');
      } finally {
        await this.workspace.removeRun('hmi', runId).catch(() => {});
      }
    } else {
      text = upload.buffer.toString('latin1');
    }

    const { usedTags: _usedTags, ...summary } = analyzeHprj(text);
    return { tool: 'hmi', ...summary };
  }

  async #convert(hprbPath, hprjPath) {
    if (process.platform !== 'win32') {
      throw httpError(400,
        '.hprb conversion needs ProjectConvert.exe (Windows with Diagram Builder installed) — '
        + 'convert the project there, or upload the .hprj directly');
    }
    const exe = path.join(DIAGRAM_BUILDER_BIN, 'ProjectConvert.exe');
    try {
      await access(exe);
    } catch {
      throw httpError(400, `no ProjectConvert.exe in ${DIAGRAM_BUILDER_BIN} — install Diagram Builder, or upload the .hprj directly`);
    }
    try {
      await run(exe, [hprbPath, hprjPath], { cwd: DIAGRAM_BUILDER_BIN });
    } catch (err) {
      throw httpError(500, `ProjectConvert failed: ${err?.message ?? err}`);
    }
  }
}

export { HmiTesterService, analyzeHprj };
