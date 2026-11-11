// Email: Outlook items (.msg, a compound file of MAPI properties) and
// internet messages (.eml, MIME). Both read into one shape — headers, a
// body, attachments — so the preview pane and the index treat them alike.
//
// Outlook rarely stores an HTML body as HTML: it keeps COMPRESSED RTF with
// the original HTML encapsulated inside (MS-OXRTFEX). msg.js reads the file
// and decompresses the RTF. The de-encapsulator
// below recovers that HTML; a message that really was RTF falls back to the
// plain-text body Outlook stores beside it.

import { decompressRtf, readMsgFile } from './msg.js';
import { clean, htmlToText } from './text.js';

/** Inline (cid:) images embedded into the body for display, each and total. */
const MAX_INLINE_IMAGE = 4 * 1024 * 1024;
const MAX_INLINE_TOTAL = 24 * 1024 * 1024;

// --- RTF → HTML -------------------------------------------------------------

/** RTF \fcharset numbers to Windows code pages. */
const CHARSET_CODEPAGES = {
  0: 1252, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250,
};

const DECODER_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874' };

function decoderFor(codepage) {
  try {
    return new TextDecoder(DECODER_LABELS[codepage] ?? `windows-${codepage}`);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

/**
 * The HTML encapsulated in an RTF body, or null when the RTF is native.
 * Inside `{\*\htmltag …}` groups the text IS the HTML; outside them, text
 * counts unless `\htmlrtf` has switched it off; every other `{\* …}`
 * destination (font tables, colour tables) is skipped.
 */
function rtfToHtml(rtf) {
  if (!/\\fromhtml1/.test(rtf.slice(0, 2048))) return null;
  const ansi = decoderFor(Number(rtf.match(/\\ansicpg(\d+)/)?.[1] ?? 1252));
  // Each font names a charset, and bytes written in that font are in its
  // code page — a Japanese run sits in Shift-JIS inside a 1252 document.
  const fontDecoders = new Map();
  const table = rtf.match(/\{\\fonttbl[\s\S]*?\}\s*\}/)?.[0] ?? '';
  for (const m of table.matchAll(/\\f(\d+)[^{}]*?\\fcharset(\d+)/g)) {
    const codepage = CHARSET_CODEPAGES[Number(m[2])];
    if (codepage) fontDecoders.set(Number(m[1]), decoderFor(codepage));
  }
  let out = '';
  let bytes = [];
  let decoder = ansi;
  const flush = () => {
    if (bytes.length) out += decoder.decode(new Uint8Array(bytes));
    bytes = [];
  };
  const useFont = (n) => {
    const next = fontDecoders.get(n) ?? ansi;
    if (next === decoder) return;
    flush();
    decoder = next;
  };
  const emitChar = (code) => bytes.push(code);
  const emitString = (s) => {
    flush();
    out += s;
  };

  // Group state: { skip, htmltag, htmlrtf, uc }
  const stack = [];
  let state = { skip: false, htmltag: false, htmlrtf: false, uc: 1 };
  let pendingSkip = 0;
  const visible = () => !state.skip && (state.htmltag || !state.htmlrtf);

  for (let i = 0; i < rtf.length; i += 1) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push(state);
      state = { ...state };
      // "{\*\dest" — an ignorable destination unless it is the HTML.
      if (rtf.startsWith('\\*', i + 1)) {
        const word = rtf.slice(i + 4).match(/^([a-z]+)/)?.[1] ?? '';
        if (word === 'htmltag') {
          state.htmltag = true;
        } else {
          state.skip = true;
        }
      } else {
        const word = rtf.slice(i + 2).match(/^([a-z]+)/)?.[1] ?? '';
        if (rtf[i + 1] === '\\' && ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer'].includes(word)) {
          state.skip = true;
        }
      }
      continue;
    }
    if (ch === '}') {
      state = stack.pop() ?? state;
      continue;
    }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (visible()) emitChar(next.charCodeAt(0));
        i += 1;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        i += 3;
        if (pendingSkip > 0) {
          pendingSkip -= 1;
          continue;
        }
        if (visible()) emitChar(parseInt(hex, 16));
        continue;
      }
      const m = rtf.slice(i + 1, i + 40).match(/^([a-zA-Z]+)(-?\d+)? ?/);
      if (!m) {
        // Control symbols: \~ nbsp, \- optional hyphen, \_ hyphen.
        if (visible() && next === '~') emitString(' ');
        i += 1;
        continue;
      }
      i += m[0].length;
      const [, word, param] = m;
      const n = param === undefined ? null : Number(param);
      switch (word) {
        case 'htmlrtf':
          state.htmlrtf = n !== 0;
          break;
        case 'f':
          if (!state.skip) useFont(n ?? 0);
          break;
        case 'uc':
          state.uc = n ?? 1;
          break;
        case 'u':
          if (visible()) emitString(String.fromCharCode(n < 0 ? n + 65536 : n));
          pendingSkip = state.uc;
          break;
        case 'par':
        case 'line':
          if (visible()) emitString('\r\n');
          break;
        case 'tab':
          if (visible()) emitString('\t');
          break;
        case 'lquote': if (visible()) emitString('‘'); break;
        case 'rquote': if (visible()) emitString('’'); break;
        case 'ldblquote': if (visible()) emitString('“'); break;
        case 'rdblquote': if (visible()) emitString('”'); break;
        case 'bullet': if (visible()) emitString('•'); break;
        case 'emdash': if (visible()) emitString('—'); break;
        case 'endash': if (visible()) emitString('–'); break;
        default:
          break;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      continue;
    }
    if (visible()) emitChar(ch.charCodeAt(0));
  }
  flush();
  return out;
}

