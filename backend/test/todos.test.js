// The machine-global todo board: per-card writes over one ordered array that
// must survive a restart, since that is the whole reason it is not in
// localStorage.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TodosService } from '../services/todos.js';

async function withBoard(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-todos-'));
  try {
    const file = path.join(tmp, 'todos.json');
    await fn(file, new TodosService({ file }));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const column = (cards, status) => cards.filter((c) => c.status === status).map((c) => c.title);

test('todos: create fills defaults, and the file is what survives a restart', async () => {
  await withBoard(async (file, todos) => {
    // Nothing stored yet is an empty board, not an error.
    assert.deepEqual(await todos.list(), []);

    const [a] = await todos.create({ title: '  Pull the Bay 3 export ' });
    assert.equal(typeof a.id, 'string');
    assert.deepEqual({ ...a, id: undefined }, {
      id: undefined, title: 'Pull the Bay 3 export', description: '', project: null, hours: null, spent: null, status: 'todo',
    });

    const cards = await todos.create({
      title: 'Order SFPs', description: 'Two LX\n', project: 'Naheola', hours: '1.5', spent: 0.5, status: 'doing',
    });
    assert.deepEqual(cards[1], {
      id: cards[1].id, title: 'Order SFPs', description: 'Two LX', project: 'Naheola', hours: 1.5, spent: 0.5,
      status: 'doing',
    });

    // A second service over the same file sees it — the restart case.
    assert.deepEqual(await new TodosService({ file }).list(), cards);

    await assert.rejects(() => todos.create({ title: '   ' }), /title required/);
    await assert.rejects(() => todos.create({ title: 'x', status: 'later' }), /invalid status/);
    await assert.rejects(() => todos.create({ title: 'x', hours: -1 }), /invalid hours/);
    await assert.rejects(() => todos.create({ title: 'x', spent: 'lots' }), /invalid hours/);
    assert.equal((await todos.list()).length, 2);
  });
});

test('todos: update patches only the named fields', async () => {
  await withBoard(async (_file, todos) => {
    const [card] = await todos.create({ title: 'Write SAT', project: 'Bunkie', hours: 4 });
    let [next] = await todos.update(card.id, { description: 'Rev 1', hours: '', id: 'hijack', extra: 1 });
    assert.deepEqual(next, { ...card, description: 'Rev 1', hours: null });

    [next] = await todos.update(card.id, { spent: 2.25 });
    assert.equal(next.spent, 2.25);
    [next] = await todos.update(card.id, { spent: 0 });
    assert.equal(next.spent, null);

    [next] = await todos.update(card.id, { project: '' });
    assert.equal(next.project, null);

    await assert.rejects(() => todos.update(card.id, { title: '' }), /title required/);
    await assert.rejects(() => todos.update('nope', { title: 'x' }), /no such card/);
  });
});

test('todos: move places a card above another, or at the bottom of a column', async () => {
  await withBoard(async (_file, todos) => {
    for (const title of ['a', 'b', 'c']) await todos.create({ title });
    const id = async (title) => (await todos.list()).find((c) => c.title === title).id;

    // Within a column: c above a.
    let cards = await todos.move(await id('c'), 'todo', await id('a'));
    assert.deepEqual(column(cards, 'todo'), ['c', 'a', 'b']);

    // Across: a into an empty Doing, then b to the bottom of Doing.
    await todos.move(await id('a'), 'doing');
    cards = await todos.move(await id('b'), 'doing', null);
    assert.deepEqual(column(cards, 'todo'), ['c']);
    assert.deepEqual(column(cards, 'doing'), ['a', 'b']);

    // A `before` that is not in the target column means the bottom of it.
    cards = await todos.move(await id('b'), 'done', await id('a'));
    assert.deepEqual(column(cards, 'done'), ['b']);

    // Dropped on itself: nothing changes.
    const before = await todos.list();
    assert.deepEqual(await todos.move(await id('c'), 'todo', await id('c')), before);

    await assert.rejects(async () => todos.move(await id('c'), 'nowhere'), /invalid status/);
  });
});

test('todos: remove, clear done, and a project rename re-keys cards', async () => {
  await withBoard(async (_file, todos) => {
    await todos.create({ title: 'a', project: 'Old', status: 'done' });
    await todos.create({ title: 'b', project: 'Old' });
    await todos.create({ title: 'c', project: 'Other', status: 'done' });

    let cards = await todos.renameProject('Old', 'New');
    assert.deepEqual(cards.map((c) => c.project), ['New', 'New', 'Other']);

    cards = await todos.clearDone();
    assert.deepEqual(cards.map((c) => c.title), ['b']);

    cards = await todos.remove(cards[0].id);
    assert.deepEqual(cards, []);
  });
});

test('todos: the old checklist rows read as cards; malformed rows are dropped', async () => {
  await withBoard(async (file, todos) => {
    await writeFile(file, JSON.stringify([
      { id: 'a', text: 'Open item', done: false },
      { id: 'b', text: 'Ticked', done: true },
      { id: 'c', text: '   ' },
      { id: 5, text: 'bad id' },
      null,
      { id: 'd', title: 'Card', status: 'doing', hours: 'lots', project: '  ' },
    ]));
    assert.deepEqual(await todos.list(), [
      { id: 'a', title: 'Open item', description: '', project: null, hours: null, spent: null, status: 'todo' },
      { id: 'b', title: 'Ticked', description: '', project: null, hours: null, spent: null, status: 'done' },
      { id: 'd', title: 'Card', description: '', project: null, hours: null, spent: null, status: 'doing' },
    ]);
  });
});

test('todos: concurrent writes serialize instead of dropping each other', async () => {
  await withBoard(async (file, todos) => {
    await Promise.all(['a', 'b', 'c'].map((title) => todos.create({ title })));
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(onDisk.map((c) => c.title).sort(), ['a', 'b', 'c']);
  });
});

test('todos: a change publishes `todos`, a no-op does not', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-todos-'));
  try {
    const published = [];
    const todos = new TodosService({
      file: path.join(tmp, 'todos.json'),
      events: { publish: (type) => published.push(type) },
    });
    await todos.create({ title: 'a' });
    await todos.clearDone();
    await todos.renameProject('x', 'y');
    assert.deepEqual(published, ['todos']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
