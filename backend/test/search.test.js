// Free-text per-source search over the shared compare/search adapter.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RdbService } from '../services/rdb.js';
import { SearchService } from '../services/search.js';
import { makeRdb } from './helpers/makeRdb.js';

test('search scopes to one source and reports object + location per match', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-search-'));
  try {
    const rdb = new RdbService({ dataDir: tmp });
    await rdb.init();
    await rdb.upload('unit.rdb', makeRdb([
      {
        name: 'FEEDER_1',
        relayType: 'SEL-451',
        sections: [
          { key: 'P5', desc: 'Port 5', settings: { IPADDR: '10.0.0.5', SUBNETM: '255.255.255.0' } },
          { key: 'G', desc: 'Global', settings: { TID: 'FEEDER ONE', SID: 'STATION 12' } },
        ],
      },
      {
        name: 'FEEDER_2',
        relayType: 'SEL-451',
        sections: [
          { key: 'P5', desc: 'Port 5', settings: { IPADDR: '10.0.0.9' } },
        ],
      },
    ]));
    const search = new SearchService({ adapters: { rdb: (ref) => rdb.comparable(ref) } });
    const source = { type: 'rdb', ref: 'unit::FEEDER_1' };

    // Value match — only the scoped profile hits, not the sibling FEEDER_2.
    const byValue = await search.search(source, '10.0.0');
    assert.equal(byValue.totalMatches, 1);
    assert.equal(byValue.results.length, 1);
    assert.equal(byValue.results[0].path, 'P5');
    assert.deepEqual(byValue.results[0].matches[0], {
      where: 'setting', location: 'IPADDR', text: 'IPADDR = 10.0.0.5',
    });

    // Key match, case-insensitive.
    const byKey = await search.search(source, 'subnetm');
    assert.equal(byKey.results.length, 1);
    assert.equal(byKey.results[0].matches[0].location, 'SUBNETM');

    await assert.rejects(() => search.search(source, '   '), /search string is required/);
    await assert.rejects(() => search.search({ type: 'nope', ref: 'x' }, 'ip'), /unknown source type/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
