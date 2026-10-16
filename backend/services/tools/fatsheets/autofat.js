// Reads the DAC simulator's automatic-FAT report — the "Aggregate - Results"
// HTML the test runner saves — into one record per test.
//
// What the report holds (verified against a 333-test Eunice 35kV run):
//   * "Summary": two tables, the plain tests and the Abnormal* ones (the
//     latter add "Abnormal Device"). Fault Type is FaultLo / OpenPhase /
//     Miscoordination, or the same with an "Abnormal" prefix.
//   * "Switching Summary": per test, what actually operated — Setup Open /
//     Setup Close (the test's starting configuration), Open, Close, and
//     Open -> Closed / Closed -> Opened for devices that went both ways.
//   * One section per test, id "<feeder>-<type>-<index>", holding three
//     tables: the validation result (groups like "R3170-IsoFltDwn" with the
//     expected/actual switch states under them), the SOE, and the scripted
//     sequence (which is where an abnormal test sets "<dev>.Alarms.Reclose").
//
// Device names carry a terminal suffix in places (".A" source side, ".B"
// load side); the FAT sheets use bare names.

// --- html text -----------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function textOf(html) {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Every table in `html` as { headers, rows: [{ cells, className }] }. */
function tables(html) {
  const out = [];
  for (const m of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const inner = m[1];
    const headers = [...inner.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((h) => textOf(h[1]));
    const rows = [];
    for (const tr of inner.matchAll(/<tr\b([^>]*)>([\s\S]*?)(?=<tr\b|$)/gi)) {
      const cells = [...tr[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((td) => textOf(td[1]));
      if (!cells.length) continue;
      const className = /class="([^"]*)"/.exec(tr[1])?.[1] ?? '';
      rows.push({ cells, className });
    }
    out.push({ headers, rows });
  }
  return out;
}

function records(table) {
  return table.rows.map(({ cells }) => Object.fromEntries(table.headers.map((h, i) => [h, cells[i] ?? ''])));
}

function hasHeaders(table, wanted) {
  return wanted.every((h) => table.headers.includes(h));
}

// --- devices -----------------------------------------------------------------

function bareDevice(name) {
  return String(name ?? '').trim().replace(/\.[A-Z]$/i, '');
}

/** "B3161 , R3173" → ['B3161', 'R3173'] (bare, de-duplicated, in order). */
function deviceList(text) {
  return [...new Set(String(text ?? '').split(',').map(bareDevice).filter(Boolean))];
}

// --- the report ---------------------------------------------------------------

const KIND_OF = {
  FaultLo: 'fault',
  OpenPhase: 'openPhase',
  Miscoordination: 'miscoordination',
};

/** "2026/10/07 14:15:15.572" → { y, m, d } (null when unparseable). */
function datePart(text) {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(text ?? '').trim());
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

/**
 * The per-test detail section: validation groups and failures, whether the
 * SOE shows the DAC declaring an event, and abnormal conditions the sequence
 * applied.
 */
function readSection(sectionHtml) {
  const detail = { groups: [], failures: [], eventSeen: false, alarms: [], validated: new Set() };
  for (const table of tables(sectionHtml)) {
    if (hasHeaders(table, ['ID', 'Sequence', 'Fail Reason', 'Expected', 'Actual'])) {
      for (const { cells: [id, , reason, expected, actual] } of table.rows) {
        const group = /^([A-Z]+\d+[A-Z]?)-([A-Za-z-]+)$/.exec(id);
        if (group) {
          detail.groups.push({ device: group[1], action: group[2] });
          continue;
        }
        if (!id.includes('.')) continue;
        detail.validated.add(id.split('.')[0]);
        if (reason && reason !== 'None') detail.failures.push({ point: id, reason, expected, actual });
      }
    } else if (hasHeaders(table, ['RootTag', 'PointId', 'Value'])) {
      for (const { cells: [tag, , value] } of table.rows) {
        if (/\.Event$/.test(tag) && value === 'TRUE') detail.eventSeen = true;
      }
    } else if (hasHeaders(table, ['ID', 'Sequence', 'Action', 'Value'])) {
      for (const { cells: [id, , action, value] } of table.rows) {
        const alarm = /^([A-Z]+\d+[A-Z]?)\.Alarms\.(\w+)$/.exec(id);
        if (alarm && action === 'Set' && value === 'TRUE') detail.alarms.push({ device: alarm[1], alarm: alarm[2] });
      }
    }
  }
  return detail;
}

/**
 * Parse the report. Returns { title, tests } with tests in report (index)
 * order:
 *   { index, id, type, kind, abnormal, status, failReason, feeder, trip,
 *     location, abnormalDevice, date, setupOpen[], setupClose[], open[],
 *     close[], openClosed[], closedOpened[], groups[], failures[],
 *     eventSeen, alarms[], validated:Set }
 */
function parseAutoFat(html) {
  const text = String(html);
  const title = textOf(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1] ?? '');

  // The summary tables sit before the first per-test section.
  const firstSection = text.search(/<h2\b[^>]*id="[^"]*-\d+-header"/i);
  const head = firstSection > 0 ? text.slice(0, firstSection) : text;
  const headTables = tables(head);
  const summaries = headTables.filter((t) => hasHeaders(t, ['Fault Type', 'Index', 'Status', 'Feeder', 'Trip Device', 'Fault Location']));
  const switching = headTables.find((t) => hasHeaders(t, ['Index', 'Setup Open', 'Setup Close', 'Open', 'Close']));
  if (!summaries.length || !switching) {
    throw new Error('not an automatic-FAT report: no Summary / Switching Summary tables found');
  }
  const switched = new Map(records(switching).map((r) => [r.Index, r]));

  // Per-test sections, keyed by their trailing index.
  const sections = new Map();
  const marks = [...text.matchAll(/<h2\b[^>]*id="([^"]*?-(\d+))-header"[^>]*>/gi)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    sections.set(m[2], text.slice(m.index, end));
  });

  const tests = [];
  for (const row of summaries.flatMap(records)) {
    const rawType = row['Fault Type'];
    const abnormal = rawType.startsWith('Abnormal');
    const type = abnormal ? rawType.slice('Abnormal'.length) : rawType;
    const baseKind = KIND_OF[type];
    if (!baseKind) continue;
    const sw = switched.get(row.Index) ?? {};
    const section = sections.get(row.Index);
    const detail = section ? readSection(section) : readSection('');
    tests.push({
      index: Number(row.Index),
      id: sw.ID ?? '',
      type,
      kind: abnormal ? 'abnormal' : baseKind,
      baseKind,
      abnormal,
      status: row.Status,
      failReason: row['Fail Reason'] && row['Fail Reason'] !== 'None' ? row['Fail Reason'] : '',
      feeder: row.Feeder,
      trip: bareDevice(row['Trip Device']),
      location: bareDevice(row['Fault Location']),
      abnormalDevice: bareDevice(row['Abnormal Device']),
      date: datePart(row['Start Time']),
      setupOpen: deviceList(sw['Setup Open']),
      setupClose: deviceList(sw['Setup Close']),
      open: deviceList(sw.Open),
      close: deviceList(sw.Close),
      openClosed: deviceList(sw['Open -> Closed']),
      closedOpened: deviceList(sw['Closed -> Opened']),
      ...detail,
    });
  }
  tests.sort((a, b) => a.index - b.index);
  return { title, tests };
}

export { bareDevice, deviceList, parseAutoFat };
