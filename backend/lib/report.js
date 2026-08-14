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
const TINT_EDITED = rgb(0.992, 0.965, 0.89);

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
    // Wide tables flip their pages to landscape; everything else is
    // portrait. `wantLandscape` is the REQUESTED orientation — the switch
    // materializes on the next page break, so asking for portrait after a
    // table doesn't add a blank page when nothing follows.
    this.isLandscape = false;
    this.wantLandscape = false;
    this.addPage();
  }

  get pageW() {
    return this.isLandscape ? PAGE_H : PAGE_W;
  }

  get bodyW() {
    return this.pageW - MARGIN * 2;
  }

  addPage() {
    this.isLandscape = this.wantLandscape;
    this.page = this.pdf.addPage(this.isLandscape ? [PAGE_H, PAGE_W] : [PAGE_W, PAGE_H]);
    this.y = (this.isLandscape ? PAGE_W : PAGE_H) - MARGIN;
  }

  ensure(height) {
    if (this.y - height < MARGIN || this.isLandscape !== this.wantLandscape) this.addPage();
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
    // A pending orientation switch must land BEFORE wrap widths are
    // measured — wrapping for the old page and drawing on the new one
    // would overflow (or waste) the margin.
    if (this.isLandscape !== this.wantLandscape) this.addPage();
    const x0 = MARGIN + indent;
    const maxWidth = this.bodyW - indent;
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
      end: { x: this.pageW - MARGIN, y: this.y },
      thickness: 0.7,
      color: RULE,
    });
    this.y -= spaceAfter;
  }

  gap(height) {
    this.y -= height;
  }

  /**
   * A horizontal cell table: one row per entry — a thousand-row Tag
   * Processor edit must not spend a paragraph per point. Column widths are
   * weighted by content (booleans stay narrow, tag names get the space),
   * cells wrap within their column, rows tint, and the header repeats
   * after every page break.
   *
   * columns: [{ key, label }]; rows: [{ tint?, cells: { key: { text,
   * color?, bold? } } }]. Mono throughout — the fixed pitch is what makes
   * cheap per-character wrapping exact.
   *
   * A table whose natural width overflows the portrait body starts on a
   * fresh LANDSCAPE page (with `title` drawn there so the heading isn't
   * orphaned on the previous portrait page); the page after the table
   * returns to portrait. Narrow tables stay inline on the current page.
   */
  table(columns, rows, { size = 7, indent = 14, title = null } = {}) {
    const mono = this.fonts.mono;
    const monoBold = this.fonts.monoBold;
    const charW = mono.widthOfTextAtSize('0', size); // fixed pitch
    const lineHeight = size * 1.3;
    const cellPad = 3;

    // Content-weighted widths: each column asks for its longest cell (capped
    // — one huge value must not starve every other column), then everything
    // scales to fit, with a floor so no column vanishes.
    const MAX_NATURAL = charW * 34;
    const MIN_WIDTH = charW * 4 + cellPad * 2;
    let widths = columns.map((column) => {
      // Headers wrap between camelCase words, so a column only needs to fit
      // its longest header WORD, not the whole label.
      const headerWords = column.label.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ');
      let chars = Math.max(...headerWords.map((word) => word.length), 1);
      for (const row of rows) {
        const text = row.cells[column.key]?.text ?? '';
        if (text.length > chars) chars = text.length;
      }
      return Math.min(chars * charW, MAX_NATURAL) + cellPad * 2;
    });
    const total = widths.reduce((sum, width) => sum + width, 0);

    // Overflowing tables go landscape; the flip lands with the title.
    const wide = total > PAGE_W - MARGIN * 2 - indent;
    this.wantLandscape = wide;
    if (this.isLandscape !== this.wantLandscape) this.addPage();
    if (title) this.text(title, { font: 'bold', size: 10, keep: 24 });
    const available = this.bodyW - indent;
    const x0 = MARGIN + indent;
    if (total > available) {
      const scale = available / total;
      widths = widths.map((width) => Math.max(MIN_WIDTH, width * scale));
      // Floors can push the sum back over — shave the excess from every
      // above-floor column in proportion to its slack, so no single column
      // gets drained while its neighbors keep their room.
      const excess = widths.reduce((sum, width) => sum + width, 0) - available;
      if (excess > 0) {
        const slack = widths.map((width) => width - MIN_WIDTH);
        const totalSlack = slack.reduce((sum, s) => sum + s, 0);
        if (totalSlack > 0) {
          const shave = Math.min(excess, totalSlack) / totalSlack;
          widths = widths.map((width, index) => width - slack[index] * shave);
        }
      }
    }

    // Wrap one cell's text to its column: fixed pitch, so a simple
    // per-line character budget is exact.
    const wrapCell = (text, width) => {
      const budget = Math.max(1, Math.floor((width - cellPad * 2) / charW));
      const lines = [];
      let rest = winAnsi(text);
      while (rest.length > budget) {
        // Prefer breaking at a space/dot/underscore near the edge.
        const window = rest.slice(0, budget + 1);
        let cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf('.'), window.lastIndexOf('_'));
        if (cut < budget * 0.5) cut = budget;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^ /, '');
      }
      lines.push(rest);
      return lines;
    };

    const drawRow = (cells, { tint = null, bold = false } = {}) => {
      const wrapped = columns.map((column, index) => {
        const cell = cells[column.key];
        return {
          lines: wrapCell(cell?.text ?? '', widths[index]),
          color: cell?.color ?? INK,
          face: (cell?.bold || bold) ? monoBold : mono,
        };
      });
      const height = Math.max(...wrapped.map((cell) => cell.lines.length)) * lineHeight + 2;
      if (this.y - height < MARGIN) {
        this.addPage();
        if (!bold) drawHeader();
      }
      const top = this.y;
      if (tint) {
        this.page.drawRectangle({
          x: x0, y: top - height + 2, width: available, height, color: tint,
        });
      }
      let x = x0;
      wrapped.forEach((cell, index) => {
        cell.lines.forEach((line, lineIndex) => {
          if (line) {
            this.page.drawText(line, {
              x: x + cellPad,
              y: top - lineHeight * (lineIndex + 1) + size * 0.25,
              size, font: cell.face, color: cell.color,
            });
          }
        });
        x += widths[index];
      });
      this.y = top - height;
      this.page.drawLine({
        start: { x: x0, y: this.y }, end: { x: x0 + available, y: this.y },
        thickness: 0.4, color: RULE,
      });
    };

    const drawHeader = () => {
      drawRow(
        Object.fromEntries(columns.map((column) => [
          column.key,
          // CamelCase headers get word breaks (LoggingChatterCounts →
          // Logging Chatter Counts) so narrow columns wrap between words
          // instead of mid-word.
          { text: column.label.replace(/([a-z])([A-Z])/g, '$1 $2'), color: MUTED },
        ])),
        { bold: true },
      );
    };

    this.ensure(lineHeight * 3);
    drawHeader();
    for (const row of rows) drawRow(row.cells, { tint: row.tint ?? null });
    this.y -= 4;
    // Whatever follows the table returns to portrait (lazily — no blank
    // trailing page when the table is the last thing in the report).
    this.wantLandscape = false;
  }
}

