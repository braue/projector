// Outlook .msg files (MS-OXMSG): a compound file whose streams are MAPI
// properties. Variable-size values (strings, binaries) are streams named
// __substg1.0_<id><type>; fixed-size ones (numbers, flags, times) sit in the
// __properties_version1.0 table. Recipients and attachments are storages of
// their own, laid out the same way. An attached message is a storage too,
// written back out as a .msg file of its own so it opens like any other.
//
// The body Outlook keeps is often only compressed RTF (MS-OXRTFCP); that is
// decompressed here, and mail.js recovers the HTML inside it.

import CFB from 'cfb';

// Property ids.
const PR = {
  subject: 0x0037,
  senderName: 0x0c1a,
  senderEmail: 0x0c1f,
  senderSmtp: 0x5d01,
  submitTime: 0x0039,
  deliveryTime: 0x0e06,
  body: 0x1000,
  rtfCompressed: 0x1009,
  html: 0x1013,
  internetCodepage: 0x3fde,
  messageCodepage: 0x3ffd,
  displayName: 0x3001,
  emailAddress: 0x3003,
  smtpAddress: 0x39fe,
  recipientType: 0x0c15,
  attachData: 0x3701,
  attachShortName: 0x3704,
  attachMethod: 0x3705,
  attachLongName: 0x3707,
  attachMime: 0x370e,
  attachContentId: 0x3712,
  attachHidden: 0x7ffe,
};

const TYPE = { int32: 0x0003, bool: 0x000b, time: 0x0040, string8: 0x001e, unicode: 0x001f, binary: 0x0102, object: 0x000d };

const CODEPAGE_LABELS = {
  65001: 'utf-8', 1200: 'utf-16le', 20127: 'us-ascii', 28591: 'iso-8859-1', 28592: 'iso-8859-2',
  932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 50220: 'iso-2022-jp', 51932: 'euc-jp', 20866: 'koi8-r',
};

function decoderFor(codepage, fallback = 'windows-1252') {
  const label = CODEPAGE_LABELS[codepage] ?? (codepage ? `windows-${codepage}` : fallback);
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder(fallback);
  }
}

// --- compressed RTF (MS-OXRTFCP) ---------------------------------------------

const RTF_PREBUFFER = Buffer.from(
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx',
  'latin1',
);

/** The RTF inside a PR_RTF_COMPRESSED value, as bytes. */
function decompressRtf(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length < 16) throw new Error('compressed RTF too short');
  const compSize = buf.readUInt32LE(0);
  const rawSize = buf.readUInt32LE(4);
  const magic = buf.readUInt32LE(8);
  const end = Math.min(buf.length, compSize + 4);
  if (magic === 0x414c454d) return buf.subarray(16, 16 + rawSize); // "MELA": stored
  if (magic !== 0x75465a4c) throw new Error('unknown compressed RTF type'); // "LZFu"

  const dict = Buffer.alloc(4096);
  RTF_PREBUFFER.copy(dict);
  let write = RTF_PREBUFFER.length;
  const out = Buffer.alloc(rawSize);
  let size = 0;
  let at = 16;
  while (at < end) {
    const control = buf[at++];
    for (let bit = 0; bit < 8 && at < end; bit += 1) {
      if ((control & (1 << bit)) === 0) {
        const byte = buf[at++];
        if (size < rawSize) out[size++] = byte;
        dict[write] = byte;
        write = (write + 1) % 4096;
        continue;
      }
      if (at + 1 >= end) return out.subarray(0, size);
      const word = buf.readUInt16BE(at);
      at += 2;
      const offset = word >> 4;
      const length = (word & 0x0f) + 2;
      if (offset === write) return out.subarray(0, size); // the end marker
      for (let i = 0; i < length; i += 1) {
        const byte = dict[(offset + i) % 4096];
        if (size < rawSize) out[size++] = byte;
        dict[write] = byte;
        write = (write + 1) % 4096;
      }
    }
  }
  return out.subarray(0, size);
}

// --- property storage ----------------------------------------------------------

const PROPS_STREAM = '__properties_version1.0';

/**
 * One storage's properties: `get(id)` returns a string, Buffer, number,
 * boolean or Date, or undefined. `headerSize` is the property table's
 * header: 32 for a top-level message, 24 for an attached one, 8 for a
 * recipient or attachment.
 */
function propertiesOf(streams, headerSize, codepage = 0) {
  const fixed = new Map();
  const table = streams.get(PROPS_STREAM);
  for (let at = headerSize; table && at + 16 <= table.length; at += 16) {
    const type = table.readUInt16LE(at);
    const id = table.readUInt16LE(at + 2);
    if (type === TYPE.int32) fixed.set(id, table.readInt32LE(at + 8));
    else if (type === TYPE.bool) fixed.set(id, table[at + 8] !== 0);
    else if (type === TYPE.time) fixed.set(id, filetime(table.readBigUInt64LE(at + 8)));
  }
  const hex = (id, type) => `__substg1.0_${id.toString(16).toUpperCase().padStart(4, '0')}${type.toString(16).toUpperCase().padStart(4, '0')}`;
  const get = (id) => {
    if (fixed.has(id)) return fixed.get(id);
    const unicode = streams.get(hex(id, TYPE.unicode));
    if (unicode) return unicode.toString('utf16le').replace(/\0+$/, '');
    const string8 = streams.get(hex(id, TYPE.string8));
    if (string8) return decoderFor(codepage || get(PR.messageCodepage)).decode(string8).replace(/\0+$/, '');
    return streams.get(hex(id, TYPE.binary));
  };
  return { get };
}

