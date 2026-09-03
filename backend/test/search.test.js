// Free-text per-artifact search over the shared compare/search loader.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SearchService } from '../services/search.js';
import { asUpload, makeBundle } from './helpers/bundle.js';
import { makeRdb } from './helpers/makeRdb.js';

test('search scopes to one artifact and reports object + location per match', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-search-'));
  try {
    const { files, load } = await makeBundle(tmp);
    await files.upload('', [asUpload('unit.rdb', makeRdb([
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
    ]))], 'initial');
    const search = new SearchService({ load });
    const ref = 'unit.rdb::FEEDER_1';

    // Value match — only the scoped profile hits, not the sibling FEEDER_2.
    const byValue = await search.search(ref, '10.0.0');
    assert.equal(byValue.totalMatches, 1);
    assert.equal(byValue.results.length, 1);
    assert.equal(byValue.results[0].path, 'P5');
    assert.deepEqual(byValue.results[0].matches[0], {
      where: 'setting', location: 'IPADDR', text: 'IPADDR = 10.0.0.5',
    });

    // Key match, case-insensitive.
    const byKey = await search.search(ref, 'subnetm');
    assert.equal(byKey.results.length, 1);
    assert.equal(byKey.results[0].matches[0].location, 'SUBNETM');

    await assert.rejects(() => search.search(ref, '   '), /search string is required/);
    await assert.rejects(() => search.search('x.nope', 'ip'), /not a settings artifact/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a page-row hit reports the whole row, once per row', async () => {
  const search = new SearchService({
    load: async () => ({
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
  });

  const result = await search.search('r', 'sel_451');
  assert.equal(result.totalMatches, 1);
  assert.deepEqual(result.results[0].matches, [{
    where: 'page',
    location: 'Tags · row 1',
    text: 'Destination = SEL_451.BR1 · Source = SEL_451.MV01',
  }]);
});
