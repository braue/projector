// Compare report PDF — the differences between two sources, and ONLY the
// differences, rendered with pdf-lib (already here for the drawings
// pipeline). pdf-lib has no text flow, so this file carries a small one:
// word-wrap by measured width, automatic page breaks, keep-with-next for
// headers.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// US Letter.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const BODY_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.1, 0.1, 0.13);
const MUTED = rgb(0.43, 0.44, 0.5);
const RULE = rgb(0.9, 0.91, 0.92);
const GREEN = rgb(0.1, 0.62, 0.36);
const RED = rgb(0.84, 0.23, 0.23);
const AMBER = rgb(0.73, 0.5, 0.03);

const STATUS_STYLE = {
  added: { word: 'added', color: GREEN },
  removed: { word: 'removed', color: RED },
  edited: { word: 'modified', color: AMBER },
};

// Standard fonts encode WinAnsi only; anything outside latin-1 would throw
// mid-render. Values come from arbitrary vendor files, so scrub first.
function winAnsi(text) {
  return String(text)
    .replace(/\t/g, '  ')
    .replace(/→/g, '->')
    .replace(/[−–]/g, '-')
    .replace(/[^\x20-\x7e -ÿ‘’“”–—•…]/g, '?');
}

class Flow {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = null;
    this.y = 0;
    this.addPage();
  }

  addPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height) {
    if (this.y - height < MARGIN) this.addPage();
  }

  #wrap(text, font, size, width) {
    const lines = [];
    for (const raw of text.split('\n')) {
      let line = '';
      for (const word of raw.split(' ')) {
        let piece = word;
        // A word wider than the whole column (long tag paths) hard-splits.
        while (font.widthOfTextAtSize(piece, size) > width) {
          let cut = piece.length - 1;
          const prefix = () => (line ? `${line} ` : '') + piece.slice(0, cut);
          while (cut > 1 && font.widthOfTextAtSize(prefix(), size) > width) cut -= 1;
          lines.push(prefix());
          piece = piece.slice(cut);
          line = '';
        }
        const candidate = line ? `${line} ${piece}` : piece;
        if (font.widthOfTextAtSize(candidate, size) > width && line) {
          lines.push(line);
          line = piece;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  /**
   * Write wrapped text. Options: font ('body' | 'bold' | 'mono'), size,
   * color, indent (from left margin), spaceAfter, keep (extra height that
   * must fit on the same page — keep-with-next for headers).
   */
  text(content, { font = 'body', size = 9.5, color = INK, indent = 0, spaceAfter = 2, keep = 0 } = {}) {
    const face = this.fonts[font];
    const x = MARGIN + indent;
    const lineHeight = size * 1.35;
    const lines = this.#wrap(winAnsi(content), face, size, BODY_W - indent);
    this.ensure(lineHeight + keep);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      this.page.drawText(line, { x, y: this.y, size, font: face, color });
    }
    this.y -= spaceAfter;
  }

  rule(spaceAfter = 10) {
    this.ensure(14);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.7,
      color: RULE,
    });
    this.y -= spaceAfter;
  }

  gap(height) {
    this.y -= height;
  }
}

// Order-preserving multiset line diff for logic source: lines that vanished
// and lines that appeared. Not an LCS, but for settings logic it reads right
// and never mislabels an unchanged line.
function lineDiff(original, updated) {
  const a = (original ?? '').split('\n');
  const b = (updated ?? '').split('\n');
  const budget = (lines) => {
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return (line) => {
      const n = counts.get(line) ?? 0;
      if (n > 0) counts.set(line, n - 1);
      return n > 0;
    };
  };
  const inB = budget(b);
  const removed = a.filter((line) => !inB(line));
  const inA = budget(a);
  const added = b.filter((line) => !inA(line));
  return { removed, added };
}

const MAX_DIFF_LINES = 120;

function writeCapped(flow, lines, prefix, color) {
  for (const line of lines.slice(0, MAX_DIFF_LINES)) {
    flow.text(`${prefix} ${line}`, { font: 'mono', size: 8, color, indent: 14, spaceAfter: 0.5 });
  }
  if (lines.length > MAX_DIFF_LINES) {
    flow.text(`… ${lines.length - MAX_DIFF_LINES} more`, { size: 8.5, color: MUTED, indent: 14 });
  }
}

function section(flow, title) {
  flow.gap(5);
  flow.text(title, { font: 'bold', size: 10, keep: 16 });
}

function writeSettings(flow, entries) {
  section(flow, 'Settings');
  for (const entry of entries) {
    if (entry.status === 'added') {
      flow.text(`+ ${entry.key} = ${entry.updated}`, { font: 'mono', size: 8.5, color: GREEN, indent: 14, spaceAfter: 1 });
    } else if (entry.status === 'removed') {
      flow.text(`- ${entry.key} = ${entry.original}`, { font: 'mono', size: 8.5, color: RED, indent: 14, spaceAfter: 1 });
    } else {
      flow.text(`${entry.key}: ${entry.original} -> ${entry.updated}`, { font: 'mono', size: 8.5, indent: 14, spaceAfter: 1 });
    }
  }
}

