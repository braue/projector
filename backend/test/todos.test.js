// The machine-global todo list: a whole-list store that must survive a
// restart, since that is the whole reason it is not in localStorage.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TodosService } from '../services/todos.js';

const item = (id, text, done = false) => ({ id, text, done });

test('todos: replace round-trips, and the file is what survives a restart', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-todos-'));
  try {
    const file = path.join(tmp, 'todos.json');
    const todos = new TodosService({ file });

    // Nothing stored yet is an empty list, not an error.
    assert.deepEqual(await todos.list(), []);

    await todos.replace([item('a', 'Pull the Bay 3 export'), item('b', 'Order SFPs', true)]);
    assert.deepEqual(await todos.list(), [
      item('a', 'Pull the Bay 3 export'),
      item('b', 'Order SFPs', true),
    ]);

    // A second service over the same file sees it — the restart case.
    assert.deepEqual(await new TodosService({ file }).list(), [
      item('a', 'Pull the Bay 3 export'),
      item('b', 'Order SFPs', true),
    ]);

    // Order is the user's (they drag to reorder), so it is preserved as given.
    await todos.replace([item('b', 'Order SFPs', true), item('a', 'Pull the Bay 3 export')]);
    assert.deepEqual((await todos.list()).map((t) => t.id), ['b', 'a']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('todos: malformed rows are dropped, not trusted', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-todos-'));
  try {
    const file = path.join(tmp, 'todos.json');
    const todos = new TodosService({ file });

    const saved = await todos.replace([
      item('a', '  Trimmed  '),
      item('b', '   '),          // blank text — nothing to show
      { id: 'c' },               // no text at all
      { text: 'no id' },
      null,
      item('d', 'Kept', 'yes'),  // done coerces to a boolean
    ]);
    assert.deepEqual(saved, [item('a', 'Trimmed'), item('d', 'Kept', true)]);

    // A hand-edited file gets the same treatment on the way back out.
    await writeFile(file, JSON.stringify([item('e', 'Fine'), { id: 5, text: 'bad id' }]));
    assert.deepEqual(await todos.list(), [item('e', 'Fine')]);

    // A non-array body is a client error, and leaves the stored list alone.
    await assert.rejects(() => todos.replace({ nope: true }), /must be an array/);
    assert.deepEqual(await todos.list(), [item('e', 'Fine')]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('todos: concurrent replaces serialize instead of interleaving', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-todos-'));
  try {
    const file = path.join(tmp, 'todos.json');
    const todos = new TodosService({ file });

    await Promise.all([
      todos.replace([item('a', 'first')]),
      todos.replace([item('b', 'second')]),
      todos.replace([item('c', 'third')]),
    ]);

    // Whichever landed last, the file is one whole valid list — never a
    // half-written mix of two.
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(onDisk.length, 1);
    assert.ok(['a', 'b', 'c'].includes(onDisk[0].id));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
