// End-to-end panel-drawings pipeline against a synthetic device: a generated
// PDF stands in for the SEL master drawing (those are copyrighted and never in
// the repo), so the render/crop/tree/item path is testable without one.

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { ArtifactsService } from '../lib/artifacts.js';
import { FilesService } from '../services/files.js';
import { RdbKind } from '../services/rdb.js';
import { makeRdb } from './helpers/makeRdb.js';

// The bundle wiring, with the drawing generator pointed at the synthetic
// device corpus.
async function makeRdbBundle(tmp, selDevicesDir) {
  let artifacts;
  const files = new FilesService({ dataDir: tmp, onChanged: (p) => artifacts?.invalidate(p) });
  artifacts = new ArtifactsService({ files, catalog: { names: [], error: null }, projectDir: tmp });
  const rdb = new RdbKind({ artifacts, projectDir: tmp, selDevicesDir });
  artifacts.register('rdb', rdb);
  await files.init();
  return { files, artifacts, rdb };
}

// Left half of the page is the front view, right half the rear — the crops
// carve the two apart.
const METADATA = {
  device: 'TESTREL',
  model_to_drawings: {
    front_and_rear: [{ front_pdf: 'drawing.pdf', rear_pdf: 'drawing.pdf' }],
  },
  model_to_layers: { has_layers: false },
  crops: {
    views_by_pdf: {
      'drawing.pdf': {
        front: { page: 1, box: [0, 0, 300, 300] },
        rear: { page: 1, box: [300, 0, 600, 300] },
      },
    },
  },
};

async function makeDrawingPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('FRONT', { x: 60, y: 130, size: 48, font, color: rgb(0, 0, 0) });
  page.drawText('REAR', { x: 380, y: 130, size: 48, font, color: rgb(0, 0, 0) });
  return doc.save();
}

async function testDevicesDir(tmp) {
  const devicesDir = path.join(tmp, 'selDevices');
  const deviceDir = path.join(devicesDir, 'TESTREL');
  await mkdir(deviceDir, { recursive: true });
  await writeFile(path.join(deviceDir, 'metadata.json'), JSON.stringify(METADATA));
  await writeFile(path.join(deviceDir, 'drawing.pdf'), Buffer.from(await makeDrawingPdf()));
  return devicesDir;
}

test('rdb upload generates front/rear drawings, tree leads with them, item serves the image', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-drawings-'));
  try {
    const { files, rdb: service } = await makeRdbBundle(tmp, await testDevicesDir(tmp));
    await files.upload('', [{ originalname: 'unit.rdb', buffer: makeRdb([{
      name: 'UNIT_1',
      relayType: 'SEL-TESTREL',
      sections: [{ key: 'G', desc: 'Global', settings: { TID: 'UNIT ONE' } }],
    }]) }], 'initial');
    const ref = 'unit.rdb::UNIT_1';

    const tree = await service.tree(ref);
    const [first] = tree.tree;
    assert.equal(first.type, 'folder');
    assert.equal(first.name, 'Drawings');
    assert.deepEqual(first.children.map((child) => child.path), ['drawing:front', 'drawing:rear']);

    const item = await service.item(ref, 'drawing:front');
    assert.equal(item.name, 'Front view');
    assert.equal(item.kind, 'Drawing');
    assert.match(item.image.url, /^\/api\/artifacts\/drawing\?ref=/);

    for (const view of ['front', 'rear']) {
      await access(await service.drawingPath(ref, view)); // the PNG exists on disk
    }
    await assert.rejects(() => service.drawingPath(ref, 'top'), /no top drawing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a model without drawing assets uploads cleanly with no Drawings section', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-drawings-'));
  try {
    const { files, rdb: service } = await makeRdbBundle(tmp, path.join(tmp, 'empty'));
    await files.upload('', [{ originalname: 'u.rdb', buffer: makeRdb([{
      name: 'UNIT_2',
      relayType: 'SEL-451',
      sections: [{ key: 'G', desc: 'Global', settings: { TID: 'UNIT TWO' } }],
    }]) }], 'initial');

    const tree = await service.tree('u.rdb::UNIT_2');
    assert.ok(!tree.tree.some((node) => node.name === 'Drawings'));
    await assert.rejects(() => service.item('u.rdb::UNIT_2', 'drawing:front'), /no front drawing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
