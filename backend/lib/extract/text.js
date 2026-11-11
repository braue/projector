// Plain text in whatever encoding it arrived in, and the small helpers every
// extractor shares.
//
// Engineering folders are full of files Notepad wrote: UTF-16 with a BOM
// (anything exported from a Windows tool), UTF-8 with or without one, and
// the odd Windows-1252 file from an older program. Decoding has to guess
// right or a search for "Ω" or "°" quietly misses.

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_LOOSE = new TextDecoder('utf-8');
const UTF16LE = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');
const CP1252 = new TextDecoder('windows-1252');

/** Bytes to a string: BOM first, then strict UTF-8, then Windows-1252. */
function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return UTF16LE.decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return UTF16BE.decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return UTF8_LOOSE.decode(b.subarray(3));
  // BOM-less UTF-16 (some exporters): every other byte of ASCII text is zero.
  if (b.length >= 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return UTF16LE.decode(b);
  try {
    return UTF8.decode(b);
  } catch {
    return CP1252.decode(b);
  }
}

/** Whitespace collapsed to single spaces and stray control bytes dropped —
 *  for text whose line breaks are layout, not meaning (PDF pages, cells). */
function flatten(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Control bytes dropped but line breaks kept — for text read by line. */
function clean(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function unescapeXml(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Readable text out of HTML (an email body): block tags become line
 *  breaks, everything else is stripped, entities decoded. */
function htmlToText(html) {
  return clean(unescapeXml(String(html ?? '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')))
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { clean, decodeText, flatten, htmlToText, unescapeXml };