function filetime(ticks) {
  if (!ticks) return null;
  const ms = Number((ticks - 116444736000000000n) / 10000n);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** The compound file as a tree: { streams: Map<name, Buffer>, storages: Map<name, node> }. */
function treeOf(cfb) {
  const root = { streams: new Map(), storages: new Map() };
  for (const [i, full] of cfb.FullPaths.entries()) {
    const entry = cfb.FileIndex[i];
    const parts = full.split('/').filter(Boolean).slice(1); // past "Root Entry"
    if (!parts.length) continue;
    let node = root;
    for (const name of parts.slice(0, -1)) {
      if (!node.storages.has(name)) node.storages.set(name, { streams: new Map(), storages: new Map() });
      node = node.storages.get(name);
    }
    const name = parts.at(-1);
    if (entry.type === 2) node.streams.set(name, Buffer.from(entry.content ?? []));
    else if (!node.storages.has(name)) node.storages.set(name, { streams: new Map(), storages: new Map() });
  }
  return root;
}

/** Child storages with a prefix (__recip_version1.0_#…), in order. */
function childrenOf(node, prefix) {
  return [...node.storages.entries()]
    .filter(([name]) => name.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, child]) => child);
}

/** An attached message storage written out as a standalone .msg. */
function messageFile(node, nameid) {
  const cfb = CFB.utils.cfb_new();
  const add = (prefix, storage) => {
    for (const [name, bytes] of storage.streams) {
      let content = bytes;
      // An attached message's property header is 24 bytes; a file's is 32.
      if (!prefix && name === PROPS_STREAM) content = Buffer.concat([bytes.subarray(0, 24), Buffer.alloc(8), bytes.subarray(24)]);
      CFB.utils.cfb_add(cfb, `/${prefix}${name}`, content);
    }
    for (const [name, child] of storage.storages) add(`${prefix}${name}/`, child);
  };
  add('', node);
  if (nameid) add('__nameid_version1.0/', nameid);
  CFB.utils.cfb_del(cfb, '/\u0001Sh33tJ5');
  return new Uint8Array(CFB.write(cfb, { type: 'buffer', fileType: 'cfb' }));
}

const RECIPIENT_TYPES = { 1: 'to', 2: 'cc', 3: 'bcc' };

function readMessage(node, headerSize, nameid) {
  const props = propertiesOf(node.streams, headerSize);
  const codepage = props.get(PR.messageCodepage) ?? 0;
  const text = (id) => {
    const value = props.get(id);
    return typeof value === 'string' ? value : undefined;
  };

  let html = props.get(PR.html);
  if (Buffer.isBuffer(html)) html = decoderFor(props.get(PR.internetCodepage), 'utf-8').decode(html);
  const rtf = props.get(PR.rtfCompressed);

  const recipients = childrenOf(node, '__recip_version1.0_#').map((child) => {
    const p = propertiesOf(child.streams, 8, codepage);
    return {
      type: RECIPIENT_TYPES[p.get(PR.recipientType)] ?? 'to',
      name: p.get(PR.displayName) ?? '',
      address: p.get(PR.smtpAddress) || p.get(PR.emailAddress) || '',
    };
  });

  const attachments = childrenOf(node, '__attach_version1.0_#').map((child, index) => {
    const p = propertiesOf(child.streams, 8, codepage);
    let name = p.get(PR.attachLongName) || p.get(PR.attachShortName) || p.get(PR.displayName) || `attachment-${index + 1}`;
    let content = new Uint8Array();
    const embedded = child.storages.get('__substg1.0_3701000D');
    if (embedded) {
      try {
        content = messageFile(embedded, nameid);
      } catch {
        // An unreadable attachment still lists, empty.
      }
      if (!/\.msg$/i.test(name)) name = `${name}.msg`;
    } else {
      const data = p.get(PR.attachData);
      if (Buffer.isBuffer(data)) content = new Uint8Array(data);
    }
    return {
      index,
      name: String(name),
      mime: p.get(PR.attachMime) || 'application/octet-stream',
      size: content.length,
      contentId: p.get(PR.attachContentId) ?? null,
      inline: p.get(PR.attachHidden) === true,
      content,
    };
  });

  const date = props.get(PR.deliveryTime) ?? props.get(PR.submitTime) ?? null;
  return {
    subject: text(PR.subject) ?? '',
    sender: { name: text(PR.senderName) ?? '', address: text(PR.senderSmtp) || text(PR.senderEmail) || '' },
    recipients,
    date: date ? date.toISOString() : null,
    html: typeof html === 'string' ? html : null,
    rtf: Buffer.isBuffer(rtf) ? rtf : null,
    body: text(PR.body) ?? null,
    attachments,
  };
}

/** An Outlook .msg file's message. */
function readMsgFile(bytes) {
  const cfb = CFB.read(Buffer.from(bytes), { type: 'buffer' });
  const root = treeOf(cfb);
  return readMessage(root, 32, root.storages.get('__nameid_version1.0') ?? null);
}

export { decompressRtf, readMsgFile };
