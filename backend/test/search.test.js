// Free-text search over the shared compare/search adapter.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RdbService } from '../services/rdb.js';
import { SearchService } from '../services/search.js';
import { makeRdb } from './helpers/makeRdb.js';

test('search sweeps every source and reports object + location per match', async () => {
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
    const search = new SearchService({
      adapters: { rdb: (ref) => rdb.comparable(ref) },
      sources: async () =>
        rdb.list().flatMap((file) => file.profiles.map((profile) => ({ type: 'rdb', ref: profile.ref }))),
    });

    // Project-wide: both profiles hit, each grouped under its own source.
    const byValue = await search.search('10.0.0');
    assert.equal(byValue.totalMatches, 2);
    assert.deepEqual(byValue.sources.map((s) => s.ref), ['unit::FEEDER_1', 'unit::FEEDER_2']);
    assert.deepEqual(byValue.sources[0].results[0].matches[0], {
      where: 'setting', location: 'IPADDR', text: 'IPADDR = 10.0.0.5',
    });

    // Key match, case-insensitive.
    const byKey = await search.search('subnetm');
    assert.equal(byKey.sources.length, 1);
    assert.equal(byKey.sources[0].results[0].matches[0].location, 'SUBNETM');

    await assert.rejects(() => search.search('   '), /search string is required/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
