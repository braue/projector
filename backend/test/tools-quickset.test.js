// QuickSet Extract: the dump parser, the WinZip-AES / Zip64 reader, and the
// service end to end over a synthetic backup — read in place (project file)
// and via the browser's locate + feed path — plus settings extraction.

import assert from 'node:assert/strict';
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { strToU8, zipSync } from 'fflate';

import { JobRegistry } from '../services/jobs.js';
import { parseDump, unescapeField } from '../services/tools/quickset/dump.js';
import { QuicksetService } from '../services/tools/quickset/index.js';
import { parseSettingLine } from '../services/tools/quickset/parsers.js';
import { ToolsWorkspace } from '../services/tools/workspace.js';

const CFG = '[INFO]\r\nRELAYTYPE=SEL-751A\r\nFID=SEL-751A-R100-V0-Z001001-D20200101\r\nPARTNO=751A01\r\n[CLASSES]\r\nG,"Global"\r\nP1,"Port 1"\r\n';
const SET_P1 = '[INFO]\r\nRELAYTYPE=SEL-751A\r\n[P1]\r\nEPORT,"Y"\r\nIPADDR,"10.1.1.5"\r\nSUBNETM,"255.255.255.0"\r\nETELNET,"Y"\r\n';
const SET_G = '[G]\r\nOUT101,"ALARM"\r\nLER,"15"\r\n';

function settingsZipHex() {
  const top = 'FDR1_Direct\\Relays\\FDR1_Direct';
  const zip = zipSync({
    [`${top}\\Misc\\Cfg.txt`]: strToU8(CFG),
    [`${top}\\set_P1.txt`]: strToU8(SET_P1),
    [`${top}\\set_G.txt`]: strToU8(SET_G),
  });
  return Buffer.from(zip).toString('hex');
}

const copy = (table, columns, rows) =>
  `COPY ${table} (${columns.join(', ')}) FROM stdin;\n${rows.map((r) => `${r.join('\t')}\n`).join('')}\\.\n\n`;

function makeDump({ twin = false } = {}) {
  return [
    '--\n-- PostgreSQL database dump\n--\n\nSET client_encoding = \'UTF8\';\n\n',
    // A table the parser skips; its rows must not leak into anything.
    copy('notif.notification', ['id', 'body'], [['1', 'COPY public.device (device_id) FROM stdin;'], ['2', 'x']]),
    copy('public.location', ['location_id', 'location_type_id', 'location_name', 'description'], [
      ['1', '1', 'Plant', '\\N'], ['2', '1', 'North\\tSub', 'Main yard'],
    ]),
    copy('public.location_type', ['location_type_id', 'location_type_name'], [['1', 'Area']]),
    copy('public.device_type', ['device_type_id', 'device_type_name', 'device_type_class_id'], [['10', 'SEL-751A', '1'], ['11', 'SEL-3530', '4']]),
    copy('public.device_type_class', ['device_type_class_id', 'class_name'], [['1', 'Default'], ['4', 'RTAC']]),
    copy('public.communication_type', ['communication_type_id', 'communication_type'], [['3', 'network']]),
    copy('public.protocol', ['protocol_id', 'protocol_name'], [['0', 'Unspecified']]),
    copy('public.credential_source_type', ['credential_source_type_id', 'credential_source_type_name'], [['1', 'Prompt']]),
    copy('public.communication_channel',
      ['communication_channel_id', 'communication_type_id', 'ip_address', 'telnet_port', 'https_port', 'ftp_port', 'protocol_id', 'credential_source_type_id', 'ftp_password_id'],
      [['100', '3', '10.1.1.5', '23', '443', '21', '0', '1', 'SECRET'], ['101', '3', '10.1.1.2', '23', '443', '21', '0', '1', '\\N']]),
    copy('public.connection', ['connection_id', 'communication_channel_id', 'port_number'], [['200', '100', '0'], ['201', '101', '0']]),
    copy('public.device', ['device_id', 'device_name', 'device_type_id', 'in_service', 'firmware_version', 'part_number', 'fid_string', 'connection_id', 'serial_number'], [
      ['50', 'FDR1 Direct', '10', 't', 'R100', '', '', '200', '123'],
      ['51', 'RTAC-1', '11', 'f', '', '', '', '201', ''],
      ...(twin ? [['52', 'FDR1 Direct', '10', 't', 'R100', '', '', '200', '124']] : []),
    ]),
    copy('public.connection_node_data', ['connection_node_id', 'parent_node_id', 'device_id', 'location_id', 'display_order'], [
      ['1', '\\N', '\\N', '1', '0'], ['2', '1', '\\N', '2', '0'], ['3', '2', '51', '\\N', '0'], ['4', '3', '50', '\\N', '0'],
      ...(twin ? [['5', '3', '52', '\\N', '1']] : []),
    ]),
    copy('public.settings_content', ['settings_content_id', 'device_type_id', 'settings_version', 'content'], [
      ['900', '10', '1', `\\\\x${settingsZipHex()}`],
    ]),
    copy('public.config_revision_type', ['config_revision_type_id', 'revision_type'], [['2', 'Read']]),
    copy('public.device_config_revision', ['device_config_revision_id', 'device_id', 'comment', 'begin_timestamp', 'revision_sequence_number', 'creator_username', 'revision_type_id', 'version_number', 'settings_content_id'], [
      ['1', '50', 'read\\nsettings', '2024-01-02 10:00:00', '1', 'eng', '2', '0.1', '900'],
      ...(twin ? [['2', '52', 'read', '2024-01-02 10:00:00', '1', 'eng', '2', '0.1', '900']] : []),
    ]),
  ].join('');
}

