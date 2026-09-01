// Downloading a database project you already hold. The settings change, so
// the same project is pulled again — and the copy already here is what the
// new one gets compared against, so nothing may be replaced.

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RtacService } from '../services/rtac.js';
import { RtacCatalog } from '../services/rtacCatalog.js';

const MODULE = '<?xml version="1.0"?><RTACModule><ExportSource><Schema>1</Schema></ExportSource>'
  + '<Device><Name>F</Name><Protocol>DNPClient</Protocol></Device></RTACModule>';

/** A bridge that writes one XML file per export, so each copy is real. */
function client() {
  return {
    async listProjects() {
      return [{ name: 'SUB_1' }, { name: 'SUB_2' }];
    },
    async exportXml({ directory }) {
      // cli.exportxml creates the folder it exports into; the service only
      // clears it first.
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'Feeder.xml'), MODULE);
    },
  };
}

/** startExport is fire-and-forget; settle when nothing is still exporting. */
async function settled(service) {
  for (let i = 0; i < 200; i += 1) {
    if (!service.list().projects.some((p) => p.status === 'exporting')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('an export never finished');
}

async function serviceIn(dataDir, bridge = client()) {
  const catalog = new RtacCatalog({ client: bridge });
  await catalog.refresh();
  const service = new RtacService({ catalog, dataDir });
  await service.init();
  return service;
}

/** test() over a fresh data directory that is always cleaned up. */
function inTmp(name, body) {
  test(name, async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-copies-'));
    try {
      await body(tmp);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
}

inTmp('rtac: downloading a project already here keeps both copies', async (tmp) => {
  const service = await serviceIn(tmp);

  service.startExport('SUB_1');
  await settled(service);
  service.startExport('SUB_1');
  await settled(service);

  const copies = service.list().projects;
  assert.equal(copies.length, 2, 'the second download did not replace the first');
  // One display name, two identities — the ids are what folders and canvas
  // refs are made of, so they must differ.
  assert.deepEqual(copies.map((p) => p.displayName), ['SUB_1', 'SUB_1']);
  assert.deepEqual(copies.map((p) => p.name).sort(), ['SUB_1', 'SUB_1-2']);

  // Both are real exports on disk, independently readable.
  for (const copy of copies) {
    await access(path.join(tmp, copy.name));
    assert.equal((await service.tree(copy.name)).tree.length, 1);
  }

  // Newest first, so the copy just downloaded is at the top.
  assert.ok(copies[0].at >= copies[1].at, 'the newer copy is listed first');

  // The browser reports how many are held; it never blocks a download.
  const sub1 = service.available().projects.find((p) => p.name === 'SUB_1');
  assert.deepEqual(sub1, { name: 'SUB_1', copies: 2 });
});

inTmp('rtac: copies keep their names and dates across a restart', async (tmp) => {
  const service = await serviceIn(tmp);
  service.startExport('SUB_1');
  await settled(service);
  service.startExport('SUB_1');
  await settled(service);
  // Rename one copy: only the display name moves, so the two now differ.
  await service.rename('SUB_1-2', 'SUB_1 — as found');
  const before = service.list().projects.map((p) => [p.name, p.displayName, p.at]);

  const restarted = await serviceIn(tmp);
  assert.deepEqual(
    restarted.list().projects.map((p) => [p.name, p.displayName, p.at]),
    before,
    'the index restores both the display names and the download times',
  );
});

inTmp('rtac: an export folder with no index entry still lists', async (tmp) => {
  const service = await serviceIn(tmp);
  service.startExport('SUB_1');
  await settled(service);

  // Exactly what an install from before the index has: folders, no index.
  await rm(path.join(tmp, '.exports.json'));

  const restarted = await serviceIn(tmp);
  const [only] = restarted.list().projects;
  assert.equal(only.name, 'SUB_1');
  assert.equal(only.displayName, 'SUB_1', 'it falls back to its folder name');
  assert.ok(only.at > 0, 'and to its folder time');
});

inTmp('rtac: a retry re-runs the same copy instead of adding one', async (tmp) => {
  let fail = true;
  const service = await serviceIn(tmp, {
    ...client(),
    async exportXml({ directory }) {
      if (fail) throw new Error('bridge blew up');
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'Feeder.xml'), MODULE);
    },
  });

  service.startExport('SUB_1');
  await settled(service);
  const [failed] = service.list().projects;
  assert.equal(failed.status, 'error');

  fail = false;
  service.retryExport(failed.name);
  await settled(service);

  const after = service.list().projects;
  assert.equal(after.length, 1, 'a retry is the same copy trying again');
  assert.equal(after[0].name, failed.name, 'and it keeps its id, so refs survive');
  assert.equal(after[0].status, 'ready');
});

inTmp('rtac: an uploaded folder whose name is here lands as another copy', async (tmp) => {
  const service = await serviceIn(tmp);
  const upload = () => service.uploadFolder([
    { path: 'SUB_1/Feeder.xml', buffer: Buffer.from(MODULE) },
  ]);

  assert.deepEqual((await upload()).added, [{ name: 'SUB_1', id: 'SUB_1', files: 1 }]);
  assert.deepEqual((await upload()).added, [{ name: 'SUB_1', id: 'SUB_1-2', files: 1 }]);

  const copies = service.list().projects;
  assert.deepEqual(copies.map((p) => p.displayName), ['SUB_1', 'SUB_1']);
  assert.deepEqual(copies.map((p) => p.name).sort(), ['SUB_1', 'SUB_1-2']);

  // The index survives the second write.
  const index = JSON.parse(await readFile(path.join(tmp, '.exports.json'), 'utf8'));
  assert.deepEqual(Object.keys(index).sort(), ['SUB_1', 'SUB_1-2']);
});

inTmp('rtac: a folder that appeared at runtime is never overwritten', async (tmp) => {
  const service = await serviceIn(tmp);
  service.startExport('SUB_1');
  await settled(service);

  // Someone drops a copy in while the app runs — init() reconciled long ago,
  // so state has never heard of it. The next download must still step around
  // it rather than rm -rf its way through.
  await mkdir(path.join(tmp, 'SUB_1-2'), { recursive: true });
  await writeFile(path.join(tmp, 'SUB_1-2', 'Feeder.xml'), MODULE);

  service.startExport('SUB_1');
  await settled(service);

  assert.deepEqual(
    (await readdir(tmp, { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name).sort(),
    ['SUB_1', 'SUB_1-2', 'SUB_1-3'],
    'the hand-dropped folder survived and the download took the next free id',
  );
  await access(path.join(tmp, 'SUB_1-2', 'Feeder.xml'));
});

inTmp('rtac: a download in flight sorts as the newest copy of its name', async (tmp) => {
  const service = await serviceIn(tmp);
  service.startExport('SUB_1');
  await settled(service);

  // Mid-download the spinner row must already sit above the copy it will
  // supersede, or the list reshuffles under the cursor when it lands.
  service.startExport('SUB_1');
  const [first, second] = service.list().projects;
  assert.equal(first.status, 'exporting', 'the new copy leads its group');
  assert.equal(second.status, 'ready');
  await settled(service);
  assert.equal(service.list().projects[0].name, first.name, 'and stays there once ready');
});
