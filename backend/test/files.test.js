// Project files store: real directory tree, plain fs operations, the guards
// that keep everything inside it — and versions: a same-name upload stacks
// with its mandatory note instead of unique-ifying or overwriting.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesService } from '../services/files.js';
import { asUpload, rtacAnnotate } from './helpers/bundle.js';

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

test('files: a versionOf arrival renames the entry to the new version\'s name', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    // The entry follows what its newest version is called: uploading
    // "spec_r2.pdf" as a new version of "spec.pdf" renames the entry, the
    // superseded bytes stacking underneath as usual.
    await files.upload('', [asUpload('spec.pdf', 'v1-bytes')], 'first draft');
    const added = await files.upload('', [asUpload('spec_r2.pdf', 'v2-bytes-longer')], 'revised', 'spec.pdf');
    assert.deepEqual(added.added, ['spec_r2.pdf']);

    const tree = await files.tree();
    assert.deepEqual(tree.map((node) => node.name), ['spec_r2.pdf']);
    const [node] = tree;
    assert.equal(node.note, 'revised');
    assert.equal(node.versions.length, 1);
    assert.equal(node.versions[0].note, 'first draft');
    // The archived version keeps the name it was uploaded with.
    assert.equal(node.versions[0].name, 'spec.pdf');
    assert.equal((await files.read(node.versions[0].path)).toString(), 'v1-bytes');
    assert.equal((await files.read('spec_r2.pdf')).toString(), 'v2-bytes-longer');

    // versionOf equal to the arrival's own name is plain stacking.
    await files.upload('', [asUpload('spec_r2.pdf', 'v3')], 'again', 'spec_r2.pdf');
    assert.equal((await files.tree())[0].versions.length, 2);

    // Guards: the superseded entry must exist; the new name must be free;
    // shapes must match; a batch cannot claim to version one entry.
    await files.upload('', [asUpload('other.pdf', 'x')], 'n');
    await assert.rejects(
      () => files.upload('', [asUpload('new.pdf', 'x')], 'n', 'ghost.pdf'),
      /no such entry/,
    );
    await assert.rejects(
      () => files.upload('', [asUpload('other.pdf', 'x')], 'n', 'spec_r2.pdf'),
      /already exists/,
    );
    assert.throws(
      () => files.upload('', [asUpload('a.pdf', 'x'), asUpload('b.pdf', 'x')], 'n', 'spec_r2.pdf'),
      /exactly one file/,
    );

    // A directory entry renames the same way (the RTAC "new version from
    // AcRTAC" path, where the database name replaces the entry name).
    await files.placeEntry('', 'Old Name.rtac', 'first pull', async (target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'Devices.xml'), '<GVL/>');
    }, { directory: true });
    await files.placeEntry('', 'Feeder 9.rtac', 'repull', async (target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'Devices.xml'), '<GVL2/>');
    }, { directory: true, versionOf: 'Old Name.rtac', database: 'Feeder 9' });
    const listed = await files.tree(rtacAnnotate);
    assert.ok(listed.some((node) => node.name === 'Feeder 9.rtac')
      && !listed.some((node) => node.name === 'Old Name.rtac'));
    const rtac = listed.find((node) => node.name === 'Feeder 9.rtac');
    assert.equal(rtac.versions.length, 1);
    assert.equal(rtac.versions[0].note, 'first pull');
    // The archived version keeps its whole identity: name, kind, database
    // (none was recorded when it arrived).
    assert.equal(rtac.versions[0].name, 'Old Name.rtac');
    assert.equal(rtac.versions[0].kind, 'rtac');
    assert.equal(rtac.versions[0].database, null);
    // The database link records on arrival, survives arrivals without one,
    // and snapshots into the version it supersedes.
    assert.equal(rtac.database, 'Feeder 9');
    await files.placeEntry('', 'Feeder 9.rtac', 'repull again', async (target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'Devices.xml'), '<GVL3/>');
    }, { directory: true });
    const restacked = (await files.tree(rtacAnnotate)).find((node) => node.name === 'Feeder 9.rtac');
    assert.equal(restacked.database, 'Feeder 9');
    assert.equal(restacked.versions[0].database, 'Feeder 9');
    // recordDatabase (a successful Import to AcRTAC) sets the link directly.
    await files.recordDatabase('spec_r2.pdf', 'Feeder 9 Spec');
    assert.equal((await files.tree()).find((node) => node.name === 'spec_r2.pdf').database, 'Feeder 9 Spec');

    // A failed renaming arrival restores the superseded entry under ITS name.
    await assert.rejects(
      () => files.placeEntry('', 'newer.pdf', 'doomed', () => {
        throw new Error('disk full');
      }, { versionOf: 'spec_r2.pdf' }),
      /disk full/,
    );
    const after = await files.tree();
    const restored = after.find((node) => node.name === 'spec_r2.pdf');
    assert.ok(restored && !after.some((node) => node.name === 'newer.pdf'));
    assert.equal(restored.versions.length, 2);
    assert.equal((await files.read('spec_r2.pdf')).toString(), 'v3');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: a failed arrival can never cost the version that was there', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    await files.upload('', [asUpload('spec.pdf', 'v1-bytes')], 'first');

    // The writer fails AFTER the live entry was archived: the entry must be
    // restored, its history unchanged — not vanish with orphaned archives.
    await assert.rejects(
      () => files.placeEntry('', 'spec.pdf', 'doomed', () => {
        throw new Error('disk full');
      }),
      /disk full/,
    );
    const [node] = await files.tree();
    assert.equal(node.name, 'spec.pdf');
    assert.equal(node.note, 'first');
    assert.equal(node.versions.length, 0);
    assert.equal((await files.read('spec.pdf')).toString(), 'v1-bytes');

    // A FILE arriving under an existing FOLDER's name must refuse, not bury
    // the folder's subtree in the archive (and vice versa).
    await files.createFolder('', 'reports');
    await assert.rejects(
      () => files.upload('', [asUpload('reports', 'not-a-folder')], 'oops'),
      /a folder is named that/,
    );
    await assert.rejects(
      () => files.placeEntry('', 'spec.pdf', 'oops', () => {}, { directory: true }),
      /a file is named that/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: the version archive is read-only to mutations', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();

    await files.upload('', [asUpload('log.txt', 'v1')], 'first');
    await files.upload('', [asUpload('log.txt', 'v2')], 'second');
    const [node] = await files.tree();
    const archived = node.versions[0].path;

    // Archived bytes and the sidecar are history: no rename, delete, move,
    // in-place edit, or placement may touch the dot-namespace...
    await assert.rejects(() => files.renameEntry('.versions.json', 'x.json'), /read-only/);
    await assert.rejects(() => files.renameEntry(archived, 'x.txt'), /read-only/);
    await assert.rejects(() => files.removeEntry(archived), /read-only/);
    await assert.rejects(() => files.moveEntry(archived, ''), /read-only/);
    await assert.rejects(() => files.moveEntry('log.txt', '.versions'), /read-only/);
    await assert.rejects(() => files.writeText(archived, 'rewritten'), /read-only/);
    await assert.rejects(() => files.createFolder('.versions', 'x'), /read-only/);
    await assert.rejects(() => files.upload('.versions', [asUpload('x.txt', 'x')], 'n'), /read-only/);

    // ...while reads still address it.
    assert.equal((await files.read(archived)).toString(), 'v1');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: the live entry is a working copy — in-place edits record or discard', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.upload('', [asUpload('sheet.xlsx', 'v1-bytes')], 'first');
    let [node] = await files.tree();
    assert.equal(node.edited, false);

    // Excel (or anything at all — no app-open required) saves over the live
    // file: the entry flags as edited, and the committed copy made at
    // arrival still holds the committed bytes.
    await writeFile(path.join(tmp, 'files', 'sheet.xlsx'), 'v1-bytes-edited-in-place');
    ;[node] = await files.tree();
    assert.equal(node.edited, true);

    // Committing archives the PRE-EDIT bytes as the superseded version.
    assert.throws(() => files.recordEdit('sheet.xlsx', ''), /version note/);
    await files.recordEdit('sheet.xlsx', 'updated ratings in excel');
    ;[node] = await files.tree();
    assert.equal(node.edited, false);
    assert.equal(node.note, 'updated ratings in excel');
    assert.equal(node.versions.length, 1);
    assert.equal((await files.read(node.versions[0].path)).toString(), 'v1-bytes');
    assert.equal((await files.read('sheet.xlsx')).toString(), 'v1-bytes-edited-in-place');
    await assert.rejects(() => files.recordEdit('sheet.xlsx', 'again'), /no on-disk edits/);

    // Discard restores the committed copy — the checkout to recordEdit's
    // commit — and can run again after another edit (the copy stays put).
    await writeFile(path.join(tmp, 'files', 'sheet.xlsx'), 'scribbles');
    ;[node] = await files.tree();
    assert.equal(node.edited, true);
    await files.discardEdit('sheet.xlsx');
    ;[node] = await files.tree();
    assert.equal(node.edited, false);
    assert.equal((await files.read('sheet.xlsx')).toString(), 'v1-bytes-edited-in-place');
    assert.equal(node.versions.length, 1);
    await writeFile(path.join(tmp, 'files', 'sheet.xlsx'), 'more scribbles');
    await files.discardEdit('sheet.xlsx');
    assert.equal((await files.read('sheet.xlsx')).toString(), 'v1-bytes-edited-in-place');

    // A NEW ARRIVAL refreshes the committed copy to the new version.
    await files.upload('', [asUpload('sheet.xlsx', 'v3-bytes')], 'third');
    await writeFile(path.join(tmp, 'files', 'sheet.xlsx'), 'v3-edited');
    await files.discardEdit('sheet.xlsx');
    assert.equal((await files.read('sheet.xlsx')).toString(), 'v3-bytes');

    // A file dropped in by hand predates committed copies: opening from the
    // app backfills one, and edits then record with their pre-edit bytes.
    await writeFile(path.join(tmp, 'files', 'stray.csv'), 'stray-v1');
    await files.ensureCommittedCopy('stray.csv');
    await writeFile(path.join(tmp, 'files', 'stray.csv'), 'stray-v1-edited');
    const stray = (await files.tree()).find((entry) => entry.name === 'stray.csv');
    assert.equal(stray.edited, true);
    await files.recordEdit('stray.csv', 'first recorded change');
    const strayAfter = (await files.tree()).find((entry) => entry.name === 'stray.csv');
    assert.equal(strayAfter.versions.length, 1);
    assert.equal((await files.read(strayAfter.versions[0].path)).toString(), 'stray-v1');

    // The built-in text editor is exempt: its in-place saves are not edits —
    // they MOVE the committed state, so a later OS edit archives the
    // editor's latest bytes, not the original arrival.
    await files.upload('', [asUpload('notes.txt', 'day one')], 'notes');
    await files.writeText('notes.txt', 'day one\nday two');
    let noteNode = (await files.tree()).find((entry) => entry.name === 'notes.txt');
    assert.equal(noteNode.edited, false);
    await writeFile(path.join(tmp, 'files', 'notes.txt'), 'scribbled outside');
    await files.recordEdit('notes.txt', 'outside edit');
    noteNode = (await files.tree()).find((entry) => entry.name === 'notes.txt');
    assert.equal((await files.read(noteNode.versions[0].path)).toString(), 'day one\nday two');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('files: one bad entry or sidecar degrades, never takes the tree down', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-files-'));
  try {
    const files = new FilesService({ dataDir: tmp });
    await files.init();
    await files.upload('', [asUpload('spec.pdf', 'bytes')], 'first');

    // A dangling symlink (the store is a real OS-visible folder) lists as
    // nothing rather than failing the walk.
    await symlink(path.join(tmp, 'gone.pdf'), path.join(tmp, 'files', 'linked.pdf'));
    let tree = await files.tree();
    assert.deepEqual(tree.map((node) => node.name), ['spec.pdf']);

    // A corrupt sidecar degrades READS to "no records"...
    await writeFile(path.join(tmp, 'files', '.versions.json'), '{truncated');
    tree = await files.tree();
    assert.equal(tree[0].name, 'spec.pdf');
    assert.equal(tree[0].note, null);
    // ...but fails WRITES, which would overwrite every record in it.
    await assert.rejects(
      () => files.upload('', [asUpload('spec.pdf', 'v2')], 'second'),
      /version records/,
    );
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
    // The name rule is ENFORCED here, not sanitized: ':' would collide with
    // the "path::profile" ref separator.
    await assert.rejects(() => files.writeText('a::b.txt', 'y'), /invalid name/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