// --- a WinZip-AES ZIP writer, the inverse of what the reader undoes ---------

function aesEncrypt(plain, password) {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, 1000, 66, 'sha1');
  const cipher = createCipheriv('aes-256-ecb', derived.subarray(0, 32), null).setAutoPadding(false);
  const blocks = Math.ceil(plain.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let i = 0; i < blocks; i += 1) counters.writeUInt32LE(i + 1, i * 16);
  const stream = cipher.update(counters);
  const data = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) data[i] = plain[i] ^ stream[i];
  const mac = createHmac('sha1', derived.subarray(32, 64)).update(data).digest().subarray(0, 10);
  return Buffer.concat([salt, derived.subarray(64, 66), data, mac]);
}

/** ZIP of [{ name, data }], every entry AES-256 + deflate, with Zip64 records. */
function aesZip(files, password) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const body = aesEncrypt(deflateRawSync(data), password);
    const nameBuf = Buffer.from(name);
    const aesExtra = Buffer.from([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, 8, 0]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(51, 4);
    local.writeUInt16LE(1, 6); // encrypted
    local.writeUInt16LE(99, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(aesExtra.length, 28);
    locals.push(local, nameBuf, aesExtra, body);
    // The central record claims overflow so sizes and offset come from Zip64.
    const zip64 = Buffer.alloc(4 + 24);
    zip64.writeUInt16LE(1, 0);
    zip64.writeUInt16LE(24, 2);
    zip64.writeBigUInt64LE(BigInt(data.length), 4);
    zip64.writeBigUInt64LE(BigInt(body.length), 12);
    zip64.writeBigUInt64LE(BigInt(offset), 20);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(51, 4);
    central.writeUInt16LE(51, 6);
    central.writeUInt16LE(1, 8);
    central.writeUInt16LE(99, 10);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(zip64.length + aesExtra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    centrals.push(central, nameBuf, zip64, aesExtra);
    offset += 30 + nameBuf.length + aesExtra.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd64 = Buffer.alloc(56);
  eocd64.writeUInt32LE(0x06064b50, 0);
  eocd64.writeBigUInt64LE(44n, 4);
  eocd64.writeBigUInt64LE(BigInt(files.length), 24);
  eocd64.writeBigUInt64LE(BigInt(files.length), 32);
  eocd64.writeBigUInt64LE(BigInt(cd.length), 40);
  eocd64.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + cd.length), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([...locals, cd, eocd64, locator, eocd]);
}

async function settle(jobs, id) {
  const job = jobs.get(id);
  while (job.status === 'running') await new Promise((r) => setTimeout(r, 20));
  return job;
}

async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-qs-'));
  const workspace = new ToolsWorkspace({ dataDir: tmp });
  await workspace.init();
  const jobs = new JobRegistry();
  return { tmp, jobs, service: new QuicksetService({ workspace, jobs }) };
}

