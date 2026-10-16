// Just enough SpreadsheetML to graft finished sheets into an existing
// workbook WITHOUT round-tripping it through a spreadsheet library. The FAT
// workbooks are macro-enabled, image-heavy and hand-formatted; every part
// this module doesn't name (VBA, drawings, media, custom XML, printer
// settings) passes through byte-for-byte. What it does touch, it edits as
// text: the workbook's sheet list and defined names, its relationships and
// content types, and an APPEND-ONLY merge into styles.xml.
//
// The XML involved is machine-written by Excel (or by tools/build-fat-
// template.mjs), so the shapes below are regular — regexes over well-formed,
// attribute-quoted markup, not a general XML parser.

import { strToU8, unzipSync, zipSync } from 'fflate';

const decoder = new TextDecoder();

// --- package -----------------------------------------------------------------

/** The zip's parts, in their original order (Map: part name -> bytes). */
function readPackage(buffer) {
  const entries = unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  return new Map(Object.entries(entries));
}

function writePackage(pkg) {
  return Buffer.from(zipSync(Object.fromEntries(pkg), { level: 6 }));
}

function partText(pkg, name) {
  const bytes = pkg.get(name);
  if (!bytes) throw new Error(`workbook is missing ${name}`);
  return decoder.decode(bytes);
}

function setPartText(pkg, name, text) {
  pkg.set(name, strToU8(text));
}

