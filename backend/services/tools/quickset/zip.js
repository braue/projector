// Just enough ZIP to read a QuickSet database backup without unpacking it.
//
// A backup is one big ZIP (often tens of GB, Zip64) of pg_dump files, each
// entry WinZip-AES encrypted. Only DMData.dump matters, so the reader works
// from the central directory at the end of the file, then streams that one
// entry's bytes once: decrypt (AES-CTR, verified by its HMAC) and inflate on
// the fly, nothing written to disk. Bytes arrive through `readAt` for the
// directory and as a stream for the entry, so the same code serves a file on
// disk and a slice the browser posts.

import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

import { httpError } from '../../../lib/http.js';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const AES_EXTRA = 0x9901;
const ZIP64_EXTRA = 0x0001;

/** How far from the end the directory search reads first: the EOCD comment
 *  is at most 64 KiB, and the Zip64 records sit just before it. */
const TAIL_BYTES = 128 * 1024;

/** Thrown when `readAt` is asked for bytes the caller does not hold (the
 *  browser path sends the tail first and supplies more on request). */
class NeedBytes extends Error {
  constructor(start, end) {
    super(`need bytes ${start}-${end}`);
    this.range = { start, end };
  }
}

const u64 = (buf, at) => Number(buf.readBigUInt64LE(at));

/** The central directory of a ZIP of `size` bytes: [{ name, method, flags,
 *  compressedSize, size, localOffset, aes }]. `aes` is { strength, method }
 *  for WinZip-AES entries. */
