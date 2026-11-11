// Text out of any file the project tree holds, by extension — what the
// project search indexes and what the preview pane shows.
//
// `extract` returns PARTS: [{ where, text, unit? }]. `where` locates the text
// for a reader ("p. 12", "Sheet1 · row 40", "slide 3", "drawings.zip ›
// one-line.pdf · p. 2"); `unit: 'line'` says the text is line-structured and
// a hit should report its line within the part. Containers (zip, email)
// recurse into what they hold, so a term inside a PDF attached to an email
// inside a zip is still found, and says where it was.
//
// OCR is a second pass. `extract(…, { ocr: false })` reads every text layer
// and reports `wantsOcr` when something (an image, a scanned page) needs
// reading; the index runs those again with `ocr: true` once every file's
// text is in, so a 300-page scan never holds up the spreadsheets.

import path from 'node:path';

import { attachmentLabels, mailParts, readMail } from './mail.js';
import { docxParts, pptxParts, xlsxParts } from './office.js';
import { recognize } from './ocr.js';
import { pdfPages } from './pdf.js';
import { clean, decodeText } from './text.js';
import { zipEntries, zipEntry } from './zip.js';

/** Bump when extraction changes, so cached text is read again. */
const EXTRACT_VERSION = 2;

const FORMATS = {
  txt: 'text', md: 'text', csv: 'csv', json: 'json', xml: 'xml',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx',
  msg: 'mail', eml: 'mail',
  zip: 'zip',
};

const MIME = {
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook', eml: 'message/rfc822', zip: 'application/zip',
};

/** Characters kept per top-level file — a 2 GB log is not worth indexing whole. */
const MAX_CHARS = 8_000_000;
/** Containers inside containers, this deep. */
const MAX_DEPTH = 3;
/** Entries larger than this inside a container are listed, not read. */
const MAX_INNER_BYTES = 128 * 1024 * 1024;
/** Entries read per archive. */
const MAX_INNER_ENTRIES = 2000;

function extOf(name) {
  return path.extname(String(name)).slice(1).toLowerCase();
}

/** The format family of a file name, or null for one we do not read. */
function formatOf(name) {
  return FORMATS[extOf(name)] ?? null;
}

function mimeOf(name) {
  return MIME[extOf(name)] ?? 'application/octet-stream';
}

function nest(prefix, parts) {
  return parts.map((p) => ({ ...p, where: p.where ? `${prefix} › ${p.where}` : prefix }));
}

async function extractInner(name, bytes, options) {
  if (!bytes || bytes.length > MAX_INNER_BYTES || options.depth >= MAX_DEPTH) return { parts: [], wantsOcr: false };
  try {
    return await extract(name, bytes, { ...options, depth: options.depth + 1 });
  } catch (err) {
    // OCR not working is not this entry's fault: the whole pass fails, and
    // the index keeps the text layer it already has.
    if (err?.ocrFailure) throw err;
    // One unreadable attachment must not cost the message its text.
    return { parts: [], wantsOcr: false };
  }
}

/**
 * The text of one file. Throws on a file its format reader cannot open (a
 * corrupt workbook); the caller records that rather than retrying forever.
 */
async function extract(name, bytes, { ocr = false, depth = 0 } = {}) {
  const format = formatOf(name);
  let parts = [];
  let wantsOcr = false;
  let meta = null;
  switch (format) {
    case 'text':
    case 'csv':
    case 'json':
    case 'xml':
      parts = [{ where: '', text: clean(decodeText(bytes)), unit: 'line' }];
      break;
    case 'pdf': {
      const read = await pdfPages(bytes, { ocr });
      wantsOcr = read.wantsOcr;
      meta = { pages: read.pages.length };
      parts = read.pages.map((text, index) => ({ where: `p. ${index + 1}`, text })).filter((p) => p.text);
      break;
    }
    case 'image':
      if (ocr) {
        const text = clean(await recognize(bytes)).replace(/\n{2,}/g, '\n').trim();
        if (text) parts = [{ where: '', text, unit: 'line' }];
      } else {
        wantsOcr = true;
      }
      break;
    case 'docx':
      parts = docxParts(bytes);
      break;
    case 'xlsx':
      parts = xlsxParts(bytes);
      break;
    case 'pptx':
      parts = pptxParts(bytes);
      break;
    case 'mail': {
      const mail = await readMail(name, bytes);
      parts = mailParts(mail);
      const labels = attachmentLabels(mail.attachments);
      for (const [i, att] of mail.attachments.entries()) {
        if (!formatOf(att.name)) continue;
        const inner = await extractInner(att.name, att.content, { ocr, depth });
        wantsOcr ||= inner.wantsOcr;
        parts.push(...nest(labels[i], inner.parts));
      }
      break;
    }
    case 'zip': {
      const entries = zipEntries(bytes).filter((e) => !e.dir);
      parts = [{ where: 'contents', text: entries.map((e) => e.name).join('\n'), unit: 'line' }];
      for (const entry of entries.filter((e) => formatOf(e.name)).slice(0, MAX_INNER_ENTRIES)) {
        if (entry.size > MAX_INNER_BYTES) continue;
        const inner = await extractInner(entry.name, zipEntry(bytes, entry.name), { ocr, depth });
        wantsOcr ||= inner.wantsOcr;
        parts.push(...nest(entry.name, inner.parts));
      }
      break;
    }
    default:
      return { parts: [], wantsOcr: false, meta };
  }
  return { parts: depth === 0 ? capped(parts) : parts, wantsOcr, meta };
}

function capped(parts) {
  let left = MAX_CHARS;
  const out = [];
  for (const part of parts) {
    if (left <= 0) break;
    out.push(part.text.length > left ? { ...part, text: part.text.slice(0, left) } : part);
    left -= part.text.length;
  }
  return out;
}

export { EXTRACT_VERSION, extract, formatOf, mimeOf };