function writePoints(flow, points) {
  section(flow, 'Points');
  for (const point of points.added) {
    flow.text(`+ ${point.page} · ${point.tag}`, { font: 'mono', size: 8.5, color: GREEN, indent: 14, spaceAfter: 1 });
  }
  for (const point of points.removed) {
    flow.text(`- ${point.page} · ${point.tag}`, { font: 'mono', size: 8.5, color: RED, indent: 14, spaceAfter: 1 });
  }
  for (const point of points.changed) {
    flow.text(`${point.page} · ${point.tag}`, { font: 'mono', size: 8.5, indent: 14, spaceAfter: 1, keep: 12 });
    for (const field of point.fields) {
      flow.text(`${field.column}: ${field.original ?? '(empty)'} -> ${field.updated ?? '(empty)'}`, {
        font: 'mono', size: 8, color: MUTED, indent: 26, spaceAfter: 1,
      });
    }
  }
}

function writePage(flow, page) {
  section(flow, `Table · ${page.name}`);
  if (page.status === 'added' || page.status === 'removed') {
    const { word, color } = STATUS_STYLE[page.status];
    flow.text(`Table ${word} (${page.rows} rows).`, { size: 9, color, indent: 14 });
    return;
  }
  if (page.status === 'reordered') {
    flow.text('Rows reordered — no content changes.', { size: 9, color: MUTED, indent: 14 });
    return;
  }
  for (const row of page.added ?? []) {
    flow.text(`+ ${row}`, { font: 'mono', size: 8, color: GREEN, indent: 14, spaceAfter: 3 });
  }
  for (const row of page.removed ?? []) {
    flow.text(`- ${row}`, { font: 'mono', size: 8, color: RED, indent: 14, spaceAfter: 3 });
  }
  for (const row of page.changed ?? []) {
    flow.text(row.row, { font: 'bold', size: 9, indent: 14, spaceAfter: 1, keep: 24 });
    flow.text(`was: ${row.original}`, { font: 'mono', size: 8, color: RED, indent: 26, spaceAfter: 1 });
    flow.text(`now: ${row.updated}`, { font: 'mono', size: 8, color: GREEN, indent: 26, spaceAfter: 3 });
  }
}

function writeCode(flow, code) {
  section(flow, 'Logic source');
  const { removed, added } = lineDiff(code.original, code.updated);
  writeCapped(flow, removed, '-', RED);
  writeCapped(flow, added, '+', GREEN);
  if (!removed.length && !added.length) {
    flow.text('Lines reordered — no content changes.', { size: 9, color: MUTED, indent: 14 });
  }
}

function writeItem(flow, item) {
  const { word, color } = STATUS_STYLE[item.status];
  flow.rule();
  flow.text(word.toUpperCase(), { font: 'bold', size: 8, color, spaceAfter: 1, keep: 18 });
  flow.text(item.path, { font: 'bold', size: 11, spaceAfter: 4 });

  if (item.status !== 'edited') {
    flow.text(
      item.status === 'added'
        ? 'Present only in the new source.'
        : 'Present only in the original source.',
      { size: 9, color: MUTED, indent: 14 },
    );
    return;
  }

  const diff = item.diff;
  let wrote = false;
  if (diff.settings.length) { writeSettings(flow, diff.settings); wrote = true; }
  const points = diff.points;
  if (points.added.length || points.removed.length || points.changed.length) {
    writePoints(flow, points);
    wrote = true;
  }
  for (const page of diff.pages) { writePage(flow, page); wrote = true; }
  if (diff.code) { writeCode(flow, diff.code); wrote = true; }
  if (diff.graphicalLogic) {
    flow.gap(5);
    flow.text(`Graphical (CFC/LD) logic ${diff.graphicalLogic} — not text; review in AcSELerator.`, {
      size: 9, color: AMBER, indent: 14,
    });
    wrote = true;
  }
  if (diff.otherFields.length) {
    flow.gap(5);
    flow.text(`Also changed: ${diff.otherFields.join(', ')}.`, { size: 9, color: MUTED, indent: 14 });
    wrote = true;
  }
  if (!wrote) {
    flow.text('Changed in ways the parser does not model in detail.', { size: 9, color: MUTED, indent: 14 });
  }
}

/**
 * Render a CompareService.report() result to PDF bytes.
 * meta: { project, type } for the header line.
 */
async function compareReportPdf(report, meta) {
  const pdf = await PDFDocument.create();
  const fonts = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const flow = new Flow(pdf, fonts);

  flow.text('Comparison report', { font: 'bold', size: 17, spaceAfter: 6 });
  flow.text(`Project ${meta.project} · ${meta.type.toUpperCase()} sources`, { size: 9.5, color: MUTED });
  flow.text(`Original:  ${report.original}`, { size: 10, spaceAfter: 1 });
  flow.text(`New:       ${report.updated}`, { size: 10 });
  flow.text(`Generated ${new Date().toLocaleString('sv-SE').slice(0, 16)}`, { size: 9, color: MUTED, spaceAfter: 6 });

  const s = report.summary;
  flow.text(
    `${s.added} added · ${s.removed} removed · ${s.edited} modified — ${s.unchanged} unchanged (not shown)`,
    { font: 'bold', size: 10 },
  );

  if (!report.items.length) {
    flow.rule();
    flow.text('No differences. The two sources parse to identical settings.', { size: 10, color: MUTED });
  }
  for (const item of report.items) writeItem(flow, item);

  return pdf.save();
}

export { compareReportPdf, lineDiff };