async function readDirectory(readAt, size) {
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = await readAt(tailStart, size - tailStart);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw httpError(400, 'not a ZIP file (no end-of-directory record)');
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_LOCATOR) {
    const recordOffset = u64(tail, at - 20 + 8);
    const record = await readAt(recordOffset, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw httpError(400, 'damaged Zip64 directory');
    count = u64(record, 32);
    cdSize = u64(record, 40);
    cdOffset = u64(record, 48);
  }
  const cd = await readAt(cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n += 1) {
    if (cd.readUInt32LE(p) !== CENTRAL) throw httpError(400, 'damaged ZIP directory');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let entrySize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    let aes = null;
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      const body = e + 4;
      if (id === ZIP64_EXTRA) {
        // Only the fields that overflowed are present, in this order.
        let q = body;
        if (entrySize === 0xffffffff) { entrySize = u64(cd, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
      } else if (id === AES_EXTRA && len >= 7) {
        aes = { strength: cd.readUInt8(body + 4), method: cd.readUInt16LE(body + 5) };
      }
      e = body + len;
    }
    entries.push({ name, method, flags, compressedSize, size: entrySize, localOffset, aes });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** The byte range that holds an entry: local header, name, extra, data. The
 *  local extra's length is only known from the local header, so the range
 *  allows the largest one; the reader stops at the data's end. */
function entryRange(entry, fileSize) {
  const start = entry.localOffset;
  return { start, end: Math.min(fileSize, start + 30 + 0xffff + 0xffff + entry.compressedSize) };
}

const KEY_BYTES = { 1: 16, 2: 24, 3: 32 };

/**
 * Stream an entry's raw bytes (starting at its local header) into its
 * decrypted, decompressed content. `password` is needed for encrypted
 * entries. Rejects early on a wrong password (the 2-byte verifier) and at
 * the end on a failed authentication code.
 */
function entryContent(entry, password) {
  const encrypted = Boolean(entry.flags & 1);
  if (encrypted && !entry.aes) throw httpError(400, `${entry.name}: only WinZip AES encryption is supported`);
  const method = entry.aes ? entry.aes.method : entry.method;
  if (method !== 0 && method !== 8) throw httpError(400, `${entry.name}: unsupported compression method ${method}`);

  const keyLen = entry.aes ? KEY_BYTES[entry.aes.strength] : 0;
  if (entry.aes && !keyLen) throw httpError(400, `${entry.name}: unknown AES strength`);
  const saltLen = keyLen / 2;
  const dataLen = entry.compressedSize - (entry.aes ? saltLen + 2 + 10 : 0);

  let header = Buffer.alloc(0);
  let headerDone = false;
  let prefix = Buffer.alloc(0); // salt + verifier, before the cipher is ready
  let cipher = null;
  let hmac = null;
  let counter = 1;
  let keystream = Buffer.alloc(0);
  let consumed = 0; // data bytes passed through
  let trailer = Buffer.alloc(0);

  const nextKeystream = (needed) => {
    const blocks = Math.ceil(needed / 16) + 4096;
    const counters = Buffer.alloc(blocks * 16);
    for (let i = 0; i < blocks; i += 1) {
      // 128-bit little-endian block counter, starting at 1.
      counters.writeUInt32LE(counter % 0x100000000, i * 16);
      counters.writeUInt32LE(Math.floor(counter / 0x100000000), i * 16 + 4);
      counter += 1;
    }
    keystream = Buffer.concat([keystream, cipher.update(counters)]);
  };

  const decrypt = new Transform({
    transform(chunk, _enc, done) {
      try {
        let buf = chunk;
        if (!headerDone) {
          header = Buffer.concat([header, buf]);
          if (header.length < 30) return done();
          if (header.readUInt32LE(0) !== LOCAL) throw httpError(400, `${entry.name}: bad local header`);
          const skip = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
          if (header.length < skip) return done();
          headerDone = true;
          buf = header.subarray(skip);
          header = null;
        }
        if (entry.aes && !cipher) {
          prefix = Buffer.concat([prefix, buf]);
          if (prefix.length < saltLen + 2) return done();
          const salt = prefix.subarray(0, saltLen);
          const derived = pbkdf2Sync(Buffer.from(password ?? '', 'utf8'), salt, 1000, keyLen * 2 + 2, 'sha1');
          if (!timingSafeEqual(derived.subarray(keyLen * 2), prefix.subarray(saltLen, saltLen + 2))) {
            throw httpError(400, 'wrong backup password');
          }
          cipher = createCipheriv(`aes-${keyLen * 8}-ecb`, derived.subarray(0, keyLen), null).setAutoPadding(false);
          hmac = createHmac('sha1', derived.subarray(keyLen, keyLen * 2));
          buf = prefix.subarray(saltLen + 2);
          prefix = null;
        }
        // Data, then (AES) the 10-byte authentication code; anything after
        // that belongs to the next entry and is ignored.
        const take = Math.min(buf.length, Math.max(0, dataLen - consumed));
        const data = buf.subarray(0, take);
        if (entry.aes && trailer.length < 10) {
          trailer = Buffer.concat([trailer, buf.subarray(take, take + 10 - trailer.length)]);
        }
        consumed += take;
        if (!data.length) return done();
        if (!entry.aes) return done(null, data);
        hmac.update(data);
        if (keystream.length < data.length) nextKeystream(data.length - keystream.length);
        const out = Buffer.allocUnsafe(data.length);
        for (let i = 0; i < data.length; i += 1) out[i] = data[i] ^ keystream[i];
        keystream = keystream.subarray(data.length);
        done(null, out);
      } catch (err) {
        done(err);
      }
    },
    flush(done) {
      if (consumed < dataLen) return done(httpError(400, `${entry.name}: the file ended early`));
      if (entry.aes) {
        const code = hmac.digest().subarray(0, 10);
        if (trailer.length < 10 || !timingSafeEqual(code, trailer)) {
          return done(httpError(400, `${entry.name}: authentication failed (damaged file)`));
        }
      }
      done();
    },
  });

  if (method === 0) return { input: decrypt, output: decrypt };
  const inflate = createInflateRaw();
  decrypt.on('error', (err) => inflate.destroy(err));
  decrypt.pipe(inflate);
  return { input: decrypt, output: inflate };
}

export { NeedBytes, TAIL_BYTES, readDirectory, entryRange, entryContent };
