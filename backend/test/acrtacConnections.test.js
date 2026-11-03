// AcRTAC's SEL3530.csv connection list: bench RTACs merged in by name, every
// other row (the default connection) kept, the old file kept as .bak.

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { mergeConnections } from '../lib/acrtacConnections.js';
import { TestNetworkService } from '../services/testNetwork.js';

const BASE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acrtac', 'SEL3530.csv');

test('acrtac connections: bench RTACs merged into the captured SEL3530.csv', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'projector-conn-'));
  const connectionsDir = path.join(dataDir, 'Connections');
  try {
    const svc = new TestNetworkService({ dataDir, jobs: null, connectionsDir });
    await assert.rejects(svc.writeAcrtacConnections(), /no RTACs/);

    await svc.saveDevices([
      { id: '3555-1', kind: 'rtac', networkIp: '10.42.44.34', port: '3' },
      { id: 'Bench, "B"', kind: 'rtac', networkIp: '10.42.44.35', port: '4' },
      { id: 'Pi', kind: 'other', networkIp: '10.42.44.50', port: '24' },
    ]);
    // No file yet (AcRTAC never run): one is made with the header.
    let r = await svc.writeAcrtacConnections();
    assert.deepEqual(r.added, ['3555-1', 'Bench, "B"']);

    const file = path.join(connectionsDir, 'SEL3530.csv');
    await copyFile(BASE, file);
    const base = await readFile(BASE, 'utf8');
    r = await svc.writeAcrtacConnections();
    assert.equal(r.file, file);
    assert.deepEqual(r.added, ['3555-1', 'Bench, "B"']);
    assert.equal(await readFile(`${file}.bak`, 'utf8'), base);
    assert.equal(await readFile(file, 'utf8'), [
      'Name,Server,Port,Database,User_Id',
      'SEL RTAC Default Connection,10.42.44.17,5432,3530,SEL',
      '3555-1,10.42.44.34,5432,3530,SEL',
      '"Bench, ""B""",10.42.44.35,5432,3530,SEL',
      '',
    ].join('\r\n'));

    // Again after a re-address: updated in place, nothing doubled.
    await svc.saveDevices([{ id: '3555-1', kind: 'rtac', networkIp: '10.42.44.40', port: '3' }]);
    r = await svc.writeAcrtacConnections();
    assert.deepEqual([r.added, r.updated, r.total], [[], ['3555-1'], 3]);

    // A file it can't read is left alone.
    await writeFile(file, 'something,else\r\n1,2\r\n');
    await assert.rejects(svc.writeAcrtacConnections(), /left as it was/);
    assert.equal(await readFile(file, 'utf8'), 'something,else\r\n1,2\r\n');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('acrtac connections: a matched row keeps its own port, database and user', () => {
  const text = 'Name,Server,Port,Database,User_Id\r\n3555-1,1.1.1.1,9999,other,admin\r\n';
  const r = mergeConnections(text, [{ id: '3555-1', networkIp: '10.42.44.34' }]);
  assert.equal(r.text.split('\r\n')[1], '3555-1,10.42.44.34,9999,other,admin');
});