test('quickset dump: COPY escapes, skipped tables, secret columns, blob spool', async () => {
  assert.equal(unescapeField('a\\tb\\\\c'), 'a\tb\\c');
  assert.equal(unescapeField('\\N'), null);
  assert.deepEqual(parseSettingLine('OUT101,"52A"'), ['OUT101', '52A']);
  assert.equal(parseSettingLine('; comment'), null);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'projector-qs-'));
  try {
    // Odd chunk sizes split lines and the skip marker across seams.
    const dump = Buffer.from(makeDump());
    const chunks = [];
    for (let i = 0; i < dump.length; i += 7) chunks.push(dump.subarray(i, i + 7));
    const { tables, blobs } = await parseDump(Readable.from(chunks), { blobDir: tmp });
    assert.equal(tables['notif.notification'], undefined);
    assert.equal(tables['public.device'].rows.length, 2);
    assert.equal(tables['public.location'].rows[1].location_name, 'North\tSub');
    assert.equal(tables['public.communication_channel'].rows[0].ftp_password_id, null);
    assert.deepEqual([...blobs], ['900']);
    assert.equal((await stat(path.join(tmp, '900.zip'))).isFile(), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('quickset service: encrypted Zip64 backup read in place, outputs, extract', async () => {
  const { tmp, jobs, service } = await setup();
  try {
    const backup = path.join(tmp, 'backup.zip');
    await writeFile(backup, aesZip([
      { name: 'DBRoles.dump', data: Buffer.from('-- roles\n') },
      { name: 'DMData.dump', data: Buffer.from(makeDump()) },
    ], 'pw'));

    await assert.rejects(service.start({ name: 'backup.zip', password: '', absolute: backup }), /password/);

    const wrong = await service.start({ name: 'backup.zip', password: 'nope', absolute: backup });
    const failed = await settle(jobs, wrong.job);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /wrong backup password/);

    const { run, job } = await service.start({ name: 'backup.zip', password: 'pw', absolute: backup });
    const done = await settle(jobs, job);
    assert.equal(done.status, 'done', done.error);

    const result = await service.result(run);
    assert.equal(result.rows.length, 2);
    assert.equal(result.withSettings, 1);
    const relay = result.rows.find((r) => r.device === 'FDR1 Direct');
    assert.equal(relay.folder, 'Plant / North\tSub');
    assert.equal(relay.viaParent, 'RTAC-1');
    assert.equal(relay.ipAddress, '10.1.1.5');
    assert.equal(relay.inService, 'Yes');

    const dir = path.join(tmp, 'tools', 'quickset', run);
    const devicesCsv = await readFile(path.join(dir, 'devices.csv'), 'utf8');
    assert.match(devicesCsv, /SEL-751A-R100/); // FID filled from Cfg.txt
    assert.doesNotMatch(devicesCsv, /SECRET/);
    assert.match(await readFile(path.join(dir, 'network.csv'), 'utf8'), /10\.1\.1\.5,255\.255\.255\.0/);
    assert.match(await readFile(path.join(dir, 'collection.csv'), 'utf8'), /LER/);
    const viewer = await readFile(await service.viewerFile(run, 'viewer.html'), 'utf8');
    assert.match(viewer, /FDR1 Direct/);
    assert.match(viewer, /"IPADDR":"10\.1\.1\.5"/); // setting names pass through unchanged
    assert.equal(result.folders, 2);
    assert.match(await readFile(await service.viewerFile(run, 'viewer_data/50.js'), 'utf8'), /^QSV_LOADED\("50",/);
    for (const report of result.reports) {
      assert.equal((await stat(path.join(dir, report.path))).isFile(), true, report.path);
    }
    await assert.rejects(stat(path.join(dir, '.blobs')));

    const extract = await service.extract(run, ['OUT101', 'IPADDR']);
    assert.equal(extract.hits, 2);
    assert.deepEqual(extract.columns.slice(-2), ['OUT101', 'IPADDR']);
    assert.equal(extract.rows.find((r) => r.file === 'set_G.txt').group, 'Global');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('quickset service: browser path — locate asks for bytes, then the slice is fed', async () => {
  const { tmp, jobs, service } = await setup();
  try {
    const zip = aesZip([{ name: 'DMData.dump', data: Buffer.from(makeDump()) }], 'pw');
    // Only the last bytes at first: the directory sits outside them.
    const tail = { start: zip.length - 22, buffer: zip.subarray(zip.length - 22) };
    const first = await service.locate({ name: 'backup.zip', size: zip.length, ranges: [tail] });
    assert.ok(first.need);
    const more = { start: first.need.start, buffer: zip.subarray(first.need.start, first.need.end) };
    let located = await service.locate({ name: 'backup.zip', size: zip.length, ranges: [tail, more] });
    while (located.need) {
      const extra = { start: located.need.start, buffer: zip.subarray(located.need.start, located.need.end) };
      located = await service.locate({ name: 'backup.zip', size: zip.length, ranges: [tail, more, extra] });
    }
    assert.equal(located.kind, 'zip');
    assert.equal(located.encrypted, true);

    const { run, job } = await service.start({ name: 'backup.zip', password: 'pw', located });
    const slice = zip.subarray(located.range.start, located.range.end);
    await service.feed(run, Readable.from([slice.subarray(0, 100), slice.subarray(100)]));
    const done = await settle(jobs, job);
    assert.equal(done.status, 'done', done.error);
    assert.equal((await service.result(run)).rows.length, 2);

    // A bare dump needs no ZIP at all.
    const bare = await service.locate({ name: 'DMData.dump', size: 10, ranges: [] });
    assert.equal(bare.kind, 'dump');
    await assert.rejects(service.feed('no-such-run', Readable.from([])), /no read waiting/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('quickset service: a bare dump fed from a stream that is already full loses nothing', async () => {
  const { tmp, jobs, service } = await setup();
  try {
    const dump = Buffer.from(makeDump({ twin: true }));
    const located = await service.locate({ name: 'DMData.dump', size: dump.length, ranges: [] });
    const { run, job } = await service.start({ name: 'DMData.dump', password: '', located });
    const stream = new PassThrough();
    stream.end(dump); // every byte buffered before the job starts reading
    await service.feed(run, stream);
    const done = await settle(jobs, job);
    assert.equal(done.status, 'done', done.error);
    const result = await service.result(run);
    assert.equal(result.rows.length, 3);

    // Two devices with one name in one folder keep separate settings folders.
    const { devices } = JSON.parse(await readFile(path.join(tmp, 'tools', 'quickset', run, 'devices.json'), 'utf8'));
    const folders = devices.filter((d) => d.device === 'FDR1 Direct').map((d) => d.settingsFolder);
    assert.equal(folders.length, 2);
    assert.notEqual(folders[0], folders[1]);
    assert.ok(folders.every(Boolean));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
