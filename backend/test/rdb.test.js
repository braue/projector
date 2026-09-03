// RDB pipeline: a synthetic-but-real CFB database round-trips through the
// parser.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRdb } from '../lib/parsers/rdb/index.js';
import { makeRdb } from './helpers/makeRdb.js';

const DEMO_PROFILES = [
  {
    name: 'FEEDER_1',
    relayType: 'SEL-751A',
    partNo: '751A51ABA0X71850230',
    sections: [
      {
        key: 'P5', desc: 'Port 5',
        settings: { IPADDR: '123.123.123.123', SUBNETM: '255.255.255.0' },
      },
      { key: 'D1', desc: 'DNP', settings: { DNPADR: '2', DNPTPRT: '20000' } },
      { key: 'P3', desc: 'Port 3', settings: { SPEED: '19200', PROTO: 'SEL', BITS: '8', PARITY: 'N', STOPBIT: '1' } },
      { key: 'G', desc: 'Global', settings: { TID: 'FEEDER RELAY 1' } },
    ],
  },
];

test('parseRdb round-trips a CFB database', () => {
  const { profiles } = parseRdb(makeRdb(DEMO_PROFILES));
  assert.equal(profiles.length, 1);
  const [profile] = profiles;
  assert.equal(profile.name, 'FEEDER_1');
  assert.equal(profile.info.RELAYTYPE, 'SEL-751A');
  assert.equal(profile.sections.length, 4);
  const p5 = profile.sections.find((s) => s.key === 'P5');
  assert.equal(p5.desc, 'Port 5');
  assert.equal(p5.settings.IPADDR, '123.123.123.123');
});
