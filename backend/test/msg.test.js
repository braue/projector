// Outlook .msg reading: a message built property by property, so sender,
// recipients, an HTML body, 8-bit strings and inline attachments are all
// exercised (the corpus fixture in contentIndex.test.js covers RTF bodies and
// attached messages).

import assert from 'node:assert/strict';
import test from 'node:test';

import CFB from 'cfb';

import { decompressRtf, readMsgFile } from '../lib/extract/msg.js';

const stream = (id, type) => `__substg1.0_${id.toString(16).toUpperCase().padStart(4, '0')}${type.toString(16).toUpperCase().padStart(4, '0')}`;
const unicode = (s) => Buffer.from(`${s}\0`, 'utf16le');

/** A property table: header bytes, then 16-byte fixed entries. */
function table(headerSize, entries) {
  const out = Buffer.alloc(headerSize + 16 * entries.length);
  entries.forEach(([id, type, write], i) => {
    const at = headerSize + 16 * i;
    out.writeUInt16LE(type, at);
    out.writeUInt16LE(id, at + 2);
    write(out, at + 8);
  });
  return out;
}

function makeMsg() {
  const cfb = CFB.utils.cfb_new();
  const add = (name, content) => CFB.utils.cfb_add(cfb, `/${name}`, content);
  const when = BigInt(Date.UTC(2026, 10, 2, 15, 30)) * 10000n + 116444736000000000n;
  add('__properties_version1.0', table(32, [
    [0x0e06, 0x0040, (b, at) => b.writeBigUInt64LE(when, at)],
    [0x3ffd, 0x0003, (b, at) => b.writeInt32LE(1252, at)],
  ]));
  add(stream(0x0037, 0x001f), unicode('Relay Ω settings'));
  add(stream(0x0c1a, 0x001e), Buffer.from('Jos\xe9\0', 'latin1'));
  add(stream(0x5d01, 0x001f), unicode('jose@example.com'));
  add(stream(0x1000, 0x001f), unicode('Plain body'));
  add(stream(0x1013, 0x0102), Buffer.from('<p>Hé <img src="cid:pic@1"></p>'));
  add(stream(0x3fde, 0x0003), Buffer.alloc(0)); // ignored: fixed values live in the table
  const recip = (n, type, name, smtp) => {
    const dir = `__recip_version1.0_#0000000${n}`;
    add(`${dir}/__properties_version1.0`, table(8, [[0x0c15, 0x0003, (b, at) => b.writeInt32LE(type, at)]]));
    add(`${dir}/${stream(0x3001, 0x001f)}`, unicode(name));
    add(`${dir}/${stream(0x39fe, 0x001f)}`, unicode(smtp));
  };
  recip(0, 1, 'Ann', 'ann@example.com');
  recip(1, 2, 'Bob', 'bob@example.com');
  const att = '__attach_version1.0_#00000000';
  add(`${att}/__properties_version1.0`, table(8, [[0x7ffe, 0x000b, (b, at) => { b[at] = 1; }]]));
  add(`${att}/${stream(0x3707, 0x001f)}`, unicode('pic.png'));
  add(`${att}/${stream(0x370e, 0x001f)}`, unicode('image/png'));
  add(`${att}/${stream(0x3712, 0x001f)}`, unicode('pic@1'));
  add(`${att}/${stream(0x3701, 0x0102)}`, Buffer.from([1, 2, 3, 4]));
  return CFB.write(cfb, { type: 'buffer', fileType: 'cfb' });
}

test('msg: sender, recipients, HTML body, 8-bit strings and inline attachments', () => {
  const msg = readMsgFile(makeMsg());
  assert.equal(msg.subject, 'Relay Ω settings');
  assert.deepEqual(msg.sender, { name: 'José', address: 'jose@example.com' });
  assert.deepEqual(msg.recipients, [
    { type: 'to', name: 'Ann', address: 'ann@example.com' },
    { type: 'cc', name: 'Bob', address: 'bob@example.com' },
  ]);
  assert.equal(msg.date, '2026-11-02T15:30:00.000Z');
  assert.equal(msg.html, '<p>Hé <img src="cid:pic@1"></p>');
  assert.equal(msg.body, 'Plain body');
  assert.equal(msg.attachments.length, 1);
  const [pic] = msg.attachments;
  assert.deepEqual({ ...pic, content: [...pic.content] }, {
    index: 0, name: 'pic.png', mime: 'image/png', size: 4, contentId: 'pic@1', inline: true, content: [1, 2, 3, 4],
  });
});

test('msg: compressed RTF — literals, dictionary references and stored bodies', () => {
  // "{\rtf1" is at offset 0 of the preset dictionary: one reference of 6
  // bytes, then literals, then the end marker at the write position.
  const literals = Buffer.from(' hi}', 'latin1');
  const write = 207 + 6 + literals.length;
  const payload = Buffer.concat([
    Buffer.from([0b00100001]), // bit 0: reference; bits 1–4: literals; bit 5: end
    Buffer.from([(0 << 4) >> 8, (0 << 4) | (6 - 2)]),
    literals,
    Buffer.from([(write << 4) >> 8, (write << 4) & 0xff]),
  ]);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(payload.length + 12, 0);
  header.writeUInt32LE(10, 4);
  header.writeUInt32LE(0x75465a4c, 8);
  assert.equal(decompressRtf(Buffer.concat([header, payload])).toString('latin1'), '{\\rtf1 hi}');

  const stored = Buffer.alloc(16);
  stored.writeUInt32LE(12 + 5, 0);
  stored.writeUInt32LE(5, 4);
  stored.writeUInt32LE(0x414c454d, 8);
  assert.equal(decompressRtf(Buffer.concat([stored, Buffer.from('{\\rtf')])).toString('latin1'), '{\\rtf');
});
