// Which tests get a column. The fault and open phase sheets take every test
// in the report that closed something to restore load — one whose "open
// points closed" row would read "None" restored nothing and is left off,
// unless it didn't pass cleanly (Questionable or failed) — then it stays,
// for the engineer to review.
// The miscoordination and abnormal checkouts are done once per
// feeder, so each of those sheets takes one test per feeder — the one with
// the most switching, the most interesting for the customer to read. Abnormal
// tests are picked from the fault ones (AbnormalFaultLo); a feeder with no
// abnormal fault test falls back to its other abnormal tests.

const ONE_PER_FEEDER = new Set(['miscoordination', 'abnormal']);
const NEEDS_RESTORATION = new Set(['fault', 'openPhase']);
const STATUS_RANK = { Complete: 0, Questionable: 1 };

/** Device operations the test saw; a device that went both ways counts twice. */
function switchCount(test) {
  return test.open.length + test.close.length + 2 * (test.openClosed.length + test.closedOpened.length);
}

/** Did the test close anything? The same devices columns.js lists as closed. */
function restored(test) {
  return test.close.length + test.openClosed.length + test.closedOpened.length > 0;
}

/** Most switching, then the cleaner result, then report order. */
function better(a, b) {
  return switchCount(b) - switchCount(a)
    || (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2)
    || a.index - b.index;
}

function pickFor(kind, tests) {
  const candidates = kind === 'abnormal' && tests.some((t) => t.baseKind === 'fault')
    ? tests.filter((t) => t.baseKind === 'fault')
    : tests;
  return [...candidates].sort(better)[0];
}

/** One sheet's tests (report order in, report order out). */
function selectTests(kind, tests) {
  if (NEEDS_RESTORATION.has(kind)) return tests.filter((t) => restored(t) || t.status !== 'Complete');
  if (!ONE_PER_FEEDER.has(kind)) return tests;
  const byFeeder = new Map();
  for (const test of tests) {
    if (!byFeeder.has(test.feeder)) byFeeder.set(test.feeder, []);
    byFeeder.get(test.feeder).push(test);
  }
  const picked = new Set([...byFeeder.values()].map((group) => pickFor(kind, group)));
  return tests.filter((t) => picked.has(t));
}

export { selectTests, switchCount };
