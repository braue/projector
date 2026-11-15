// SCADA map blocks for new devices. A CLECO SCADA map (DMS_MAP_DNP,
// DMS_POINTS_DNP, …_ONE/_TWO) is a DNP tag list holding one block of points
// per device, named by a group prefix: SEL_651R2_6268_BI_00000_RECLOSER_STATUS,
// FDR_6421A_BI_00000_Armed, BKR_5444A_BO_00000_Inhibit_CMD.status,
// F5905A_Conn_BI_00000_Abnormal, Bunkie_Lecompte_BI_00000_CommFail. Every
// addition in the scheme history copies a block already on the map, renames
// it and numbers its points after the last point on each page, so this does
// the same:
//
//  - feeders, breakers, connectors and managers have one block layout per map
//    (every scheme), so the template is the last block of that kind.
//  - recloser blocks vary with the relay's DNP layout, so the template is the
//    recloser whose client carries the same points, nearest first (same
//    circuit folder, then anywhere). Across the corpus that pick matches 99%
//    of rows (82% of recloser blocks exactly); the rest differ in spare labels.
//
// Point numbers keep the template's spacing (a Binary Output point is six
// rows: .status, .operPulse, …), starting one past the page's highest point,
// and the page's AddItems ranges grow to cover them.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { planConnectors } from './connectors.js';
import { clientStruct, feederScada, parseTag, recloserField, recloserScada } from './project.js';
import { breakerKind } from './resolve.js';

const SECTIONS = { 'Binary Inputs': 'BI', 'Analog Inputs': 'AI', 'Binary Outputs': 'BO' };
const lower = (s) => String(s ?? '').toLowerCase();

// --- reading ----------------------------------------------------------------

/** A map's pages, rows and blocks, with offsets into its text. */
function readMap(xml) {
  const pages = [];
  const page = /<SettingPage>\s*<Name>([^<]*)<\/Name>[\s\S]*?<\/SettingPage>/g;
  for (let m = page.exec(xml); m; m = page.exec(xml)) {
    const rows = [];
    const row = /[ \t]*<Row>[\s\S]*?<\/Row>\r?\n?/g;
    const text = m[0];
    for (let r = row.exec(text); r; r = row.exec(text)) {
      const tag = /<Column>Tag Name<\/Column>\s*<Value>([^<]*)<\/Value>/.exec(r[0])?.[1] ?? '';
      const point = Number(/<Column>Point Number<\/Column>\s*<Value>(\d+)<\/Value>/.exec(r[0])?.[1]);
      rows.push({ start: m.index + r.index, end: m.index + r.index + r[0].length, text: r[0], tag, point, parsed: parseTag(tag) });
    }
    pages.push({ name: m[1], start: m.index, end: m.index + text.length, text, rows });
  }
  const blocks = new Map(); // lowercased group -> { group, struct, order, rows }
  let order = 0;
  for (const p of pages) {
    for (const row of p.rows) {
      const group = row.parsed?.group;
      if (!group) continue;
      const key = lower(group);
      let block = blocks.get(key);
      if (!block) {
        block = { group, struct: row.parsed.struct, order: order++, rows: [] };
        blocks.set(key, block);
      }
      block.rows.push({ page: p.name, row });
    }
  }
  return { pages, blocks };
}

/** What kind of device a map block is for. */
function blockKind(block) {
  const g = block.group.replace(/_$/, '');
  const first = block.rows[0]?.row.parsed.member ?? '';
  if (/_Abnormal$/i.test(first) && /conn/i.test(g)) return 'connector';
  if (/_CommFail$/i.test(first)) return 'manager';
  if (/^dac$/i.test(g)) return 'dac';
  if (/^(fdr|feeder)_/i.test(g)) return 'feeder';
  if (/^(bkr|brk)_/i.test(g)) return 'breaker';
  if (numberTokens(g).length === 1) return 'recloser';
  return 'other';
}

/** The parts of a group name that are device numbers ("6315", "R042", "6421A"). */
function numberTokens(group) {
  return group.replace(/_$/, '').split('_').filter((t) => /^R?\d{3,}[A-Z]?$/i.test(t));
}

/** A template group renamed for device `number`: SEL_651R2_6315_ -> SEL_651R2_6268_. */
function renumber(group, number) {
  const parts = group.replace(/_$/, '').split('_');
  const n = String(number).replace(/^[RFB]/i, '');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const m = /^(R?)(\d{3,}[A-Z]?)$/i.exec(parts[i]);
    if (m) { parts[i] = m[1] + n; return `${parts.join('_')}_`; }
  }
  return null;
}

// --- writing ----------------------------------------------------------------

/**
 * Copy `template`'s rows as group `group`, numbered after each page's last
 * point. Returns the new map text and the tags added, by section.
 */
