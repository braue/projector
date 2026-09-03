// Project files store: real directory tree, plain fs operations, the guards
// that keep everything inside it — and versions: a same-name upload stacks
// with its mandatory note instead of unique-ifying or overwriting.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';
import { asUpload } from './helpers/bundle.js';

test('files: upload, folders, rename, move, delete round-trip', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    assert.deepEqual(await files.tree(), []);

    await files.createFolder('', 'Reports');
    await files.createFolder('Reports', '2026');
    await files.upload('', [asUpload('spec.pdf', 'pdf-bytes')], 'initial');
    await files.upload('Reports/2026', [asUpload('site visit.docx', 'doc-bytes')], 'initial');

    let tree = await files.tree();
    assert.deepEqual(tree.map((node) => node.name), ['Reports', 'spec.pdf']);
    assert.equal(tree[0].children[0].children[0].name, 'site visit.docx');
    assert.equal(tree[1].size, 'pdf-bytes'.length);
    assert.equal(tree[1].note, 'initial');
    assert.ok(tree[1].uploadedAt > 0);

    await files.renameEntry('spec.pdf', 'relay spec.pdf');
    await files.moveEntry('relay spec.pdf', 'Reports');
    tree = await files.tree();
    assert.deepEqual(tree[0].children.map((node) => node.name), ['2026', 'relay spec.pdf']);
    // The note and version time survive rename + move.
    assert.equal(tree[0].children[1].note, 'initial');

    // Guards: escape attempts, self-moves, collisions, missing notes.
    await assert.rejects(() => files.moveEntry('Reports', 'Reports/2026'), /into itself/);
    await assert.rejects(() => files.renameEntry('../outside', 'x'), /invalid file path/);
    await assert.rejects(() => files.removeEntry(''), /cannot delete the root/);
    await assert.rejects(() => files.createFolder('', 'Reports'), /already exists/);
    await assert.rejects(() => files.open('Reports'), /no such file/);
    assert.throws(() => files.upload('', [asUpload('x.pdf', 'x')]), /version note/);
    await assert.rejects(() => files.upload('', [asUpload('.hidden', 'x')], 'n'), /may not start/);

    await files.removeEntry('Reports');
    assert.deepEqual(await files.tree(), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: a same-name upload stacks as a new version, old bytes archived', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    await files.upload('', [asUpload('spec.pdf', 'v1-bytes')], 'first draft');
    const dup = await files.upload('', [asUpload('spec.pdf', 'v2-bytes-longer')], 'fixed ratings');
    assert.deepEqual(dup.added, ['spec.pdf']);

    const [node] = await files.tree();
    assert.equal(node.name, 'spec.pdf');
    assert.equal(node.note, 'fixed ratings');
    assert.equal(node.size, 'v2-bytes-longer'.length);
    assert.equal(node.versions.length, 1);
    const [previous] = node.versions;
    assert.equal(previous.note, 'first draft');
    assert.equal(previous.size, 'v1-bytes'.length);
    assert.match(previous.path, /^\.versions\//);

    // The archived version reads and opens by its real path.
    assert.equal((await files.read(previous.path)).toString(), 'v1-bytes');
    // The live file is the newest bytes.
    assert.equal((await files.read('spec.pdf')).toString(), 'v2-bytes-longer');

    // Rename carries the whole history under the new name.
    await files.renameEntry('spec.pdf', 'device spec.pdf');
    const [renamed] = await files.tree();
    assert.equal(renamed.versions.length, 1);
    assert.equal(renamed.versions[0].note, 'first draft');

    // Move carries the archived bytes into the target folder's archive.
    await files.createFolder('', 'Specs');
    await files.moveEntry('device spec.pdf', 'Specs');
    const tree = await files.tree();
    const moved = tree[0].children[0];
    assert.equal(moved.versions.length, 1);
    assert.match(moved.versions[0].path, /^Specs\/\.versions\//);
    assert.equal((await files.read(moved.versions[0].path)).toString(), 'v1-bytes');

    // Deleting the file deletes its history with it.
    await files.removeEntry('Specs/device spec.pdf');
    assert.deepEqual(await readdir(path.join(tmp, 'files', 'Specs', '.versions')), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: text read/save for the notes editor; saves do not version', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    // A brand-new note is born by its first save.
    await files.writeText('site notes.txt', 'day one');
    assert.equal(await files.readText('site notes.txt'), 'day one');

    await files.writeText('site notes.txt', 'day one\nday two');
    assert.equal(await files.readText('site notes.txt'), 'day one\nday two');
    const [node] = await files.tree();
    assert.equal(node.versions.length, 0);

    await assert.rejects(() => files.writeText('nope/x.txt', 'y'), /no such folder/);
    await assert.rejects(() => files.writeText('../outside.txt', 'y'), /invalid file path/);
    assert.throws(() => files.writeText('x.txt', 42), /must be a string/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
