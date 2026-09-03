// QuickSet database dump — stage 1 of the old QUICKSETDUMP pipeline
// (postgre.py), ported. Pulls each device's latest settings ZIP out of the
// QuickSet PostgreSQL database and explodes the relay folders into
// <configs>/<location>/<device>/… — the tree the parsers read.
//
// Connection details arrive from the UI per run and live only in memory for
// the duration of the job; nothing is persisted. (The old script hardcoded
// production credentials in source — that does not carry over.)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The same join the old script ran: latest work-copy settings content per
// device, with the parent node's location name. The content blobs (a whole
// settings ZIP each) are deliberately NOT part of this listing — pulling the
// whole fleet's ZIPs in one result set grows the heap with the database, so
// each device's blob is fetched on its own turn of the loop below.
const LIST_QUERY = `
  SELECT
      wc.device_id,
      loc.location_name,
      sc.settings_content_id
  FROM public.settings_content sc
  JOIN public.device_settings_work_copy wc
      ON sc.settings_content_id = wc.settings_content_id
  JOIN connection_node_data d
      ON wc.device_id = d.device_id
  JOIN connection_node_data l
      ON d.parent_node_id = l.connection_node_id
  JOIN location loc
      ON l.location_id = loc.location_id
  WHERE sc.content IS NOT NULL
`;

const CONTENT_QUERY =
  'SELECT content FROM public.settings_content WHERE settings_content_id = $1';

const safeName = (name) => String(name).replaceAll(' ', '_').replaceAll('/', '_');

/**
 * Run the dump into `configsDir`. `handle` is the job handle ({ log,
 * progress }); returns tallies for the job result.
 */
async function dumpQuicksetDatabase({ host, port, dbname, user, password }, configsDir, handle) {
  const [{ default: pg }, { unzipSync }] = await Promise.all([import('pg'), import('fflate')]);
  const client = new pg.Client({
    host: String(host ?? 'localhost'),
    port: Number(port ?? 5432),
    database: String(dbname ?? ''),
    user: String(user ?? ''),
    password: String(password ?? ''),
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  let devices = 0;
  let failures = 0;
  const locations = new Set();
  try {
    const { rows } = await client.query(LIST_QUERY);
    handle.log(`${rows.length} device configs to process`);
    for (const [index, row] of rows.entries()) {
      const location = safeName(row.location_name);
      try {
        const content = (await client.query(CONTENT_QUERY, [row.settings_content_id]))
          .rows[0]?.content;
        if (!content) throw new Error('settings content vanished mid-dump');
        // The ZIP holds <top>/Relays/<device>/…; the relay folders land
        // directly under the location (overwriting duplicates, as before).
        const entries = unzipSync(new Uint8Array(content));
        let extracted = 0;
        for (const [entryPath, bytes] of Object.entries(entries)) {
          const match = entryPath.match(/^[^/]+\/Relays\/(.+)$/);
          if (!match || entryPath.endsWith('/')) continue;
          const target = path.join(configsDir, location, ...match[1].split('/'));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, bytes);
          extracted += 1;
        }
        if (extracted === 0) {
          handle.log(`[${row.location_name}] device ${row.device_id}: no Relays folder in export`);
        } else {
          devices += 1;
          locations.add(location);
        }
      } catch (err) {
        failures += 1;
        handle.log(`[${row.location_name}] device ${row.device_id}: ${err?.message ?? err}`);
      }
      handle.progress((index + 1) / rows.length);
    }
  } finally {
    await client.end().catch(() => {});
  }
  return { devices, locations: locations.size, failures };
}

export { dumpQuicksetDatabase };
