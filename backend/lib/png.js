// PNG for RGBA bitmaps, on node:zlib. Writing is what the app needs (cropped
// drawing views); reading covers the same shape — 8-bit RGBA, not interlaced
// — which is enough to check what was written.

import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** `data` is width*height*4 bytes of RGBA, row by row. */
function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    // Filter byte 0 (none) leads each row.
    Buffer.from(data.buffer, data.byteOffset + row * rowBytes, rowBytes).copy(raw, row * (rowBytes + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** An 8-bit RGBA PNG back to { width, height, data }. */
function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('only 8-bit RGBA, non-interlaced PNG is read');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rowBytes = width * 4;
  const out = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (rowBytes + 1)];
    const src = row * (rowBytes + 1) + 1;
    const dst = row * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const a = i >= 4 ? out[dst + i - 4] : 0;
      const b = row > 0 ? out[dst + i - rowBytes] : 0;
      const c = i >= 4 && row > 0 ? out[dst + i - rowBytes - 4] : 0;
      const x = raw[src + i];
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      out[dst + i] = (x + predicted) & 0xff;
    }
  }
  return { width, height, data: out };
}

export { decodePng, encodePng };
