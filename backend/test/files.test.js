// Project files store: real directory tree, plain fs operations, and the
// guards that keep everything inside it.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';

const asUpload = (name, content) => ({ originalname: name, buffer: Buffer.from(content) });

test('files: upload, folders, rename, move, delete round-trip', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    assert.deepEqual(await files.tree(), []);

    await files.createFolder('', 'Reports');
    await files.createFolder('Reports', '2026');
    await files.upload('', [asUpload('spec.pdf', 'pdf-bytes')]);
    await files.upload('Reports/2026', [asUpload('site visit.docx', 'doc-bytes')]);

    // Same-name upload unique-ifies, never overwrites.
    const dup = await files.upload('', [asUpload('spec.pdf', 'other-bytes')]);
    assert.deepEqual(dup.added, ['spec-2.pdf']);

    let tree = await files.tree();
    assert.deepEqual(tree.map((node) => node.name), ['Reports', 'spec-2.pdf', 'spec.pdf']);
    assert.equal(tree[0].children[0].children[0].name, 'site visit.docx');
    assert.equal(tree[1].size, 'other-bytes'.length);

    await files.renameEntry('spec.pdf', 'relay spec.pdf');
    await files.moveEntry('relay spec.pdf', 'Reports');
    tree = await files.tree();
    assert.deepEqual(tree[0].children.map((node) => node.name), ['2026', 'relay spec.pdf']);

    // Guards: escape attempts, self-moves, collisions.
    await assert.rejects(() => files.moveEntry('Reports', 'Reports/2026'), /into itself/);
    await assert.rejects(() => files.renameEntry('../outside', 'x'), /invalid file path/);
    await assert.rejects(() => files.removeEntry(''), /cannot delete the root/);
    await assert.rejects(() => files.createFolder('', 'Reports'), /already exists/);
    await assert.rejects(() => files.open('Reports'), /no such file/);

    await files.removeEntry('Reports');
    assert.deepEqual((await files.tree()).map((node) => node.name), ['spec-2.pdf']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
