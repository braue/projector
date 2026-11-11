// Office Open XML — Word (.docx), Excel (.xlsx/.xlsm) and PowerPoint (.pptx)
// — read straight out of the zip: each is a package of XML parts.
//
// Two outputs per format: the TEXT the project search indexes, and the
// MODEL the preview pane draws (a workbook's grid, a deck's slides). Word's
// model is HTML, built by wordHtml.js from the document's styles, numbering
// and tables; the other two are simple enough to read here, with the same
// regex-over-machine-written-XML approach the FAT sheets tool uses (lib's
// ooxml.js) — these parts are written by Office, and their shapes are
// regular.

import path from 'node:path';

import { unzipSync } from 'fflate';

import { clean, decodeText, flatten, unescapeXml } from './text.js';
import { wordHtml } from './wordHtml.js';

// --- package -----------------------------------------------------------------

function readPackage(bytes) {
  return unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

function part(pkg, name) {
  const bytes = pkg[name];
  return bytes ? decodeText(bytes) : null;
}

/** A part's relationships: Id -> package path of the target. */
function relsOf(pkg, partName) {
  const dir = path.posix.dirname(partName);
  const relsName = path.posix.join(dir, '_rels', `${path.posix.basename(partName)}.rels`);
  const xml = part(pkg, relsName);
  const out = new Map();
  if (!xml) return out;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = attrsOf(m[1]);
    if (!attrs.Id || !attrs.Target || attrs.TargetMode === 'External') continue;
    const target = attrs.Target.startsWith('/')
      ? attrs.Target.slice(1)
      : path.posix.normalize(path.posix.join(dir, attrs.Target));
    out.set(attrs.Id, { target, type: attrs.Type ?? '' });
  }
  return out;
}

