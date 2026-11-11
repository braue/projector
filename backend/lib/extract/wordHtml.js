// A Word document (.docx) as HTML for the preview pane: headings from the
// paragraph styles, lists from the numbering part, bold/italic/strike and
// super/subscript, tables with merged cells, links, inline images, checkbox
// controls and footnotes. Layout (fonts, sizes, spacing) is left to the pane's own styles.
//
// The pane injects this HTML as-is, so every bit of document text and every
// attribute value goes through escapeHtml() — nothing from the file reaches
// the output raw. Links come out as text with the target in data-href: a
// click must never navigate the app's own window away.

import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { decodeText, unescapeXml } from './text.js';

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // Entities are decoded here, by unescapeXml: the parser's own decoding
  // leaves numeric references (&#x2610;) as written.
  processEntities: false,
});

/** Image types a browser shows; EMF/WMF and the like are left out. */
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// --- XML tree access (fast-xml-parser's ordered form) --------------------------

const tagOf = (node) => (node ? Object.keys(node).find((k) => k !== ':@') : undefined);
const kidsOf = (node) => {
  const kids = node?.[tagOf(node)];
  return Array.isArray(kids) ? kids : [];
};
const attr = (node, name) => {
  const value = node?.[':@']?.[name];
  return value === undefined ? undefined : unescapeXml(value);
};
const childOf = (node, name) => kidsOf(node).find((n) => tagOf(n) === name);
const textOf = (node) => unescapeXml(kidsOf(node).map((n) => n['#text'] ?? '').join(''));

/** A toggle property (<w:b/>, <w:b w:val="0"/>) is on unless it says off. */
function on(props, name) {
  const node = childOf(props, name);
  if (!node) return false;
  const val = attr(node, 'w:val');
  return val === undefined || !['0', 'false', 'off', 'none'].includes(String(val).toLowerCase());
}

function parsePart(pkg, name) {
  const bytes = pkg[name];
  if (!bytes) return null;
  const tree = parser.parse(decodeText(bytes));
  return tree.find((n) => tagOf(n) && !tagOf(n).startsWith('?')) ?? null;
}

function relsOf(pkg, partName) {
  const dir = path.posix.dirname(partName);
  const root = parsePart(pkg, path.posix.join(dir, '_rels', `${path.posix.basename(partName)}.rels`));
  const out = new Map();
  for (const rel of root ? kidsOf(root) : []) {
    if (tagOf(rel) !== 'Relationship') continue;
    const target = attr(rel, 'Target') ?? '';
    const external = attr(rel, 'TargetMode') === 'External';
    let resolved = target;
    if (!external) resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target));
    out.set(attr(rel, 'Id'), { external, target: resolved });
  }
  return out;
}

/** A checkbox content control's state and the glyphs that draw it, or
 *  null for any other control. */
