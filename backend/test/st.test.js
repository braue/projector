import assert from 'node:assert/strict';
import test from 'node:test';

import { ST_START, tokenizeLine } from '../lib/st.js';

const kinds = (tokens) => tokens.map((token) => token.kind);

test("a '(*)' opener does not close on its own star", () => {
  const opened = tokenizeLine('(*)', ST_START);
  assert.equal(opened.state.inComment, true);
  assert.deepEqual(kinds(opened.tokens), ['com', 'com']);

  // The next line is still inside the comment…
  const inside = tokenizeLine('IF x THEN', opened.state);
  assert.deepEqual(kinds(inside.tokens), ['com']);

  // …and '(**)' is a complete empty comment.
  const empty = tokenizeLine('(**)', ST_START);
  assert.equal(empty.state.inComment, false);
});

test('strings survive comment markers and comments survive quotes', () => {
  const { tokens } = tokenizeLine("sUrl := 'http://x'; // note 'quoted'", ST_START);
  const str = tokens.find((token) => token.kind === 'str');
  assert.equal(str.text, "'http://x'");
  const com = tokens.find((token) => token.kind === 'com');
  assert.equal(com.text, "// note 'quoted'");
});

test('keywords, types, and typed literals classify', () => {
  const { tokens } = tokenizeLine('rTimer(IN := TRUE, PT := T#5S);', ST_START);
  assert.ok(tokens.some((token) => token.kind === 'kw' && token.text === 'TRUE'));
  assert.ok(tokens.some((token) => token.kind === 'num' && token.text === 'T#5S'));
});
