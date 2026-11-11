// Minimal documents of every format the content index reads, written here
// so a test knows exactly what text is inside. Office files are the smallest
// packages Office itself would open; images are rendered from a PDF page,
// so OCR tests read real anti-aliased type rather than a bitmap font.

import { strToU8, zipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { pdfium } from '../../lib/pdfium.js';
import { encodePng } from '../../lib/png.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CONTENT_TYPES = (overrides) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${overrides.map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('\n')}
</Types>`;

const ROOT_RELS = (target, type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument') =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`;

function zip(entries) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
}

/** A Word document: one paragraph per entry; a header line when given. */
function makeDocx(paragraphs, { header = null } = {}) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
  const entries = {
    '[Content_Types].xml': CONTENT_TYPES([
      ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ...(header ? [['word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml']] : []),
    ]),
    '_rels/.rels': ROOT_RELS('word/document.xml'),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  };
  if (header) {
    entries['word/header1.xml'] = `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}><w:p><w:r><w:t>${esc(header)}</w:t></w:r></w:p></w:hdr>`;
  }
  return zip(entries);
}

/** A workbook: { SheetName: [[cell, …], …] }. Numbers stay numbers; a
 *  { v, fmt } cell carries a number format code. */
function makeXlsx(sheets) {
  const strings = [];
  const stringIndex = (s) => {
    let at = strings.indexOf(s);
    if (at === -1) at = strings.push(s) - 1;
    return at;
  };
  const formats = [];
  const styleIndex = (code) => {
    let at = formats.indexOf(code);
    if (at === -1) at = formats.push(code) - 1;
    return at + 1;
  };
  const col = (n) => String.fromCharCode(65 + n);
  const names = Object.keys(sheets);
  const entries = {};
  names.forEach((name, si) => {
    const rows = sheets[name].map((row, ri) => `<row r="${ri + 1}">${row.map((cell, ci) => {
      const ref = `${col(ci)}${ri + 1}`;
      if (cell === null || cell === undefined) return '';
      if (typeof cell === 'object') return `<c r="${ref}" s="${styleIndex(cell.fmt)}"><v>${cell.v}</v></c>`;
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      return `<c r="${ref}" t="s"><v>${stringIndex(cell)}</v></c>`;
    }).join('')}</row>`).join('');
    entries[`xl/worksheets/sheet${si + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  entries['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  entries['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  entries['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  entries['xl/styles.xml'] = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts>${formats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f).replace(/"/g, '&quot;')}"/>`).join('')}</numFmts><cellXfs><xf numFmtId="0"/>${formats.map((_, i) => `<xf numFmtId="${164 + i}"/>`).join('')}</cellXfs></styleSheet>`;
  entries['[Content_Types].xml'] = CONTENT_TYPES([
    ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
    ...names.map((_, i) => [`xl/worksheets/sheet${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']),
  ]);
  entries['_rels/.rels'] = ROOT_RELS('xl/workbook.xml');
  return zip(entries);
}

/** A deck: [{ title, bullets: [], notes }]. */
function makePptx(slides) {
  const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const shape = (ph, paragraphs) => `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paragraphs.map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const entries = {};
  slides.forEach((slide, i) => {
    const n = i + 1;
    entries[`ppt/slides/slide${n}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree>${shape('title', [slide.title])}${shape(null, slide.bullets ?? [])}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes) {
      entries[`ppt/notesSlides/notesSlide${n}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P}><p:cSld><p:spTree>${shape('body', [slide.notes])}</p:spTree></p:cSld></p:notes>`;
      entries[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
    }
  });
  entries['ppt/presentation.xml'] = `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`;
  entries['ppt/_rels/presentation.xml.rels'] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`;
  entries['[Content_Types].xml'] = CONTENT_TYPES([['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml']]);
  entries['_rels/.rels'] = ROOT_RELS('ppt/presentation.xml');
  return zip(entries);
}

/** An internet message with a plain body and named attachments. */
function makeEml({ subject, from, to, body, html = null, attachments = [] }) {
  const boundary = 'b1_projector';
  const parts = [
    `--${boundary}\r\nContent-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${html ?? body}\r\n`,
    ...attachments.map(({ name, type, bytes }) =>
      `--${boundary}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`),
  ];
  return Buffer.from([
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'Date: Tue, 10 Nov 2026 09:30:00 -0600',
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    ...parts, `--${boundary}--`, '',
  ].join('\r\n'));
}

/** A text PDF: one page per entry, each a list of drawn lines. */
async function makePdf(pages) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = document.addPage([612, 792]);
    lines.forEach((line, index) => page.drawText(line, { x: 50, y: 720 - index * 18, size: 11, font }));
  }
  return Buffer.from(await document.save());
}

/** A PNG of `text` in large type — a screenshot, as far as OCR can tell. */
async function makeTextPng(text) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 120]);
  page.drawText(text, { x: 20, y: 50, size: 32, font });
  const library = await pdfium();
  const document = await library.loadDocument(Buffer.from(await pdf.save()));
  try {
    const { data, width, height } = await document.getPage(0).render({ scale: 2, render: 'bitmap' });
    const png = { width, height, data: Buffer.alloc(width * height * 4) };
    // Transparent paper reads as white.
    for (let i = 0; i < width * height * 4; i += 4) {
      const a = data[i + 3] / 255;
      png.data[i] = Math.round(data[i] * a + 255 * (1 - a));
      png.data[i + 1] = Math.round(data[i + 1] * a + 255 * (1 - a));
      png.data[i + 2] = Math.round(data[i + 2] * a + 255 * (1 - a));
      png.data[i + 3] = 255;
    }
    return encodePng(png);
  } finally {
    document.destroy();
  }
}

/** A "scanned" PDF: the page is an image of the text, no text layer. */
async function makeScannedPdf(text) {
  const document = await PDFDocument.create();
  const image = await document.embedPng(await makeTextPng(text));
  const page = document.addPage([600, 120]);
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 120 });
  return Buffer.from(await document.save());
}

export { makeDocx, makeEml, makePdf, makePptx, makeScannedPdf, makeTextPng, makeXlsx, zip };
