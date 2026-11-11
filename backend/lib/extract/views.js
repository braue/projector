// What the preview pane draws for a file it can show in-app: a workbook's
// grid, a deck's slides, a document's HTML, a message, an archive listing.
//
// A file inside a container (an entry of a zip, an attachment of an email)
// is addressed by a CHAIN of steps from the tree entry — zip steps are entry
// names, mail steps attachment indexes — so an attachment inside a zipped
// message opens like any file in the tree.

import { httpError } from '../http.js';
import { formatOf } from './index.js';
import { attachmentLabels, mailModel, readMail } from './mail.js';
import { docxHtml, pptxModel, xlsxModel } from './office.js';
import { decodeText } from './text.js';
import { zipEntries, zipEntry } from './zip.js';

const VIEW_MAX_ROWS = 5000;

/** Follow `chain` from a tree entry's bytes to the inner file it names.
 *  Returns { name, bytes, labels } — `labels` are the steps as the index
 *  prefixes nested text with them (entry paths, attachment labels). */
async function resolveInner(name, bytes, chain = []) {
  let current = { name, bytes };
  const labels = [];
  for (const step of chain) {
    const format = formatOf(current.name);
    if (format === 'zip') {
      const inner = zipEntry(current.bytes, String(step));
      if (!inner) throw httpError(404, `not in the archive: ${step}`);
      current = { name: String(step).split('/').pop(), bytes: inner };
      labels.push(String(step));
    } else if (format === 'mail') {
      const mail = await readMail(current.name, current.bytes);
      const att = mail.attachments[Number(step)];
      if (!att) throw httpError(404, `no attachment ${step}`);
      current = { name: att.name, bytes: att.content };
      labels.push(attachmentLabels(mail.attachments)[Number(step)]);
    } else {
      throw httpError(400, `${current.name} holds no files`);
    }
  }
  return { ...current, labels };
}

/** The parts of an inner file, cut out of its container's parts (which the
 *  index has already read, OCR included) by the labels the chain walked. */
function innerParts(parts, labels) {
  let out = parts;
  for (const label of labels) {
    const prefix = `${label} › `;
    out = out
      .filter((p) => p.where === label || p.where.startsWith(prefix))
      .map((p) => ({ ...p, where: p.where === label ? '' : p.where.slice(prefix.length) }));
  }
  return out;
}

// --- delimited text ------------------------------------------------------------

function sniffDelimiter(text) {
  const head = text.slice(0, 4096).split('\n').slice(0, 5).join('\n');
  const counts = [',', ';', '\t', '|'].map((d) => [d, head.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}

/** RFC 4180 rows: quoted fields may hold delimiters, quotes ("") and breaks. */
function parseDelimited(text, delimiter, maxRows) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let total = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') {
      total += 1;
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      endRow();
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) endRow();
  return { rows, total };
}

function csvModel(bytes) {
  const text = decodeText(bytes);
  const { rows, total } = parseDelimited(text, sniffDelimiter(text), VIEW_MAX_ROWS);
  const cols = rows.reduce((n, row) => Math.max(n, row.length), 0);
  return {
    format: 'sheet',
    sheets: [{
      name: '',
      hidden: false,
      rows: rows.map((row, index) => ({
        r: index + 1,
        cells: row.map((v, c) => ({ c: c + 1, v })).filter((cell) => cell.v !== ''),
      })),
      merges: [],
      widths: {},
      cols,
      totalRows: total,
    }],
  };
}

// --- code ------------------------------------------------------------------------

function codeModel(bytes, format) {
  let text = decodeText(bytes);
  if (format === 'json') {
    // Pretty-printed when it parses; as written when it does not.
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // keep the original text
    }
  }
  return { format: 'code', language: format, text };
}

/**
 * The view model of a file (or of an inner file, via `chain`). Formats with
 * a viewer of their own elsewhere (PDF, plain text) and images report just
 * their format — the pane loads those from the raw bytes.
 */
async function viewModel(name, bytes, chain = []) {
  const inner = await resolveInner(name, bytes, chain);
  const format = formatOf(inner.name);
  switch (format) {
    case 'docx':
      return { format: 'doc', html: await docxHtml(inner.bytes) };
    case 'xlsx':
      return xlsxModel(inner.bytes);
    case 'csv':
      return csvModel(inner.bytes);
    case 'pptx':
      return pptxModel(inner.bytes);
    case 'mail':
      return mailModel(await readMail(inner.name, inner.bytes));
    case 'zip':
      return { format: 'zip', entries: zipEntries(inner.bytes).filter((e) => !e.dir) };
    case 'json':
    case 'xml':
    case 'text':
      return codeModel(inner.bytes, format);
    case 'image':
      return { format: 'image' };
    case 'pdf':
      return { format: 'pdf' };
    default:
      return { format: 'none' };
  }
}

export { innerParts, parseDelimited, resolveInner, viewModel };