function attrsOf(text) {
  const out = {};
  for (const m of String(text).matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

// --- Word --------------------------------------------------------------------

/** The paragraphs of one WordprocessingML part, as plain lines. Text boxes
 *  nest paragraphs inside paragraphs; each closing tag ends a line, so their
 *  text lands on lines of its own rather than glued to the anchor's. */
function wordParagraphs(xml) {
  const lines = [];
  let line = '';
  const token = /<w:p\b[^>]*\/>|<\/w:p>|<w:t\b[^>]*>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<w:delText\b[^>]*>[^<]*<\/w:delText>/g;
  for (const m of xml.matchAll(token)) {
    const tag = m[0];
    if (tag.startsWith('</w:p') || tag.endsWith('/>') && tag.startsWith('<w:p')) {
      if (line.trim()) lines.push(line.trim());
      line = '';
    } else if (m[1] !== undefined) {
      line += unescapeXml(m[1]);
    } else if (m[2] === 'tab') {
      line += '\t';
    } else if (m[2]) {
      line += ' ';
    }
    // Deleted (tracked-change) text is not the document's text.
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function docxParts(bytes) {
  const pkg = readPackage(bytes);
  const parts = [];
  const add = (where, xml) => {
    if (!xml) return;
    const lines = wordParagraphs(xml);
    if (lines.length) parts.push({ where, text: lines.join('\n') });
  };
  add('', part(pkg, 'word/document.xml'));
  const names = Object.keys(pkg).sort();
  for (const name of names.filter((n) => /^word\/header\d*\.xml$/.test(n))) add('header', part(pkg, name));
  for (const name of names.filter((n) => /^word\/footer\d*\.xml$/.test(n))) add('footer', part(pkg, name));
  add('footnotes', part(pkg, 'word/footnotes.xml'));
  add('endnotes', part(pkg, 'word/endnotes.xml'));
  add('comments', part(pkg, 'word/comments.xml'));
  return parts;
}

/** The document as HTML for the preview pane (links defused — see
 *  wordHtml.js). */
async function docxHtml(bytes) {
  return wordHtml(readPackage(bytes));
}

// --- Excel -------------------------------------------------------------------

/** Rows the preview grid carries per sheet; the index reads every row. */
const VIEW_MAX_ROWS = 5000;
const VIEW_MAX_COLS = 200;

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm',
  17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colLetters(index) {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function parseRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(ref ?? '').trim());
  return m ? { col: colIndex(m[1]), row: Number(m[2]) } : null;
}

/** Text runs of a string item (shared or inline), phonetic guides dropped. */
function runText(xml) {
  return unescapeXml((xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [])
    .map((t) => t.replace(/^<t\b[^>]*>|<\/t>$/g, ''))
    .join(''));
}

function sharedStrings(pkg) {
  const xml = part(pkg, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return (xml.match(/<si\b[\s\S]*?<\/si>|<si\s*\/>/g) ?? []).map(runText);
}

/** cellXfs index -> number format code. */
function cellFormats(pkg) {
  const xml = part(pkg, 'xl/styles.xml');
  if (!xml) return [];
  const custom = new Map();
  for (const m of (xml.match(/<numFmts\b[\s\S]*?<\/numFmts>/)?.[0] ?? '').matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const a = attrsOf(m[1]);
    custom.set(Number(a.numFmtId), a.formatCode ?? 'General');
  }
  const xfs = xml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  return [...xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)].map((m) => {
    const id = Number(attrsOf(m[1]).numFmtId ?? 0);
    return custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General';
  });
}

/** One section of a format code with quoted literals, escapes, padding and
 *  colour/condition brackets resolved — what is left is tokens and text. */
function formatSection(code, value) {
  const sections = [];
  let current = '';
  let quoted = false;
  for (const ch of code) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      sections.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  sections.push(current);
  if (value < 0 && sections.length > 1) return { section: sections[1], negative: false };
  if (value === 0 && sections.length > 2) return { section: sections[2], negative: false };
  return { section: sections[0], negative: value < 0 };
}

/** Analysis view of a section: literals removed, so token tests do not
 *  trip over a "d" inside "kVA". */
function bare(section) {
  return section.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').replace(/[_*]./g, '');
}

function isDateFormat(section) {
  return /[ymdhs]/i.test(bare(section).replace(/General/gi, ''));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function serialToDate(serial, date1904) {
  // Excel's 1900 system counts the fictional 29 Feb 1900; serials past it
  // are one day ahead of the calendar.
  const days = date1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86400000);
  return new Date(ms);
}

function formatDate(serial, section, date1904) {
  const d = serialToDate(serial, date1904);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ampm = /AM\/PM|A\/P/i.test(section);
  const tokens = section.match(/"[^"]*"|\\.|\[[^\]]*\]|yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+|[_*].|./gi) ?? [];
  // "m" after h or before s is minutes.
  const isMinute = (i) => {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (/^h+$/i.test(tokens[j])) return true;
      if (/^[ymd]+$/i.test(tokens[j])) break;
    }
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (/^s+$/i.test(tokens[j])) return true;
      if (/^[ymdh]+$/i.test(tokens[j])) break;
    }
    return false;
  };
  const hours = d.getUTCHours();
  let out = '';
  tokens.forEach((t, i) => {
    const lower = t.toLowerCase();
    if (t.startsWith('"')) out += t.slice(1, -1);
    else if (t.startsWith('\\')) out += t.slice(1);
    else if (t.startsWith('[')) {
      if (/^\[h+\]$/i.test(t)) out += Math.floor(serial * 24);
      else if (/^\[m+\]$/i.test(t)) out += Math.floor(serial * 1440);
    } else if (/^[_*]/.test(t)) out += t[0] === '_' ? ' ' : '';
    else if (lower === 'yyyy') out += d.getUTCFullYear();
    else if (lower === 'yy') out += pad(d.getUTCFullYear() % 100);
    else if (lower === 'mmmmm') out += MONTHS[d.getUTCMonth()][0];
    else if (lower === 'mmmm') out += MONTHS[d.getUTCMonth()];
    else if (lower === 'mmm') out += MONTHS[d.getUTCMonth()].slice(0, 3);
    else if (lower === 'mm' || lower === 'm') {
      const n = isMinute(i) ? d.getUTCMinutes() : d.getUTCMonth() + 1;
      out += lower === 'mm' ? pad(n) : n;
    } else if (lower === 'dddd') out += DAYS[d.getUTCDay()];
    else if (lower === 'ddd') out += DAYS[d.getUTCDay()].slice(0, 3);
    else if (lower === 'dd') out += pad(d.getUTCDate());
    else if (lower === 'd') out += d.getUTCDate();
    else if (lower === 'hh' || lower === 'h') {
      const h = ampm ? ((hours + 11) % 12) + 1 : hours;
      out += lower === 'hh' ? pad(h) : h;
    } else if (lower === 'ss') out += pad(d.getUTCSeconds());
    else if (lower === 's') out += d.getUTCSeconds();
    else if (lower === 'am/pm') out += hours < 12 ? 'AM' : 'PM';
    else if (lower === 'a/p') out += hours < 12 ? 'A' : 'P';
    else if (t.startsWith('.')) out += (d.getUTCMilliseconds() / 1000).toFixed(t.length - 1).slice(1);
    else out += t;
  });
  return out;
}

function generalNumber(value) {
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-9)) return value.toExponential(5).replace(/\.?0+e/, 'e');
  return String(Number(value.toPrecision(10)));
}