// --- xml text ----------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The attributes of one start tag, as a plain object. */
function attrsOf(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

/** `tag` with attribute `name` set (or removed when value is null). */
function withAttr(tag, name, value) {
  const re = new RegExp(`\\s${name.replace(/[.:]/g, '\\$&')}="[^"]*"`);
  const stripped = tag.replace(re, '');
  if (value == null) return stripped;
  return stripped.replace(/^<([\w:]+)/, `<$1 ${name}="${escapeXml(value)}"`);
}

/** Every `<tag …/>` or `<tag …>…</tag>` element directly inside `xml`, as text. */
function elements(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g');
  return String(xml).match(re) ?? [];
}

/** The `<tag …>inner</tag>` block (first match), or null. */
function block(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`);
  return String(xml).match(re)?.[0] ?? null;
}

// --- cell references ---------------------------------------------------------

function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colLetters(index) {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function parseRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(ref).trim());
  if (!m) throw new Error(`bad cell reference: ${ref}`);
  return { col: colIndex(m[1]), row: Number(m[2]) };
}

function parseRange(ref) {
  const [a, b = a] = String(ref).split(':');
  const start = parseRef(a);
  const end = parseRef(b);
  return { c1: start.col, r1: start.row, c2: end.col, r2: end.row };
}

function rangeRef({ c1, r1, c2, r2 }) {
  const a = `${colLetters(c1)}${r1}`;
  const b = `${colLetters(c2)}${r2}`;
  return a === b ? a : `${a}:${b}`;
}

// --- shared strings ----------------------------------------------------------

/** The workbook's shared-string table (rich runs flattened to text). */
function sharedStrings(pkg) {
  if (!pkg.has('xl/sharedStrings.xml')) return [];
  return elements(partText(pkg, 'xl/sharedStrings.xml'), 'si').map((si) =>
    // Phonetic runs (<rPh>) are reading aids, not the cell's text.
    unescapeXml((si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [])
      .map((t) => t.replace(/^<t\b[^>]*>|<\/t>$/g, ''))
      .join('')));
}

// --- worksheets --------------------------------------------------------------

/**
 * A worksheet split into what the grafting code edits: its rows (each with
 * its start-tag attributes and its cells by column), merges, data
 * validations, and the untouched text before/after <sheetData>.
 */
function parseSheet(xml) {
  const open = xml.indexOf('<sheetData');
  const closeTag = xml.indexOf('</sheetData>');
  const selfClosed = closeTag < 0;
  const dataEnd = selfClosed ? xml.indexOf('>', open) + 1 : closeTag + '</sheetData>'.length;
  const data = xml.slice(open, dataEnd);
  const rows = new Map();
  for (const rowXml of elements(data, 'row')) {
    const startTag = rowXml.match(/^<row\b[^>]*?\/?>/)[0];
    const attrs = attrsOf(startTag);
    const cells = new Map();
    for (const cellXml of elements(rowXml, 'c')) {
      const cTag = cellXml.match(/^<c\b[^>]*?\/?>/)[0];
      const a = attrsOf(cTag);
      const { col } = parseRef(a.r);
      cells.set(col, { attrs: a, inner: cellXml.endsWith('/>') && cellXml === cTag ? '' : cellXml.slice(cTag.length, -'</c>'.length) });
    }
    rows.set(Number(attrs.r), { attrs, cells });
  }
  return {
    head: xml.slice(0, open),
    tail: xml.slice(dataEnd),
    rows,
  };
}

/** A cell's display text (shared, inline, or literal), formulas ignored. */
function cellText(cell, strings) {
  if (!cell) return '';
  const { attrs, inner } = cell;
  if (attrs.t === 'inlineStr') {
    return unescapeXml((inner.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [])
      .map((t) => t.replace(/^<t\b[^>]*>|<\/t>$/g, '')).join(''));
  }
  const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (v == null) return '';
  if (attrs.t === 's') return strings[Number(v)] ?? '';
  return unescapeXml(v);
}

function mergeRanges(sheetXml) {
  return elements(block(sheetXml, 'mergeCells') ?? '', 'mergeCell').map((m) => parseRange(attrsOf(m).ref));
}

// --- styles ------------------------------------------------------------------

const STYLE_LISTS = ['numFmts', 'fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs'];
const ITEM_TAG = {
  numFmts: 'numFmt', fonts: 'font', fills: 'fill', borders: 'border', cellStyleXfs: 'xf', cellXfs: 'xf',
};

function styleLists(stylesXml) {
  const out = {};
  for (const list of STYLE_LISTS) out[list] = elements(block(stylesXml, list) ?? '', ITEM_TAG[list]);
  return out;
}

/** Whitespace-insensitive identity for deduplicating style records. */
function norm(xml) {
  return String(xml).replace(/>\s+</g, '><').trim();
}

/**
 * Copies cell formats from a template's styles.xml into a target's, append-
 * only: an index already in the target keeps its meaning, so every existing
 * sheet renders exactly as before. Each template xf is rebuilt against the
 * target's own fonts/fills/borders/numFmts (reusing identical records,
 * appending the rest) and itself reused when an identical xf exists.
 */
class StyleMerger {
  constructor(targetStylesXml, templateStylesXml) {
    this.xml = targetStylesXml;
    this.target = styleLists(targetStylesXml);
    this.source = styleLists(templateStylesXml);
    this.memo = new Map();
    this.changed = false;
  }

  #find(list, xml) {
    const key = norm(xml);
    return this.target[list].findIndex((item) => norm(item) === key);
  }

  #ensure(list, xml) {
    const at = this.#find(list, xml);
    if (at >= 0) return at;
    this.target[list].push(xml);
    this.changed = true;
    return this.target[list].length - 1;
  }

  #numFmt(id) {
    const n = Number(id);
    if (n < 164) return n; // built-in formats are the same everywhere
    const src = this.source.numFmts.find((f) => Number(attrsOf(f).numFmtId) === n);
    if (!src) return 0;
    const code = attrsOf(src).formatCode;
    const existing = this.target.numFmts.find((f) => attrsOf(f).formatCode === code);
    if (existing) return Number(attrsOf(existing).numFmtId);
    const next = Math.max(163, ...this.target.numFmts.map((f) => Number(attrsOf(f).numFmtId))) + 1;
    this.target.numFmts.push(withAttr(src, 'numFmtId', String(next)));
    this.changed = true;
    return next;
  }

  #rebuild(xf, list) {
    const tag = xf.match(/^<xf\b[^>]*?\/?>/)[0];
    const a = attrsOf(tag);
    let out = tag;
    if (a.fontId != null) out = withAttr(out, 'fontId', String(this.#ensure('fonts', this.source.fonts[a.fontId])));
    if (a.fillId != null) out = withAttr(out, 'fillId', String(this.#ensure('fills', this.source.fills[a.fillId])));
    if (a.borderId != null) out = withAttr(out, 'borderId', String(this.#ensure('borders', this.source.borders[a.borderId])));
    if (a.numFmtId != null) out = withAttr(out, 'numFmtId', String(this.#numFmt(a.numFmtId)));
    if (list === 'cellXfs' && a.xfId != null) {
      const styleXf = this.source.cellStyleXfs[a.xfId];
      const found = styleXf ? this.#find('cellStyleXfs', this.#rebuild(styleXf, 'cellStyleXfs')) : -1;
      out = withAttr(out, 'xfId', String(found >= 0 ? found : 0));
    }
    return out + xf.slice(tag.length);
  }

  /** The target cellXfs index equivalent to the template's index `s`. */
  map(s) {
    const index = Number(s ?? 0);
    if (this.memo.has(index)) return this.memo.get(index);
    const xf = this.source.cellXfs[index];
    const mapped = xf ? this.#ensure('cellXfs', this.#rebuild(xf, 'cellXfs')) : 0;
    this.memo.set(index, mapped);
    return mapped;
  }

  /** styles.xml with the appended records (unchanged text when none were). */
  toXml() {
    if (!this.changed) return this.xml;
    let xml = this.xml;
    for (const list of STYLE_LISTS) {
      const items = this.target[list];
      const existing = block(xml, list);
      if (existing) {
        const startTag = existing.match(new RegExp(`^<${list}\\b[^>]*?/?>`))[0].replace(/\/>$/, '>');
        const rebuilt = `${withAttr(startTag, 'count', String(items.length))}${items.join('')}</${list}>`;
        xml = xml.replace(existing, () => rebuilt);
      } else if (items.length) {
        // Only numFmts is optional in practice; it leads the stylesheet.
        xml = xml.replace(/(<styleSheet\b[^>]*>)/, `$1<${list} count="${items.length}">${items.join('')}</${list}>`);
      }
    }
    return xml;
  }
}

export {
  StyleMerger, attrsOf, block, cellText, colIndex, colLetters, elements, escapeXml,
  mergeRanges, parseRange, parseRef, parseSheet, partText, rangeRef, readPackage,
  setPartText, sharedStrings, unescapeXml, withAttr, writePackage,
};
