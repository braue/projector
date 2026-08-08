// End-to-end panel-drawings pipeline against a synthetic device: a generated
// PDF stands in for the SEL master drawing (those are copyrighted and never in
// the repo), so the render/crop/tree/item path is testable without one.

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { RdbService } from '../services/rdb.js';
import { makeRdb } from './helpers/makeRdb.js';

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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-drawings-'));
  try {
    const service = new RdbService({ dataDir: tmp, selDevicesDir: await testDevicesDir(tmp) });
    await service.init();

    const rdb = makeRdb([{
      name: 'UNIT_1',
      relayType: 'SEL-TESTREL',
      sections: [{ key: 'G', desc: 'Global', settings: { TID: 'UNIT ONE' } }],
    }]);
    const summary = await service.upload('unit.rdb', rdb);
    const ref = summary.profiles[0].ref;

    const tree = service.tree(ref);
    const [first] = tree.tree;
    assert.equal(first.type, 'folder');
    assert.equal(first.name, 'Drawings');
    assert.deepEqual(first.children.map((child) => child.path), ['drawing:front', 'drawing:rear']);

    const item = service.item(ref, 'drawing:front');
    assert.equal(item.name, 'Front view');
    assert.equal(item.kind, 'Drawing');
    assert.match(item.image.url, /^\/api\/rdb\/drawing\?ref=/);

    for (const view of ['front', 'rear']) {
      await access(service.drawingPath(ref, view)); // the PNG exists on disk
    }
    assert.throws(() => service.drawingPath(ref, 'top'), /no top drawing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a model without drawing assets uploads cleanly with no Drawings section', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'purview-drawings-'));
  try {
    const service = new RdbService({ dataDir: tmp, selDevicesDir: path.join(tmp, 'empty') });
    await service.init();

    const rdb = makeRdb([{
      name: 'UNIT_2',
      relayType: 'SEL-451',
      sections: [{ key: 'G', desc: 'Global', settings: { TID: 'UNIT TWO' } }],
    }]);
    const summary = await service.upload('u.rdb', rdb);

    const tree = service.tree(summary.profiles[0].ref);
    assert.ok(!tree.tree.some((node) => node.name === 'Drawings'));
    assert.throws(() => service.item(summary.profiles[0].ref, 'drawing:front'), /no front drawing/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
