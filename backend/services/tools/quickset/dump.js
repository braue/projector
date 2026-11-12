// DMData.dump reader. The QuickSet backup's data file is a plain-SQL
// pg_dump: one `COPY <table> (<cols>) FROM stdin;` block per table, a row
// per line in COPY text format, `\.` to end it. This reads it as a stream,
// keeps the handful of tables the tool needs, and skips the rest without
// parsing them — a big backup carries GBs of load-profile and retrieval
// history that would only crowd the heap.
//
// settings_content holds every settings revision as a hex bytea ZIP; each
// blob is written to `blobDir/<id>.zip` as it passes, and its row keeps the
// rest of the columns.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEEP = new Set([
  'public.device', 'public.device_type', 'public.device_type_class',
  'public.connection', 'public.communication_channel', 'public.communication_type',
  'public.protocol', 'public.serial_interface_type', 'public.credential_source_type',
  'public.location', 'public.location_type', 'public.connection_node_data',
  'public.device_option', 'public.device_rtac_option',
  'public.device_attribute', 'public.device_attribute_type',
  'public.device_config_revision', 'public.config_revision_type',
  'public.device_settings_work_copy', 'public.settings_content',
  'public.titled_password',
]);
// Never kept, even where a kept table carries them.
const SECRET_COLUMNS = new Set(['password', 'credential_content', 'ftp_password_id', 'blueframe_password_id']);

const NL = 0x0a;
const END_MARK = Buffer.from('\n\\.\n');
const COPY_RE = /^COPY (\S+) \((.*)\) FROM stdin;$/;

const ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };

/** One COPY text field -> string, or null for \N. */
function unescapeField(raw) {
  if (raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, s) => {
    if (s[0] === 'x' && s.length > 1) return String.fromCharCode(parseInt(s.slice(1), 16));
    if (s[0] >= '0' && s[0] <= '7') return String.fromCharCode(parseInt(s, 8) & 0xff);
    return ESCAPES[s] ?? s;
  });
}

/**
 * Parse a dump stream. `chunks` is an async iterable of Buffers. Returns
 * { tables: { name: { columns, rows } }, blobs } — rows as objects, `blobs`
 * the settings_content ids written. `onBytes(n)` reports progress.
 */
async function parseDump(chunks, { blobDir, onBytes = () => {}, signal = null }) {
  const tables = {};
  const blobs = new Set();
  let pending = []; // chunks of the line in progress
  let pendingLen = 0;
  let table = null; // { name, columns, rows, contentIdx } while inside a kept COPY
  let skipping = false; // inside a COPY block we do not keep
  let skipTail = Buffer.alloc(0);
  const writes = [];

  const handleLine = (line) => {
    if (table) {
      if (line.length === 2 && line[0] === 0x5c && line[1] === 0x2e) { // "\."
        tables[table.name] = { columns: table.columns, rows: table.rows };
        table = null;
        return;
      }
      const fields = [];
      let start = 0;
      for (let i = 0; i <= line.length; i += 1) {
        if (i === line.length || line[i] === 0x09) {
          fields.push(line.subarray(start, i));
          start = i + 1;
        }
      }
      const row = {};
      table.columns.forEach((col, i) => {
        const raw = fields[i];
        if (raw === undefined || SECRET_COLUMNS.has(col)) {
          row[col] = null;
        } else if (i === table.contentIdx) {
          // Hex bytea, its backslash doubled by COPY: \\x504b...
          if (raw.length > 3 && raw[0] === 0x5c && raw[1] === 0x5c && raw[2] === 0x78) {
            const id = unescapeField(fields[0].toString('utf8'));
            const bytes = Buffer.from(raw.subarray(3).toString('latin1'), 'hex');
            writes.push(writeFile(path.join(blobDir, `${id}.zip`), bytes));
            blobs.add(id);
          }
          row[col] = null;
        } else {
          row[col] = unescapeField(raw.toString('utf8'));
        }
      });
      table.rows.push(row);
      return;
    }
    const text = line.toString('utf8');
    if (!text.startsWith('COPY ')) return;
    const m = COPY_RE.exec(text);
    if (!m) return;
    const name = m[1];
    const columns = m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (KEEP.has(name)) {
      table = { name, columns, rows: [], contentIdx: name === 'public.settings_content' ? columns.indexOf('content') : -1 };
    } else {
      skipping = true;
      skipTail = Buffer.from([NL]);
    }
  };

  for await (const chunk of chunks) {
    if (signal?.aborted) throw new Error('Aborted');
    onBytes(chunk.length);
    let buf = chunk;
    while (buf.length) {
      if (skipping) {
        // Find "\n\.\n" without splitting lines, across chunk seams.
        const joined = skipTail.length ? Buffer.concat([skipTail, buf]) : buf;
        const at = joined.indexOf(END_MARK);
        if (at < 0) {
          skipTail = joined.subarray(Math.max(0, joined.length - (END_MARK.length - 1)));
          buf = Buffer.alloc(0);
          break;
        }
        const after = at + END_MARK.length - skipTail.length;
        skipping = false;
        skipTail = Buffer.alloc(0);
        buf = buf.subarray(after);
        continue;
      }
      const nl = buf.indexOf(NL);
      if (nl < 0) {
        pending.push(buf);
        pendingLen += buf.length;
        break;
      }
      let line = buf.subarray(0, nl);
      if (pendingLen) {
        line = Buffer.concat([...pending, line], pendingLen + line.length);
        pending = [];
        pendingLen = 0;
      }
      buf = buf.subarray(nl + 1);
      handleLine(line);
      if (writes.length > 64) await Promise.all(writes.splice(0));
    }
  }
  if (pendingLen) handleLine(Buffer.concat(pending, pendingLen));
  await Promise.all(writes);
  if (!tables['public.device']) throw new Error('no device table in the dump — is this a QuickSet DMData.dump?');
  return { tables, blobs };
}

export { parseDump, unescapeField };