function formatNumber(value, code, date1904) {
  if (!code || /^general$/i.test(code) || code === '@') return generalNumber(value);
  const { section, negative } = formatSection(code, value);
  if (/general/i.test(bare(section))) return (negative ? '-' : '') + generalNumber(Math.abs(value));
  if (isDateFormat(section)) {
    return value >= 0 && value < 2958466 ? formatDate(value, section, date1904) : generalNumber(value);
  }
  const b = bare(section);
  const percent = b.includes('%');
  const scientific = /E[+-]/i.test(b);
  const pattern = b.match(/[#0?,.]+/)?.[0] ?? '';
  const decimals = (pattern.split('.')[1] ?? '').replace(/[^0?#]/g, '').length;
  const thousands = /[#0?],[#0?]/.test(pattern);
  // Trailing commas scale by thousands ("#,##0," shows 1,234,567 as 1,235).
  const scale = 1000 ** ((pattern.match(/,+$/)?.[0].length) ?? 0);
  let n = Math.abs(value) * (percent ? 100 : 1) / scale;
  let digits;
  if (scientific) {
    digits = n.toExponential(decimals).toUpperCase().replace(/E\+?(-?)(\d)$/, 'E+$10$2').replace('E+-', 'E-');
  } else {
    digits = n.toFixed(decimals);
    if (thousands) {
      const [int, frac] = digits.split('.');
      digits = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac !== undefined ? `.${frac}` : '');
    }
  }
  // Literal text around the number survives ("$", " kV", "(").
  const literal = section
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_./g, ' ')
    .replace(/\*./g, '');
  let placed = false;
  let out = '';
  for (const t of literal.match(/"[^"]*"|\\.|[#0?,.]+(?:E[+-][0#]+)?|./gi) ?? []) {
    if (t.startsWith('"')) out += t.slice(1, -1);
    else if (t.startsWith('\\')) out += t.slice(1);
    else if (/^[#0?,.]/.test(t) && /[#0?]/.test(t)) {
      if (!placed) out += digits;
      placed = true;
    } else out += t;
  }
  if (!placed) out += digits;
  return (negative ? '-' : '') + out.trim();
}

/** The workbook's sheets in tab order: name, hidden, package path. */
function workbookSheets(pkg) {
  const xml = part(pkg, 'xl/workbook.xml') ?? '';
  const rels = relsOf(pkg, 'xl/workbook.xml');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(xml);
  const sheets = [];
  for (const m of xml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    const target = rels.get(a['r:id'])?.target;
    if (!target || !pkg[target]) continue;
    sheets.push({ name: a.name ?? target, hidden: a.state === 'hidden' || a.state === 'veryHidden', target });
  }
  return { sheets, date1904 };
}

/**
 * One worksheet's cells: rows (sparse: [{ r, cells: [{ c, v, f? }] }]),
 * merges and column widths. `maxRows` stops reading early for the view.
 */
function readSheet(xml, strings, formats, date1904, maxRows = Infinity) {
  const rows = [];
  let maxCol = 0;
  let maxRow = 0;
  let totalRows = 0;
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  for (const rm of xml.matchAll(rowRe)) {
    const r = Number(attrsOf(rm[1]).r ?? maxRow + 1);
    maxRow = r;
    if (!rm[2]) continue;
    const cells = [];
    let nextCol = 1;
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrsOf(cm[1]);
      const col = parseRef(a.r)?.col ?? nextCol;
      nextCol = col + 1;
      const inner = cm[2] ?? '';
      const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const formula = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      let v = '';
      if (a.t === 'inlineStr') v = runText(inner.match(/<is>[\s\S]*?<\/is>/)?.[0] ?? '');
      else if (raw === undefined) v = '';
      else if (a.t === 's') v = strings[Number(raw)] ?? '';
      else if (a.t === 'b') v = raw === '1' ? 'TRUE' : 'FALSE';
      else if (a.t === 'str' || a.t === 'e') v = unescapeXml(raw);
      else {
        const n = Number(raw);
        v = Number.isFinite(n) ? formatNumber(n, formats[Number(a.s ?? 0)], date1904) : unescapeXml(raw);
      }
      if (v === '' && !formula) continue;
      const cell = { c: col, v };
      if (formula) cell.f = unescapeXml(formula);
      cells.push(cell);
      if (col > maxCol) maxCol = col;
    }
    if (!cells.length) continue;
    totalRows += 1;
    if (rows.length < maxRows) rows.push({ r, cells });
  }
  const merges = [...(xml.match(/<mergeCells\b[\s\S]*?<\/mergeCells>/)?.[0] ?? '').matchAll(/<mergeCell\b[^>]*ref="([^"]+)"/g)]
    .map((m) => {
      const [a, b = a] = m[1].split(':');
      const s = parseRef(a);
      const e = parseRef(b);
      return s && e ? { r1: s.row, c1: s.col, r2: e.row, c2: e.col } : null;
    })
    .filter(Boolean);
  const widths = {};
  for (const m of (xml.match(/<cols\b[\s\S]*?<\/cols>/)?.[0] ?? '').matchAll(/<col\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    const width = a.hidden === '1' ? 0 : Number(a.width);
    if (!Number.isFinite(width)) continue;
    for (let c = Number(a.min); c <= Math.min(Number(a.max), VIEW_MAX_COLS); c += 1) widths[c] = width;
  }
  return { rows, merges, widths, maxCol, totalRows };
}

function openWorkbook(bytes) {
  const pkg = readPackage(bytes);
  const { sheets, date1904 } = workbookSheets(pkg);
  return { pkg, sheets, date1904, strings: sharedStrings(pkg), formats: cellFormats(pkg) };
}

/** One part per non-empty row: "Sheet1 · row 12" → the row's cells. */
function xlsxParts(bytes) {
  const book = openWorkbook(bytes);
  const parts = [];
  for (const sheet of book.sheets) {
    const { rows } = readSheet(part(book.pkg, sheet.target), book.strings, book.formats, book.date1904);
    for (const row of rows) {
      const text = row.cells.map((cell) => flatten(cell.v)).filter(Boolean).join(' | ');
      if (text) parts.push({ where: `${sheet.name} · row ${row.r}`, text });
    }
  }
  return parts;
}

/** The workbook for the preview grid. */
function xlsxModel(bytes) {
  const book = openWorkbook(bytes);
  return {
    format: 'sheet',
    sheets: book.sheets.map((sheet) => {
      const read = readSheet(part(book.pkg, sheet.target), book.strings, book.formats, book.date1904, VIEW_MAX_ROWS);
      return {
        name: sheet.name,
        hidden: sheet.hidden,
        rows: read.rows.map((row) => ({ r: row.r, cells: row.cells.filter((c) => c.c <= VIEW_MAX_COLS) })),
        merges: read.merges,
        widths: read.widths,
        cols: Math.min(read.maxCol, VIEW_MAX_COLS),
        totalRows: read.totalRows,
      };
    }),
  };
}

// --- PowerPoint --------------------------------------------------------------

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' };
const MAX_SLIDE_IMAGE = 4 * 1024 * 1024;
const MAX_DECK_IMAGES = 48 * 1024 * 1024;

/** The paragraphs of a DrawingML block: [{ text, level }]. */
function drawingParagraphs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const inner = m[1] ?? m[2] ?? '';
    const text = [...inner.matchAll(/<a:t>([^<]*)<\/a:t>|<a:t\b[^>]*>([^<]*)<\/a:t>|<a:br\b[^>]*\/>/g)]
      .map((t) => (t[0].startsWith('<a:br') ? '\n' : unescapeXml(t[1] ?? t[2] ?? '')))
      .join('');
    if (!text.trim()) continue;
    const level = Number(inner.match(/<a:pPr\b[^>]*lvl="(\d+)"/)?.[1] ?? 0);
    out.push({ text: clean(text).trim(), level });
  }
  return out;
}

/** The text shapes and tables of one slide, title first. */
function slideText(xml) {
  const title = [];
  const body = [];
  for (const m of xml.matchAll(/<p:(sp|graphicFrame)\b[\s\S]*?<\/p:\1>/g)) {
    const shape = m[0];
    // Slide numbers, dates and footers are furniture.
    if (/<p:ph\b[^>]*type="(sldNum|dt|ftr|sldImg)"/.test(shape)) continue;
    const paragraphs = drawingParagraphs(shape);
    if (/<p:ph\b[^>]*type="(title|ctrTitle)"/.test(shape)) title.push(...paragraphs);
    else body.push(...paragraphs);
  }
  return { title: title.map((p) => p.text).join(' '), paragraphs: body };
}

function deckSlides(pkg) {
  const xml = part(pkg, 'ppt/presentation.xml') ?? '';
  const rels = relsOf(pkg, 'ppt/presentation.xml');
  const ids = [...(xml.match(/<p:sldIdLst\b[\s\S]*?<\/p:sldIdLst>/)?.[0] ?? '').matchAll(/<p:sldId\b([^>]*?)\/?>/g)]
    .map((m) => rels.get(attrsOf(m[1])['r:id'])?.target)
    .filter((target) => target && pkg[target]);
  return ids;
}

function readSlide(pkg, target) {
  const slideXml = part(pkg, target);
  const rels = relsOf(pkg, target);
  const { title, paragraphs } = slideText(slideXml);
  let notes = '';
  for (const rel of rels.values()) {
    if (rel.type.endsWith('/notesSlide') && pkg[rel.target]) {
      notes = slideText(part(pkg, rel.target)).paragraphs.map((p) => p.text).join('\n');
    }
  }
  const images = [...slideXml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)]
    .map((m) => rels.get(m[1])?.target)
    .filter(Boolean);
  return { title, paragraphs, notes, images };
}

function pptxParts(bytes) {
  const pkg = readPackage(bytes);
  return deckSlides(pkg).map((target, index) => {
    const slide = readSlide(pkg, target);
    const text = [slide.title, ...slide.paragraphs.map((p) => p.text), slide.notes].filter(Boolean).join('\n');
    return { where: `slide ${index + 1}`, text };
  }).filter((p) => p.text);
}

function pptxModel(bytes) {
  const pkg = readPackage(bytes);
  let budget = MAX_DECK_IMAGES;
  return {
    format: 'slides',
    slides: deckSlides(pkg).map((target, index) => {
      const slide = readSlide(pkg, target);
      const images = [];
      for (const image of [...new Set(slide.images)]) {
        const type = IMAGE_TYPES[path.posix.extname(image).slice(1).toLowerCase()];
        const data = pkg[image];
        if (!type || !data || data.length > MAX_SLIDE_IMAGE || data.length > budget) continue;
        budget -= data.length;
        images.push(`data:${type};base64,${Buffer.from(data).toString('base64')}`);
      }
      return { number: index + 1, title: slide.title, paragraphs: slide.paragraphs, notes: slide.notes, images };
    }),
  };
}

export { colLetters, docxHtml, docxParts, formatNumber, pptxModel, pptxParts, xlsxModel, xlsxParts };
