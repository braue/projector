// Email edge cases: attachments that share a name, and bodies with broken
// cid: links.

import assert from 'node:assert/strict';
import test from 'node:test';

import { extract } from '../lib/extract/index.js';
import { innerParts, resolveInner, viewModel } from '../lib/extract/views.js';
import { makeEml } from './helpers/makeDocs.js';

test('mail: attachments with one name keep their own text', async () => {
  const eml = makeEml({
    subject: 'Fwd: notes',
    from: 'a@example.com',
    to: 'b@example.com',
    body: 'See attached.',
    attachments: [
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('first attachment') },
      { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('second attachment') },
    ],
  });
  const { parts } = await extract('m.eml', eml);
  const located = parts.filter((p) => /attachment/.test(p.text)).map((p) => [p.where, p.text]);
  assert.deepEqual(located, [['notes.txt', 'first attachment'], ['notes.txt (2)', 'second attachment']]);

  const model = await viewModel('m.eml', eml);
  assert.deepEqual(model.attachments.map((a) => [a.index, a.name, a.label]), [[0, 'notes.txt', 'notes.txt'], [1, 'notes.txt', 'notes.txt (2)']]);

  // Each attachment's own text, by index.
  for (const [index, text] of [[0, 'first attachment'], [1, 'second attachment']]) {
    const { labels } = await resolveInner('m.eml', eml, [index]);
    assert.deepEqual(innerParts(parts, labels).map((p) => p.text), [text]);
  }
});

test('mail: a malformed cid: link does not stop the message opening', async () => {
  const eml = makeEml({
    subject: 'Pic',
    from: 'a@example.com',
    to: 'b@example.com',
    body: '',
    html: '<p>Look <img src="cid:img%zz"></p>',
  });
  const model = await viewModel('m.eml', eml);
  assert.match(model.html, /cid:img%zz/);
});
