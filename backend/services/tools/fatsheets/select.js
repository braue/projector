// Which tests get a column.
//
// The fault and open phase sheets are filled as a pair: each segment (fault
// location) of the system under test gets one fault test and one open phase
// test, both from the same starting configuration, so FT-n and OP-n are
// always the same segment run the same way. A segment that doesn't have both
// kinds in one configuration is left off both sheets and reported instead.
// When a segment has more than one configuration to choose from, the pair
// that restored load wins — a test whose "open points closed" row would read
// "None" only when nothing better exists — then the cleaner results, the most
// switching, report order.
//
// The miscoordination and abnormal checkouts are done once per feeder, so
// each of those sheets takes one test per feeder — the one with the most
// switching, the most interesting for the customer to read. An abnormal test
// re-runs a fault-sheet test with one device abnormal, so it is picked only
// from the AbnormalFaultLo tests whose baseline (same trip, location and
// starting configuration) got a column on the fault sheet; a feeder with none
// is left off the abnormal sheet.

import { baselineOf } from './columns.js';

const STATUS_RANK = { Complete: 0, Questionable: 1 };
const statusRank = (test) => STATUS_RANK[test.status] ?? 2;

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
  return switchCount(b) - switchCount(a) || statusRank(a) - statusRank(b) || a.index - b.index;
}

/** Restored something first, then as `better`. */
function betterSegment(a, b) {
  return restored(b) - restored(a) || better(a, b);
}

/** The same comparison over a fault + open phase pair, summed. */
function betterPair([fa, oa], [fb, ob]) {
  return (restored(fb) + restored(ob)) - (restored(fa) + restored(oa))
    || (statusRank(fa) + statusRank(oa)) - (statusRank(fb) + statusRank(ob))
    || (switchCount(fb) + switchCount(ob)) - (switchCount(fa) + switchCount(oa))
    || Math.min(fa.index, oa.index) - Math.min(fb.index, ob.index);
}

function groupBy(tests, key) {
  const groups = new Map();
  for (const test of tests) {
    if (!groups.has(key(test))) groups.set(key(test), []);
    groups.get(key(test)).push(test);
  }
  return groups;
}

const setupKey = (t) => [[...t.setupOpen].sort().join(','), [...t.setupClose].sort().join(',')].join('|');

/**
 * The paired fault + open phase sheets. Returns { fault, openPhase, unpaired }:
 * fault in report order, openPhase in the order of the fault test it pairs
 * with, and unpaired = [{ location, feeders, reason, tests }] for each segment
 * left off, reason 'fault only' / 'open phase only' / 'no shared configuration'.
 */
function pairSegments(faultTests, openPhaseTests) {
  const bySegment = groupBy([...faultTests, ...openPhaseTests], (t) => t.location);
  const pairs = [];
  const unpaired = [];
  for (const [location, group] of bySegment) {
    const candidates = [];
    for (const config of groupBy(group, setupKey).values()) {
      const faults = config.filter((t) => t.kind === 'fault').sort(betterSegment);
      const openPhases = config.filter((t) => t.kind === 'openPhase').sort(betterSegment);
      if (faults.length && openPhases.length) candidates.push([faults[0], openPhases[0]]);
    }
    if (candidates.length) {
      pairs.push(candidates.sort(betterPair)[0]);
      continue;
    }
    const kinds = new Set(group.map((t) => t.kind));
    unpaired.push({
      location,
      feeders: [...new Set(group.map((t) => t.feeder))],
      reason: kinds.size > 1 ? 'no shared configuration' : kinds.has('fault') ? 'fault only' : 'open phase only',
      tests: group.map((t) => t.index).sort((a, b) => a - b),
    });
  }
  pairs.sort(([a], [b]) => a.index - b.index);
  return { fault: pairs.map(([f]) => f), openPhase: pairs.map(([, o]) => o), unpaired };
}

/** One test per feeder; the abnormal sheet only re-runs of `faultSheet` tests. */
function onePerFeeder(kind, tests, faultSheet) {
  const picked = new Set();
  for (const group of groupBy(tests, (t) => t.feeder).values()) {
    const candidates = kind === 'abnormal'
      ? group.filter((t) => t.baseKind === 'fault' && baselineOf(t, faultSheet))
      : group;
    if (candidates.length) picked.add([...candidates].sort(better)[0]);
  }
  return tests.filter((t) => picked.has(t));
}

/**
 * Every sheet's tests from the report's. Returns { fault, openPhase,
 * miscoordination, abnormal, unpaired, abnormalUnmatched } — abnormalUnmatched
 * being the feeders with abnormal tests, none of which re-runs a fault-sheet test.
 */
function selectSheets(tests) {
  const ofKind = (kind) => tests.filter((t) => t.kind === kind);
  const { fault, openPhase, unpaired } = pairSegments(ofKind('fault'), ofKind('openPhase'));
  const abnormal = onePerFeeder('abnormal', ofKind('abnormal'), fault);
  const onAbnormal = new Set(abnormal.map((t) => t.feeder));
  return {
    fault,
    openPhase,
    miscoordination: onePerFeeder('miscoordination', ofKind('miscoordination')),
    abnormal,
    unpaired,
    abnormalUnmatched: [...new Set(ofKind('abnormal').map((t) => t.feeder))].filter((f) => !onAbnormal.has(f)),
  };
}

export { selectSheets, switchCount };
