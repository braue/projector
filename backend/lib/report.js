// Compare report PDF — the differences between two sources, and ONLY the
// differences, rendered with pdf-lib (already here for the drawings
// pipeline). pdf-lib has no text flow, so this file carries a small one:
// word-wrap by measured width, automatic page breaks, keep-with-next for
// headers.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { lineDiff } from './lineDiff.js';
import { ST_START, tokenizeLine } from './st.js';

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

// Same palette as the app's .tok-* classes; keywords bolden instead.
const TOKEN_STYLE = {
  kw: { color: rgb(0.1, 0.34, 0.69), font: 'monoBold' },
  type: { color: rgb(0.44, 0.28, 0.66), font: 'mono' },
  str: { color: rgb(0.54, 0.35, 0), font: 'mono' },
  num: { color: rgb(0.05, 0.46, 0.41), font: 'mono' },
  com: { color: MUTED, font: 'monoItalic' },
  plain: { color: INK, font: 'mono' },
};

// Row tints matching the app's diff backgrounds.
const TINT_ADDED = rgb(0.914, 0.969, 0.937);
const TINT_REMOVED = rgb(0.988, 0.925, 0.925);

// Standard fonts encode WinAnsi only; anything outside latin-1 would throw
// mid-render. Values come from arbitrary vendor files, so scrub first.
// Line endings normalize to \n and SURVIVE the scrub — multi-line values
// must break lines, not render as one run-on string with embedded '?'s.
function winAnsi(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/→/g, '->')
    .replace(/[−–]/g, '-')
    .replace(/[^\n\x20-\x7e -ÿ‘’“”–—•…]/g, '?');
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

  /**
   * Write wrapped text. Options: font ('body' | 'bold' | 'mono'), size,
   * color, indent (from left margin), spaceAfter, keep (extra height that
   * must fit on the same page — keep-with-next for headers). Newlines in
   * `content` are honored. Delegates to rich() — one wrapping engine.
   */
  text(content, { font = 'body', size = 9.5, color = INK, indent = 0, spaceAfter = 2, keep = 0 } = {}) {
    const lines = winAnsi(content).split('\n');
    lines.forEach((line, index) => {
      this.rich([{ text: line, color, font }], {
        size,
        indent,
        keep: index === 0 ? keep : 0,
        spaceAfter: index === lines.length - 1 ? spaceAfter : 0,
      });
    });
  }

  /**
   * Write one logical line of styled runs [{text, color, font}], wrapped by
   * measured width; continuation lines share the same left edge. `tint`
   * paints a full-width background behind every wrapped line (diff rows).
   * This is the ONLY wrapping engine — text() is its single-run case.
   *
   * Widths are measured once per piece; hard-splitting an over-wide piece
   * accumulates per-character advances in a single pass (standard-font
   * widths are additive), never re-measuring a growing prefix.
   */
  rich(segments, { size = 8, indent = 14, spaceAfter = 0.5, tint = null, keep = 0 } = {}) {
    const x0 = MARGIN + indent;
    const maxWidth = BODY_W - indent;
    const lineHeight = size * 1.35;

    // Split segments into atomic pieces (words and spaces) that keep their
    // style, each measured exactly once, then greedy-fill lines.
    const pieces = [];
    for (const segment of segments) {
      const face = this.fonts[segment.font ?? 'mono'];
      for (const part of winAnsi(segment.text).split(/(\s+)/)) {
        if (part) {
          pieces.push({ text: part, color: segment.color, face, width: face.widthOfTextAtSize(part, size) });
        }
      }
    }

    const lines = [];
    let line = [];
    let width = 0;
    const flush = () => {
      lines.push(line);
      line = [];
      width = 0;
    };
    const push = (piece) => {
      line.push(piece);
      width += piece.width;
    };
    for (let piece of pieces) {
      // Wrap before a piece that fits on a fresh line but not this one.
      if (width + piece.width > maxWidth && piece.width <= maxWidth && line.length) {
        flush();
        if (/^\s+$/.test(piece.text)) continue; // no leading spaces after a wrap
      }
      // A piece too wide for any line hard-splits: fill, wrap, repeat.
      while (width + piece.width > maxWidth) {
        let cut = 0;
        let cutWidth = 0;
        for (const char of piece.text) {
          const charWidth = piece.face.widthOfTextAtSize(char, size);
          if (width + cutWidth + charWidth > maxWidth) break;
          cutWidth += charWidth;
          cut += 1;
        }
        if (cut === 0) {
          if (!line.length) {
            // A single character wider than the column: emit it anyway.
            cut = 1;
            cutWidth = piece.face.widthOfTextAtSize(piece.text[0], size);
          } else {
            flush();
            continue;
          }
        }
        push({ ...piece, text: piece.text.slice(0, cut), width: cutWidth });
        flush();
        piece = { ...piece, text: piece.text.slice(cut), width: piece.width - cutWidth };
      }
      if (piece.text) push(piece);
    }
    lines.push(line);

    this.ensure(lineHeight + keep);
    for (const runs of lines) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      if (tint) {
        this.page.drawRectangle({
          x: x0 - 3, y: this.y - size * 0.25, width: maxWidth + 6, height: lineHeight,
          color: tint,
        });
      }
      // Coalesce adjacent pieces sharing a style into ONE drawText: spaces
      // must live inside a run's string, or text extraction (copy, search)
      // reads the words mashed together — and one op per word bloats the
      // page's resource dictionary.
      let x = x0;
      let run = null;
      const emit = () => {
        if (!run) return;
        this.page.drawText(run.text, { x: run.x, y: this.y, size, font: run.face, color: run.color });
        run = null;
      };
      for (const piece of runs) {
        if (run && piece.face === run.face && piece.color === run.color) {
          run.text += piece.text;
        } else {
          emit();
          run = { text: piece.text, face: piece.face, color: piece.color, x };
        }
        x += piece.width;
      }
      emit();
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

const MAX_DIFF_LINES = 120;

// One diff line: colored ± sign and number, then syntax-colored ST tokens on
// the row tint. Lines are tokenized stateless (the diff only carries the
// CHANGED lines, so there is no preceding context to thread block-comment
// state through) — the interior of a multi-line comment renders plain.
function writeCapped(flow, entries, prefix, color, tint) {
  for (const { number, text } of entries.slice(0, MAX_DIFF_LINES)) {
    const { tokens } = tokenizeLine(text, ST_START);
    flow.rich(
      [
        { text: `${prefix} ${String(number).padStart(4)}  `, color },
        ...tokens.map((token) => ({ text: token.text, ...TOKEN_STYLE[token.kind] })),
      ],
      { tint },
    );
  }
  if (entries.length > MAX_DIFF_LINES) {
    flow.text(`… ${entries.length - MAX_DIFF_LINES} more`, { size: 8.5, color: MUTED, indent: 14 });
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
  // Per part, like Inspect and search — line numbers count each part from 1.
  // The SAME LCS diff the app renders (lib/lineDiff.js, frontend twin), so
  // the PDF and DiffPreview always agree on removed/added lines and numbers;
  // only the differences print (context lines are skipped).
  for (const [label, part] of [['Interface', code.interface], ['Implementation', code.implementation]]) {
    if (!part) continue;
    section(flow, `Logic source · ${label.toLowerCase()}`);
    const lines = lineDiff(part.original ?? '', part.updated ?? '');
    writeCapped(flow, lines.filter((line) => line.kind === 'del')
      .map((line) => ({ number: line.oldNo, text: line.text })), '-', RED, TINT_REMOVED);
    writeCapped(flow, lines.filter((line) => line.kind === 'add')
      .map((line) => ({ number: line.newNo, text: line.text })), '+', GREEN, TINT_ADDED);
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
    monoBold: await pdf.embedFont(StandardFonts.CourierBold),
    monoItalic: await pdf.embedFont(StandardFonts.CourierOblique),
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

export { compareReportPdf };
