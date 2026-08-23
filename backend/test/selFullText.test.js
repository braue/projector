import assert from 'node:assert/strict';
import test from 'node:test';

import { toMatchQuery } from '../services/selFullText.js';

// Users type prose into a box that speaks FTS5's query syntax. Everything here
// is a shape that used to throw, or that people reasonably expect to work.
test('builds a prefix AND query from ordinary words', () => {
  assert.equal(toMatchQuery('arc flash'), '"arc"* AND "flash"*');
});

test('keeps double-quoted runs as phrases', () => {
  assert.equal(toMatchQuery('"trip coil" monitor'), '"trip coil" AND "monitor"*');
});

test('drops punctuation FTS5 would choke on rather than erroring', () => {
  assert.equal(toMatchQuery('reclose (87L)'), '"reclose"* AND "87L"*');
  assert.equal(toMatchQuery('what? *'), '"what"*');
});

test('bare boolean words are treated as terms, not operators', () => {
  // "a AND OR b" is a syntax error in FTS5; here it is just words.
  assert.equal(toMatchQuery('OR'), '"OR"*');
});

test('keeps model numbers and dotted versions intact', () => {
  assert.equal(toMatchQuery('SEL-751A'), '"SEL-751A"*');
  assert.equal(toMatchQuery('R118-V0'), '"R118-V0"*');
});

test('single characters and empty input yield no query', () => {
  assert.equal(toMatchQuery('a'), null);
  assert.equal(toMatchQuery('   '), null);
  assert.equal(toMatchQuery(''), null);
  assert.equal(toMatchQuery(null), null);
});