function cloneBlock(xml, map, template, group) {
  const byPage = new Map();
  for (const { page, row } of template.rows) {
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(row);
  }
  const edits = [];
  const tags = { BI: [], AI: [], BO: [] };
  for (const p of map.pages) {
    const rows = byPage.get(p.name);
    if (!rows?.length) continue;
    const next = Math.max(-1, ...p.rows.map((r) => r.point).filter(Number.isFinite)) + 1;
    const low = Math.min(...rows.map((r) => r.point));
    const high = Math.max(...rows.map((r) => r.point));
    const from = `${template.struct}.${template.group}`;
    const to = `${template.struct}.${group}`;
    const made = rows.map((r) => r.text
      .replace(`<Value>${from}`, `<Value>${to}`)
      .replace(/(<Column>Point Number<\/Column>\s*<Value>)\d+(<\/Value>)/, `$1${next + r.point - low}$2`));
    for (const r of rows) {
      const tag = parseTag(r.tag.replace(from, to));
      if (tag && SECTIONS[p.name]) tags[SECTIONS[p.name]].push(tag);
    }
    // The page's AddItems: the range ending at `next` grows, else a new one.
    const head = p.text;
    const span = high - low + 1;
    const ranges = [...head.matchAll(/<AddItems>\s*<Start>(\d+)<\/Start>\s*<Quantity>(\d+)<\/Quantity>\s*<\/AddItems>/g)];
    const touching = ranges.find((r) => Number(r[1]) + Number(r[2]) === next);
    if (touching) {
      const grown = touching[0].replace(/<Quantity>\d+<\/Quantity>/, `<Quantity>${Number(touching[2]) + span}</Quantity>`);
      edits.push({ start: p.start + touching.index, end: p.start + touching.index + touching[0].length, text: grown });
    } else if (ranges.length) {
      const last = ranges[ranges.length - 1];
      const indent = /([ \t]*)$/.exec(head.slice(0, last.index))[1];
      const added = last[0].replace(/<Start>\d+<\/Start>/, `<Start>${next}</Start>`)
        .replace(/<Quantity>\d+<\/Quantity>/, `<Quantity>${span}</Quantity>`);
      const at = p.start + last.index + last[0].length;
      edits.push({ start: at, end: at, text: `\n${indent}${added}` });
    }
    const at = p.rows[p.rows.length - 1].end;
    edits.push({ start: at, end: at, text: made.join('') });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { xml: out, tags };
}

// --- choosing ---------------------------------------------------------------

/** The point names a recloser's client gives it, without its group prefix. */
function clientShape(project, number, client) {
  const located = recloserField(project, number, client || null);
  if (located.problem) return null;
  const { entry, prefixes } = located;
  const keys = new Set(prefixes.map(lower));
  const names = [];
  for (const section of ['BI', 'AI', 'BO']) {
    for (const tag of entry.sections[section]) {
      if (tag.group == null || !keys.has(lower(tag.group))) continue;
      names.push(`${section}:${tag.member.slice(tag.group.length).replace(/\..*$/, '')}`);
    }
  }
  return { key: [...new Set(names)].sort().join('|'), folder: path.dirname(entry.file) };
}

/**
 * The block a new device's block is copied from, among `blocks` ({ map, block,
 * kind }): for a recloser, the latest whose client carries the same points in
 * the same circuit folder, then anywhere, then the latest in its folder; for
 * anything else the latest of its kind on its substation's map.
 */
function chooseTemplate(blocks, want, project, shapeOf, mapForFolder) {
  const candidates = blocks.filter((c) => c.kind === want.kind);
  const latest = (list) => list.sort((a, b) => b.block.order - a.block.order)[0] ?? null;
  if (want.kind === 'recloser') {
    const own = clientShape(project, want.number, want.client);
    const ranked = candidates.filter((c) => shapeOf(c.block));
    const pick = (own && (latest(ranked.filter((c) => shapeOf(c.block).key === own.key && shapeOf(c.block).folder === own.folder))
      ?? latest(ranked.filter((c) => shapeOf(c.block).key === own.key))
      ?? latest(ranked.filter((c) => shapeOf(c.block).folder === own.folder))))
      ?? latest(candidates.slice());
    return { pick, unknownClient: !own };
  }
  const home = mapForFolder(want.folder);
  const onHome = home ? candidates.filter((c) => c.map === home) : [];
  return { pick: latest(onHome.length ? onHome : candidates) };
}

/**
 * Add SCADA map blocks for new devices. `wants`: [{ kind: 'recloser' |
 * 'feeder' | 'breaker' | 'connector' | 'manager', name, number?, client?,
 * group?, folder? }] — reclosers, feeders and breakers are named from their
 * number, connectors and managers carry their group. The project's struct
 * index is updated in place, so the pointer lookups that follow find the new
 * points. Returns { added: [{ name, map, group, template, points }], problems }.
 */
async function addScadaBlocks(rtacDir, project, wants) {
  const added = [];
  const problems = [];
  if (!wants.length) return { added, problems };
  const entries = project.structs.filter((e) => e.kind === 'map');
  const files = [...new Set(entries.map((e) => e.file))];
  const maps = [];
  for (const file of files) {
    const xml = await readFile(path.join(rtacDir, file), 'utf8');
    maps.push({ file, xml, ...readMap(xml), dirty: false });
  }
  const all = () => maps.flatMap((m) => [...m.blocks.values()].map((b) => ({ map: m, block: b, kind: blockKind(b) })));
  const has = (group) => maps.some((m) => m.blocks.has(lower(group)));

  // Recloser shapes, by the client each existing recloser block belongs to.
  const shapes = new Map();
  const shapeOf = (block) => {
    if (!shapes.has(block)) {
      const [n] = numberTokens(block.group);
      shapes.set(block, n ? clientShape(project, n.replace(/^R/i, ''), null) : null);
    }
    return shapes.get(block);
  };

  // Where a substation's devices go: the map carrying most of the reclosers
  // whose clients sit under that substation's folder.
  const mapForFolder = (folder) => {
    if (!folder) return null;
    const tally = new Map();
    for (const c of all().filter((c) => c.kind === 'recloser')) {
      const shape = shapeOf(c.block);
      if (shape && (shape.folder === folder || shape.folder.startsWith(`${folder}${path.sep}`))) {
        tally.set(c.map, (tally.get(c.map) ?? 0) + 1);
      }
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  for (const want of wants) {
    const { pick, unknownClient } = chooseTemplate(all(), want, project, shapeOf, mapForFolder);
    let group = want.group ?? null;
    if (unknownClient) problems.push({ device: want.name, message: `SCADA map: no DNP client carries its points; block copied from ${pick?.block.group.replace(/_$/, '') ?? 'nothing'}` });
    if (!pick) {
      if (want.kind !== 'breaker') problems.push({ device: want.name, message: `SCADA map: no ${want.kind} block to copy; points not added` });
      continue;
    }
    group = group ?? renumber(pick.block.group, want.number);
    if (!group) {
      problems.push({ device: want.name, message: `SCADA map: can't name its block from ${pick.block.group}` });
      continue;
    }
    if (has(group)) continue;

    const { map, block } = pick;
    const { xml, tags } = cloneBlock(map.xml, map, block, group);
    map.xml = xml;
    Object.assign(map, readMap(xml));
    map.dirty = true;
    const entry = entries.find((e) => lower(e.struct) === lower(block.struct));
    for (const [section, list] of Object.entries(tags)) entry.sections[section].push(...list);
    const count = Object.values(tags).reduce((n, list) => n + list.length, 0);
    added.push({ name: want.name, map: block.struct, group: group.replace(/_$/, ''), template: block.group.replace(/_$/, ''), points: count });
  }

  for (const map of maps) if (map.dirty) await writeFile(path.join(rtacDir, map.file), map.xml);
  return { added, problems };
}

/**
 * The blocks a run's NEW devices need: each recloser, feeder and breaker the
 * maps don't carry yet, each connector, and each manager a connector brings.
 * `known(name)` says whether the project already has a device.
 */
function scadaWants(payload, project, family, known) {
  const text = (v) => String(v ?? '').trim();
  const wants = [];
  for (const row of payload.reclosers ?? []) {
    const n = text(row.number);
    if (!n || known(`R${n}`) || !recloserScada(project, n).problem?.startsWith('no SCADA map')) continue;
    wants.push({ kind: 'recloser', name: `R${n}`, number: n, client: text(row.dnpClient) || null });
  }
  for (const row of payload.feedersBreakers ?? []) {
    const n = text(row.number);
    if (!n || known(`F${n}`)) continue;
    const client = clientStruct(project, text(row.dnpClient));
    const folder = client ? path.dirname(client.file) : null;
    if (!feederScada(project, n).bi) wants.push({ kind: 'feeder', name: `F${n}`, number: n, folder });
    if (/^[36]51R$/.test(breakerKind(row, family))) wants.push({ kind: 'breaker', name: `B${n}`, number: n, folder });
  }
  const { plans } = planConnectors(payload.connectors ?? [], project, family);
  for (const plan of plans) {
    if (known(plan.name)) continue;
    wants.push({ kind: 'connector', name: plan.name, group: `${plan.name}_` });
    if (plan.newManager) wants.push({ kind: 'manager', name: plan.manager.name, group: `${plan.manager.group}_` });
  }
  return wants;
}

export { addScadaBlocks, scadaWants, chooseTemplate, readMap, blockKind, renumber, cloneBlock, clientShape };
