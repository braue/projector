// When an upload landed. The sidebar shows it on hover, so it has to survive
// the three things that rewrite an upload's record: a restart, a rename, and
// the model-version re-parse sweep.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SwService } from '../services/sw.js';
import { MINI_SW } from './helpers/miniSw.js';

const upload = (service) => service.upload('station_a.xml', Buffer.from(MINI_SW));

test('uploads: stamped on arrival, and the stamp survives a restart', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-stamp-'));
  try {
    const before = Date.now();
    const service = new SwService({ dataDir: tmp });
    await service.init();
    const summary = await upload(service);
    const after = Date.now();

    assert.ok(summary.uploadedAt >= before && summary.uploadedAt <= after,
      'the upload is stamped with the moment it landed');

    // A restart rehydrates from parsed.json — the stamp is stored, not
    // re-derived, so it is the same instant to the millisecond.
    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    assert.equal(restarted.list()[0].uploadedAt, summary.uploadedAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uploads: renaming a file does not restamp it', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-stamp-'));
  try {
    const service = new SwService({ dataDir: tmp });
    await service.init();
    const { id, uploadedAt } = await upload(service);

    const renamed = await service.rename(id, 'Station A — as found');
    assert.equal(renamed.uploadedAt, uploadedAt, 'a rename is not a new upload');

    // And it is still right after a restart, from the moved folder.
    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    assert.equal(restarted.list()[0].uploadedAt, uploadedAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uploads: a model-version re-parse keeps the original time', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-stamp-'));
  try {
    const service = new SwService({ dataDir: tmp });
    await service.init();
    const { id, uploadedAt } = await upload(service);

    // Age the stored record the way a shipped build would: same bytes,
    // older model version, so the next start re-parses it.
    const file = path.join(tmp, service.store.label, id, 'parsed.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, modelVersion: 'ancient' }));

    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    await restarted.migrated;
    assert.equal(restarted.list()[0].uploadedAt, uploadedAt,
      're-parsing is not re-uploading');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uploads: one from before the stamp existed falls back to its folder', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-stamp-'));
  try {
    const service = new SwService({ dataDir: tmp });
    await service.init();
    const { id } = await upload(service);

    // Exactly what a pre-0.9 install has on disk: no uploadedAt at all.
    const file = path.join(tmp, service.store.label, id, 'parsed.json');
    const { uploadedAt, ...legacy } = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(uploadedAt, 'the field was there to remove');
    await writeFile(file, JSON.stringify(legacy));

    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    const recovered = restarted.list()[0].uploadedAt;
    assert.ok(recovered > 0, 'the folder supplies a time rather than none');
    // The folder was made moments ago by this test, so it must read as recent
    // rather than as the epoch.
    assert.ok(Date.now() - recovered < 60_000, 'and it is the folder time, not 1970');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uploads: the same file name can land many times, newest listed first', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-order-'));
  try {
    const service = new SwService({ dataDir: tmp });
    await service.init();

    // Three revisions of the same settings file, uploaded under one name.
    const first = await upload(service);
    const second = await upload(service);
    const third = await upload(service);

    // They coexist: one display name, three distinct ids and refs, so a
    // canvas placement or a comparison still addresses exactly one of them.
    assert.deepEqual(
      [first, second, third].map((f) => f.fileName),
      ['station_a.xml', 'station_a.xml', 'station_a.xml'],
    );
    assert.equal(new Set([first, second, third].map((f) => f.id)).size, 3);
    assert.equal(new Set([first, second, third].map((f) => f.profiles[0].ref)).size, 3);

    // Stamp them out of upload order to prove the sort follows the CLOCK, not
    // insertion order and not the id suffix.
    const stamp = async (id, uploadedAt) => {
      const file = path.join(tmp, service.store.label, id, 'parsed.json');
      const stored = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ ...stored, uploadedAt }));
    };
    await stamp(first.id, 3_000);   // the FIRST upload is the newest
    await stamp(second.id, 1_000);
    await stamp(third.id, 2_000);

    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    assert.deepEqual(
      restarted.list().map((f) => f.id),
      [first.id, third.id, second.id],
      'newest at the top, oldest at the bottom — across a restart',
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('uploads: an upload with no known time sorts last, not first', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-order-'));
  try {
    const service = new SwService({ dataDir: tmp });
    await service.init();
    const dated = await upload(service);
    const undated = await upload(service);

    // Null stands for "the folder could not be read either" — the one case
    // where nothing is known. It must not float to the top of the list.
    const file = path.join(tmp, service.store.label, undated.id, 'parsed.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, uploadedAt: null }));

    const restarted = new SwService({ dataDir: tmp });
    await restarted.init();
    // The folder fallback normally rescues it, so null only survives when
    // that fails too — force the question by clearing what init recovered.
    const record = restarted.store.get(undated.id);
    record.uploadedAt = null;
    assert.deepEqual(restarted.list().map((f) => f.id), [dated.id, undated.id]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