function checkboxOf(sdt) {
  const box = childOf(childOf(sdt, 'w:sdtPr'), 'w14:checkbox');
  if (!box) return null;
  const glyph = (name, fallback) => {
    const code = parseInt(attr(childOf(box, name), 'w14:val') ?? '', 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
  };
  return {
    checked: ['1', 'true'].includes(String(attr(childOf(box, 'w14:checked'), 'w14:val') ?? '0')),
    glyphs: new Set([glyph('w14:checkedState', '☒'), glyph('w14:uncheckedState', '☐')]),
  };
}

// --- styles and numbering ----------------------------------------------------

/** styleId -> { name, basedOn, numPr } for paragraph styles. */
function readStyles(pkg) {
  const styles = new Map();
  const root = parsePart(pkg, 'word/styles.xml');
  for (const style of root ? kidsOf(root) : []) {
    if (tagOf(style) !== 'w:style') continue;
    const pPr = childOf(style, 'w:pPr');
    styles.set(attr(style, 'w:styleId'), {
      name: String(attr(childOf(style, 'w:name'), 'w:val') ?? '').toLowerCase(),
      basedOn: attr(childOf(style, 'w:basedOn'), 'w:val') ?? null,
      numPr: pPr ? childOf(pPr, 'w:numPr') : null,
    });
  }
  return styles;
}

/** numId -> ilvl -> 'ul' | 'ol'. */
function readNumbering(pkg) {
  const root = parsePart(pkg, 'word/numbering.xml');
  const abstract = new Map();
  const nums = new Map();
  for (const node of root ? kidsOf(root) : []) {
    const tag = tagOf(node);
    if (tag === 'w:abstractNum') {
      const levels = new Map();
      for (const lvl of kidsOf(node).filter((n) => tagOf(n) === 'w:lvl')) {
        const fmt = attr(childOf(lvl, 'w:numFmt'), 'w:val') ?? 'decimal';
        levels.set(String(attr(lvl, 'w:ilvl') ?? '0'), fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol');
      }
      abstract.set(String(attr(node, 'w:abstractNumId')), levels);
    } else if (tag === 'w:num') {
      nums.set(String(attr(node, 'w:numId')), String(attr(childOf(node, 'w:abstractNumId'), 'w:val')));
    }
  }
  return (numId, ilvl) => abstract.get(nums.get(String(numId)))?.get(String(ilvl)) ?? 'ul';
}

// --- the renderer ------------------------------------------------------------

class WordRenderer {
  constructor(pkg) {
    this.pkg = pkg;
    this.styles = readStyles(pkg);
    this.listType = readNumbering(pkg);
    this.rels = relsOf(pkg, 'word/document.xml');
    this.notes = []; // footnotes/endnotes in reference order: html
    this.checkbox = null; // inside a checkbox control: { checked, glyphs }
    this.noteParts = {
      footnote: this.#notesOf('word/footnotes.xml', 'w:footnote'),
      endnote: this.#notesOf('word/endnotes.xml', 'w:endnote'),
    };
  }

  #notesOf(name, tag) {
    const root = parsePart(this.pkg, name);
    const out = new Map();
    for (const note of root ? kidsOf(root) : []) {
      if (tagOf(note) === tag) out.set(String(attr(note, 'w:id')), note);
    }
    return out;
  }

  /** Style chain lookup: the first style up the basedOn chain that answers. */
  #styleChain(styleId) {
    const chain = [];
    for (let id = styleId, guard = 0; id && guard < 20; guard += 1) {
      const style = this.styles.get(id);
      if (!style) break;
      chain.push(style);
      id = style.basedOn;
    }
    return chain;
  }

  #blockTag(pPr) {
    const styleId = attr(childOf(pPr, 'w:pStyle'), 'w:val');
    for (const style of this.#styleChain(styleId)) {
      const heading = /^heading ([1-6])$/.exec(style.name);
      if (heading) return `h${heading[1]}`;
      if (style.name === 'title') return 'h1';
    }
    const id = /^Heading([1-6])$/.exec(styleId ?? '');
    return id ? `h${id[1]}` : 'p';
  }

  #listOf(pPr) {
    let numPr = pPr ? childOf(pPr, 'w:numPr') : null;
    if (!numPr) {
      const styleId = attr(childOf(pPr, 'w:pStyle'), 'w:val');
      numPr = this.#styleChain(styleId).find((s) => s.numPr)?.numPr ?? null;
    }
    if (!numPr) return null;
    const numId = attr(childOf(numPr, 'w:numId'), 'w:val');
    if (numId === undefined || String(numId) === '0') return null;
    const level = Number(attr(childOf(numPr, 'w:ilvl'), 'w:val') ?? 0);
    return { level, tag: this.listType(numId, level) };
  }

  /** Body-level children (paragraphs, tables), with list nesting. */
  blocks(nodes) {
    let html = '';
    const lists = []; // open lists: { level, tag }
    const closeTo = (level) => {
      while (lists.length && lists.at(-1).level > level) html += `</li></${lists.pop().tag}>`;
    };
    const outer = this.checkbox;
    for (const { node, box } of this.#flatten(nodes, outer)) {
      const tag = tagOf(node);
      this.checkbox = box;
      if (tag === 'w:p') {
        const pPr = childOf(node, 'w:pPr');
        const blockTag = this.#blockTag(pPr);
        // A numbered heading is still a heading.
        const list = blockTag === 'p' ? this.#listOf(pPr) : null;
        const { inner, after } = this.#paragraph(node);
        if (list) {
          closeTo(list.level);
          const top = lists.at(-1);
          if (top && top.level === list.level && top.tag !== list.tag) {
            html += `</li></${lists.pop().tag}>`;
          }
          if (lists.at(-1)?.level === list.level) {
            html += '</li>';
          } else {
            lists.push(list);
            html += `<${list.tag}>`;
          }
          html += `<li>${inner}${after}`;
          continue;
        }
        closeTo(-1);
        html += `<${blockTag}>${inner}</${blockTag}>${after}`;
      } else if (tag === 'w:tbl') {
        closeTo(-1);
        html += this.#table(node);
      }
    }
    closeTo(-1);
    this.checkbox = outer;
    return html;
  }

  /** Content controls and custom XML wrap blocks; unwrap them, keeping
   *  which checkbox control (if any) each block sits in. */
  #flatten(nodes, box) {
    const out = [];
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'w:sdt') out.push(...this.#flatten(kidsOf(childOf(node, 'w:sdtContent')), checkboxOf(node) ?? box));
      else if (tag === 'w:customXml' || tag === 'w:ins' || tag === 'w:moveTo') out.push(...this.#flatten(kidsOf(node), box));
      else if (tag === 'w:p' || tag === 'w:tbl') out.push({ node, box });
    }
    return out;
  }

  /** A paragraph's inline HTML, plus text-box contents to place after it. */
  #paragraph(p) {
    const ctx = { segments: [], after: '' };
    this.#inline(kidsOf(p), ctx, null);
    // Adjacent runs with the same formatting merge into one element.
    let inner = '';
    for (let i = 0; i < ctx.segments.length;) {
      const { key, open, close } = ctx.segments[i];
      let body = '';
      while (i < ctx.segments.length && ctx.segments[i].key === key) body += ctx.segments[i++].html;
      inner += open + body + close;
    }
    return { inner, after: ctx.after };
  }

  #inline(nodes, ctx, link) {
    for (const node of nodes) {
      switch (tagOf(node)) {
        case 'w:r':
          this.#run(node, ctx, link);
          break;
        case 'w:hyperlink': {
          const rel = this.rels.get(attr(node, 'r:id'));
          const anchor = attr(node, 'w:anchor');
          const href = rel?.external ? rel.target : anchor ? `#${anchor}` : null;
          this.#inline(kidsOf(node), ctx, href ?? link);
          break;
        }
        case 'w:ins':
        case 'w:moveTo':
        case 'w:smartTag':
        case 'w:fldSimple':
        case 'w:customXml':
          this.#inline(kidsOf(node), ctx, link);
          break;
        case 'w:sdt': {
          const outer = this.checkbox;
          this.checkbox = checkboxOf(node) ?? outer;
          this.#inline(kidsOf(childOf(node, 'w:sdtContent')), ctx, link);
          this.checkbox = outer;
          break;
        }
        case 'm:oMathPara':
        case 'm:oMath':
          this.#push(ctx, link, '', escapeHtml(this.#mathText(node)));
          break;
        default:
          // w:del / w:moveFrom (deleted text), bookmarks, properties.
          break;
      }
    }
  }

  #mathText(node) {
    if (tagOf(node) === 'm:t') return textOf(node);
    return kidsOf(node).map((n) => (n['#text'] === undefined ? this.#mathText(n) : '')).join('');
  }

  #push(ctx, link, format, html) {
    if (!html) return;
    const tags = format ? format.split(',') : [];
    let open = tags.map((t) => `<${t}>`).join('');
    let close = tags.toReversed().map((t) => `</${t}>`).join('');
    if (link) {
      const target = escapeHtml(link);
      open = `<a data-href="${target}" title="${target}">${open}`;
      close = `${close}</a>`;
    }
    ctx.segments.push({ key: `${link ?? ''}|${format}`, open, close, html });
  }

  #run(r, ctx, link) {
    const rPr = childOf(r, 'w:rPr');
    const tags = [];
    if (rPr) {
      if (on(rPr, 'w:b')) tags.push('strong');
      if (on(rPr, 'w:i')) tags.push('em');
      if (on(rPr, 'w:strike') || on(rPr, 'w:dstrike')) tags.push('s');
      const va = attr(childOf(rPr, 'w:vertAlign'), 'w:val');
      if (va === 'superscript') tags.push('sup');
      if (va === 'subscript') tags.push('sub');
    }
    const format = tags.join(',');
    for (const node of kidsOf(r)) {
      switch (tagOf(node)) {
        case 'w:t': {
          const text = textOf(node);
          const box = this.checkbox;
          // A checkbox control's glyph draws as a checkbox.
          const html = box
            ? [...text].map((ch) => (box.glyphs.has(ch) ? `<input type="checkbox"${box.checked ? ' checked' : ''} />` : escapeHtml(ch))).join('')
            : escapeHtml(text);
          this.#push(ctx, link, format, html);
          break;
        }
        case 'w:tab':
        case 'w:ptab':
          this.#push(ctx, link, format, '\t');
          break;
        case 'w:br': {
          const type = attr(node, 'w:type');
          if (type !== 'page' && type !== 'column') this.#push(ctx, link, format, '<br />');
          break;
        }
        case 'w:cr':
          this.#push(ctx, link, format, '<br />');
          break;
        case 'w:noBreakHyphen':
          this.#push(ctx, link, format, '‑');
          break;
        case 'w:footnoteReference':
        case 'w:endnoteReference': {
          const kind = tagOf(node) === 'w:footnoteReference' ? 'footnote' : 'endnote';
          const note = this.noteParts[kind].get(String(attr(node, 'w:id')));
          if (!note) break;
          this.notes.push(this.blocks(kidsOf(note)));
          this.#push(ctx, link, 'sup', `[${this.notes.length}]`);
          break;
        }
        case 'w:drawing':
        case 'w:pict':
        case 'mc:AlternateContent':
          this.#graphic(node, ctx, link);
          break;
        default:
          break;
      }
    }
  }

  /** Images and text boxes inside a drawing (DrawingML or VML). Alternate
   *  content is read from its first choice only, so nothing shows twice. */
  #graphic(node, ctx, link) {
    const tag = tagOf(node);
    if (tag === 'mc:AlternateContent') {
      const choice = childOf(node, 'mc:Choice') ?? childOf(node, 'mc:Fallback');
      for (const kid of choice ? kidsOf(choice) : []) this.#graphic(kid, ctx, link);
      return;
    }
    if (tag === 'w:txbxContent') {
      ctx.after += this.blocks(kidsOf(node));
      return;
    }
    if (tag === 'a:blip' || tag === 'v:imagedata') {
      const id = attr(node, 'r:embed') ?? attr(node, 'r:id');
      const img = this.#image(id, ctx.alt ?? '');
      ctx.alt = '';
      if (img) this.#push(ctx, link, '', img);
      return;
    }
    if (tag === 'wp:docPr') ctx.alt = attr(node, 'descr') || attr(node, 'title') || '';
    for (const kid of kidsOf(node)) if (kid['#text'] === undefined) this.#graphic(kid, ctx, link);
  }

  #image(relId, alt) {
    const rel = this.rels.get(relId);
    if (!rel || rel.external) return null;
    const bytes = this.pkg[rel.target];
    const mime = IMAGE_TYPES[path.posix.extname(rel.target).toLowerCase()];
    if (!bytes || !mime) return null;
    return `<img src="data:${mime};base64,${Buffer.from(bytes).toString('base64')}" alt="${escapeHtml(alt)}" />`;
  }

  /** A table, with gridSpan as colspan and vMerge as rowspan. */
  #table(tbl) {
    const rows = [];
    for (const tr of kidsOf(tbl).filter((n) => tagOf(n) === 'w:tr')) {
      const trPr = childOf(tr, 'w:trPr');
      const header = Boolean(trPr && childOf(trPr, 'w:tblHeader'));
      const cells = [];
      let col = Number(attr(childOf(trPr ?? {}, 'w:gridBefore'), 'w:val') ?? 0);
      const cellNodes = [];
      const outer = this.checkbox;
      for (const kid of kidsOf(tr)) {
        if (tagOf(kid) === 'w:tc') cellNodes.push({ tc: kid, box: outer });
        else if (tagOf(kid) === 'w:sdt') {
          const box = checkboxOf(kid) ?? outer;
          for (const tc of kidsOf(childOf(kid, 'w:sdtContent')).filter((n) => tagOf(n) === 'w:tc')) cellNodes.push({ tc, box });
        }
      }
      for (const { tc, box } of cellNodes) {
        this.checkbox = box;
        const tcPr = childOf(tc, 'w:tcPr');
        const span = Number(attr(childOf(tcPr ?? {}, 'w:gridSpan'), 'w:val') ?? 1) || 1;
        const vMergeNode = tcPr ? childOf(tcPr, 'w:vMerge') : null;
        const vMerge = vMergeNode ? (attr(vMergeNode, 'w:val') === 'restart' ? 'restart' : 'continue') : null;
        cells.push({ col, span, vMerge, rowspan: 1, html: this.blocks(kidsOf(tc)) });
        col += span;
      }
      this.checkbox = outer;
      rows.push({ header, cells });
    }
    // A "continue" cell folds into the cell that started the merge above it,
    // however many rows back that was.
    const started = new Map(); // grid column -> the cell whose merge is open
    for (const row of rows) {
      row.cells = row.cells.filter((cell) => {
        const origin = started.get(cell.col);
        if (cell.vMerge === 'continue' && origin) {
          origin.rowspan += 1;
          return false;
        }
        for (let c = cell.col; c < cell.col + cell.span; c += 1) started.delete(c);
        if (cell.vMerge === 'restart') started.set(cell.col, cell);
        return true;
      });
    }
    const html = ({ header, cells }) => `<tr>${cells.map((cell) => {
      const t = header ? 'th' : 'td';
      const span = (cell.span > 1 ? ` colspan="${cell.span}"` : '') + (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '');
      return `<${t}${span}>${cell.html}</${t}>`;
    }).join('')}</tr>`;
    // Leading header rows (repeated on each page in Word) make the head.
    const heads = rows.findIndex((row) => !row.header);
    const split = heads === -1 ? rows.length : heads;
    const head = split ? `<thead>${rows.slice(0, split).map(html).join('')}</thead>` : '';
    const body = rows.slice(split).map(html).join('');
    return `<table>${head}${body ? `<tbody>${body}</tbody>` : ''}</table>`;
  }

  document() {
    const root = parsePart(this.pkg, 'word/document.xml');
    const body = root ? childOf(root, 'w:body') : null;
    let html = body ? this.blocks(kidsOf(body)) : '';
    if (this.notes.length) {
      html += `<ol>${this.notes.map((note) => `<li>${note}</li>`).join('')}</ol>`;
    }
    return html;
  }
}

/** `pkg` is the unzipped package: { partName: bytes }. */
function wordHtml(pkg) {
  return new WordRenderer(pkg).document();
}

export { escapeHtml, wordHtml };