// One diff line: colored ± sign and number, then syntax-colored ST tokens on
// the row tint. NO cap — the report is the review artifact, and a truncated
// diff is not reviewable. Lines are tokenized stateless (the diff only
// carries the CHANGED lines, so there is no preceding context to thread
// block-comment state through).
function writeDiffLines(flow, entries, prefix, color, tint) {
  for (const { number, text } of entries) {
    const { tokens } = tokenizeLine(text, ST_START);
    flow.rich(
      [
        { text: `${prefix} ${String(number).padStart(4)}  `, color },
        ...tokens.map((token) => ({ text: token.text, ...TOKEN_STYLE[token.kind] })),
      ],
      { tint },
    );
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

// Cell shorthand for Flow.table.
const cell = (text, color, bold) => ({ text: String(text ?? ''), color, bold });

// Table cells for one row's columns.
const rowCells = (columns, row) =>
  Object.fromEntries(columns.map((column) => [column, cell(row[column] ?? '')]));

function writePage(flow, page) {
  if (page.status === 'added' || page.status === 'removed') {
    const { word, color } = STATUS_STYLE[page.status];
    section(flow, `Table · ${page.name}`);
    flow.text(`Table ${word} (${page.rows} rows).`, { size: 9, color, indent: 14 });
    return;
  }
  if (page.status === 'reordered') {
    section(flow, `Table · ${page.name}`);
    flow.text('Rows reordered — no content changes.', { size: 9, color: MUTED, indent: 14 });
    return;
  }

  // ONE horizontal table: a row per added/removed/changed page row — a
  // thousand-point Tag Processor edit stays a thousand table rows, not a
  // thousand paragraphs. Rows are sorted by ROW POSITION (solve order),
  // not grouped by change kind, with the position in the badge column —
  // removed rows sort by where they used to live and come first on ties.
  // Changed rows show "old -> new" inside the changed cells.
  const columns = page.columns ?? [];
  const KIND_RANK = { removed: 0, changed: 1, added: 2 };
  const rows = [
    ...(page.added ?? []).map((entry) => ({
      index: entry.index,
      rank: KIND_RANK.added,
      tint: TINT_ADDED,
      cells: { __change: cell(`+ ${entry.index + 1}`, GREEN, true), ...rowCells(columns, entry.row) },
    })),
    ...(page.removed ?? []).map((entry) => ({
      index: entry.index,
      rank: KIND_RANK.removed,
      tint: TINT_REMOVED,
      cells: { __change: cell(`- ${entry.index + 1}`, RED, true), ...rowCells(columns, entry.row) },
    })),
    ...(page.changed ?? []).map((entry) => ({
      index: entry.index,
      rank: KIND_RANK.changed,
      tint: TINT_EDITED,
      cells: {
        __change: cell(`~ ${entry.index + 1}`, AMBER, true),
        ...Object.fromEntries(columns.map((column) => [
          column,
          entry.fields.includes(column)
            ? cell(`${entry.original[column] ?? '(empty)'} -> ${entry.updated[column] ?? '(empty)'}`, AMBER, true)
            : cell(entry.updated[column] ?? entry.original[column] ?? ''),
        ])),
      },
    })),
  ].sort((a, b) => a.index - b.index || a.rank - b.rank);
  flow.gap(5);
  flow.table(
    [{ key: '__change', label: 'Row' }, ...columns.map((column) => ({ key: column, label: column }))],
    rows,
    { title: `Table · ${page.name}` },
  );
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
    writeDiffLines(flow, lines.filter((line) => line.kind === 'del')
      .map((line) => ({ number: line.oldNo, text: line.text })), '-', RED, TINT_REMOVED);
    writeDiffLines(flow, lines.filter((line) => line.kind === 'add')
      .map((line) => ({ number: line.newNo, text: line.text })), '+', GREEN, TINT_ADDED);
  }
}

// Full ST source with line numbers and highlighting, block-comment state
// threaded line to line — used for added/removed files, where the content
// IS the diff.
function writeSource(flow, label, source) {
  section(flow, `Logic source · ${label}`);
  let state = ST_START;
  const lines = source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  lines.forEach((text, index) => {
    const result = tokenizeLine(text, state);
    state = result.state;
    flow.rich([
      { text: `${String(index + 1).padStart(4)}  `, color: MUTED },
      ...result.tokens.map((token) => ({ text: token.text, ...TOKEN_STYLE[token.kind] })),
    ]);
  });
}

// The complete content of a file present on only one side. The reader must
// see WHAT appeared or vanished — "present only in the new source" alone is
// not reviewable. Graphical (CFC/LD) bodies are the one exception: archived
// blobs with no plain text to show.
function writeFullItem(flow, model) {
  const settings = Object.entries(model.settings ?? {});
  if (settings.length) {
    section(flow, 'Settings');
    const pad = Math.max(...settings.map(([key]) => key.length)) + 2;
    for (const [key, value] of settings) {
      flow.text(`${key.padEnd(pad)}${value}`, { font: 'mono', size: 8.5, indent: 14, spaceAfter: 0.5 });
    }
  }

  const points = model.points ?? [];
  if (points.length) {
    section(flow, `Points (${points.length})`);
    for (const point of points) {
      flow.text(
        [
          `${point.page} · ${point.tagName ?? '(unnamed)'}`,
          point.address && `${point.addressColumn ?? 'address'} ${point.address}`,
          point.enabled === false && 'disabled',
        ].filter(Boolean).join(' · '),
        { font: 'mono', size: 8, indent: 14, spaceAfter: 0.5 },
      );
    }
  }

  for (const page of model.pages ?? []) {
    const columns = page.columns ?? [];
    flow.gap(5);
    flow.table(
      columns.map((column) => ({ key: column, label: column })),
      page.rows.map((row) => ({ cells: rowCells(columns, row) })),
      { title: `Table · ${page.name} (${page.rows.length} row${page.rows.length === 1 ? '' : 's'})` },
    );
  }

  for (const [label, part] of [['interface', model.code?.interface], ['implementation', model.code?.implementation]]) {
    if (part?.trim()) writeSource(flow, label, part);
  }

  if (model.hasArchivedContent) {
    flow.gap(5);
    flow.text('Graphical (CFC/LD) logic — an archived body with no plain-text source to show; open it in AcSELerator.', {
      size: 9, color: AMBER, indent: 14,
    });
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
        ? 'Present only in the new source — full content below.'
        : 'Present only in the original source — full content below.',
      { size: 9, color: MUTED, indent: 14 },
    );
    if (item.item) writeFullItem(flow, item.item);
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
