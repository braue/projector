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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-search-'));
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

test('a page-row hit reports the whole row, once per row', async () => {
  const search = new SearchService({
    adapters: {
      fake: async () => ({
        label: 'fake',
        entries: [{
          path: 'tp',
          name: 'Tag Processor',
          item: {
            kindLabel: 'Tag Processor',
            category: 'system',
            pages: [{
              name: 'Tags',
              columns: ['Destination', 'Source', 'Quality'],
              rows: [
                // Two matching cells in one row must still be ONE hit.
                { Destination: 'SEL_451.BR1', Source: 'SEL_451.MV01', Quality: '' },
                { Destination: 'DNP.AI02', Source: 'SEL_735.MV02', Quality: 'True' },
              ],
            }],
          },
        }],
      }),
    },
  });

  const result = await search.search({ type: 'fake', ref: 'r' }, 'sel_451');
  assert.equal(result.totalMatches, 1);
  assert.deepEqual(result.results[0].matches, [{
    where: 'page',
    location: 'Tags · row 1',
    text: 'Destination = SEL_451.BR1 · Source = SEL_451.MV01',
  }]);
});