// --- readers -------------------------------------------------------------------

function addressList(list) {
  return (list ?? [])
    .map((a) => (a.name && a.address && a.name !== a.address ? `${a.name} <${a.address}>` : a.name || a.address || ''))
    .filter(Boolean)
    .join(', ');
}

/** An .eml file. */
async function readEml(bytes) {
  const { default: PostalMime } = await import('postal-mime');
  const email = await PostalMime.parse(Buffer.from(bytes), { attachmentEncoding: 'arraybuffer' });
  return {
    subject: email.subject ?? '',
    from: addressList(email.from ? [email.from] : []),
    to: addressList(email.to),
    cc: addressList(email.cc),
    date: email.date ?? null,
    html: email.html ?? null,
    text: email.text ? clean(email.text) : null,
    attachments: (email.attachments ?? []).map((att, index) => {
      const content = new Uint8Array(att.content);
      return {
        index,
        name: att.filename || `attachment-${index + 1}${att.mimeType === 'message/rfc822' ? '.eml' : ''}`,
        mime: att.mimeType ?? 'application/octet-stream',
        size: content.length,
        contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : null,
        inline: att.disposition === 'inline' || Boolean(att.related),
        content,
      };
    }),
  };
}

/** An Outlook .msg file. */
function readMsg(bytes) {
  const msg = readMsgFile(bytes);
  let html = msg.html;
  if (!html && msg.rtf) {
    try {
      html = rtfToHtml(Buffer.from(decompressRtf(msg.rtf)).toString('latin1'));
    } catch {
      html = null;
    }
  }
  const recipients = (type) => msg.recipients.filter((r) => r.type === type);
  return {
    subject: msg.subject,
    from: addressList([msg.sender]),
    to: addressList(recipients('to')),
    cc: addressList(recipients('cc')),
    date: msg.date,
    html,
    text: msg.body ? clean(msg.body) : null,
    attachments: msg.attachments,
  };
}

async function readMail(name, bytes) {
  return /\.msg$/i.test(name) ? readMsg(bytes) : readEml(bytes);
}

// --- outputs -------------------------------------------------------------------

/** Each attachment's label, by index: its name, made unique within the
 *  message ("image001.png", "image001.png (2)"). The index nests an
 *  attachment's text under its label, and the viewer finds it by the same. */
function attachmentLabels(attachments) {
  const seen = new Map();
  return attachments.map((att) => {
    const count = (seen.get(att.name) ?? 0) + 1;
    seen.set(att.name, count);
    return count === 1 ? att.name : `${att.name} (${count})`;
  });
}

/** The body for display: scripts, handlers and remote loads stripped, cid:
 *  images inlined. The pane still renders it in a sandboxed frame under a
 *  CSP — this is the second lock, not the only one. */
function displayHtml(html, attachments) {
  let budget = MAX_INLINE_TOTAL;
  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId.toLowerCase(), a]));
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<(iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/(["'(])cid:([^"')\s]+)/gi, (whole, quote, cid) => {
      let id = cid;
      try {
        id = decodeURIComponent(cid);
      } catch {
        // A malformed escape: match it as written.
      }
      const att = byCid.get(id.toLowerCase());
      if (!att || att.size > MAX_INLINE_IMAGE || att.size > budget) return whole;
      budget -= att.size;
      return `${quote}data:${att.mime};base64,${Buffer.from(att.content).toString('base64')}`;
    });
}

/** The message for the preview pane. */
function mailModel(mail) {
  const labels = attachmentLabels(mail.attachments);
  const text = mail.text ?? (mail.html ? htmlToText(mail.html) : '');
  return {
    format: 'mail',
    subject: mail.subject,
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    date: mail.date,
    html: mail.html ? displayHtml(mail.html, mail.attachments) : null,
    text,
    attachments: mail.attachments.map(({ index, name, mime, size, inline }, i) => ({
      index, name, label: labels[i], mime, size, inline,
    })),
  };
}

/** Header and body parts for the index (attachments recurse in the caller). */
function mailParts(mail) {
  const header = [
    mail.subject && `Subject: ${mail.subject}`,
    mail.from && `From: ${mail.from}`,
    mail.to && `To: ${mail.to}`,
    mail.cc && `Cc: ${mail.cc}`,
    mail.attachments.length && `Attachments: ${mail.attachments.map((a) => a.name).join(', ')}`,
  ].filter(Boolean).join('\n');
  const body = mail.text?.trim() ? mail.text : mail.html ? htmlToText(mail.html) : '';
  return [
    { where: 'header', text: header, unit: 'line' },
    { where: 'body', text: body, unit: 'line' },
  ].filter((p) => p.text);
}

export { attachmentLabels, mailModel, mailParts, readMail, rtfToHtml };
