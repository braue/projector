// One automatic-FAT test → the answers in its checkout-sheet column, keyed
// by the layout's row names. The phrasing follows a hand-completed FAT:
//   * configuration "Normal Configuration" / "Move open point from X to Y" /
//     "Open X and Y, close Z";
//   * event location "Downstream <device>" ("…\nLockout <device>" for a
//     miscoordination);
//   * opened/closed device lists, comma-separated, "None" when empty, with
//     the sheets' footnote marks — fault: "*" opened by protection, "**"
//     closed to correct a miscoordination; miscoordination: "*" closed to
//     correct it.
//
// Every answer is read from the report, never assumed: switching comes from
// the Switching Summary, YES/NO from the test's status and its validation
// groups. What the report cannot answer — Return to Normal (the automatic
// run never exercises it) — is left blank for the engineer.

const PASSED = new Set(['Complete', 'Questionable']);

function listPhrase(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function configuration(test) {
  const { setupOpen: open, setupClose: close } = test;
  if (!open.length && !close.length) return 'Normal Configuration';
  if (open.length === 1 && close.length === 1) return `Move open point from ${close[0]} to ${open[0]}`;
  const parts = [];
  if (open.length) parts.push(`Open ${listPhrase(open)}`);
  if (close.length) parts.push(`${parts.length ? 'close' : 'Close'} ${listPhrase(close)}`);
  return parts.join(', ');
}

function location(test, kind = test.baseKind) {
  if (kind === 'miscoordination') return `Downstream ${test.location}\nLockout ${test.trip}`;
  return `Downstream ${test.location}`;
}

function joined(names) {
  return names.length ? names.join(', ') : 'None';
}

/** Unique names, in first-seen order. */
function unique(names) {
  return [...new Set(names.filter(Boolean))];
}

/**
 * The devices protection opened, in the order the event went. The SOE says
 * which locked out, and every one of them counts; a report without lockout rows falls back to the trip
 * device plus every "Open -> Closed" device. The summary's Trip Device alone
 * is not enough: for a fault past a switch it names the switch, which the
 * DAC opened to isolate, while the recloser upstream did the tripping.
 */
function protectionOpened(test, operatedOpen) {
  // A lockout is an open even when the Switching Summary leaves the device
  // out — a pseudo-breaker (DA_PSEUDO_BKR) has no status of its own, the DAC
  // predicts it from the first device downstream.
  if (test.lockouts?.length) return unique(test.lockouts);
  return unique([...(operatedOpen.includes(test.trip) ? [test.trip] : []), ...test.openClosed]);
}

/**
 * Opened/closed lists. `tripMark` goes on devices protection opened (fault:
 * "*"). `correctedMark` goes on those of them the DAC then closed again —
 * "Open -> Closed" devices — in the closed list ("**" on the fault sheet, "*"
 * on the miscoordination sheet). Protection operations lead the opened list
 * and corrections lead the closed list — the order a reader follows the
 * event in.
 */
function switching(test, { tripMark = '', correctedMark = '' } = {}) {
  const operatedOpen = unique([...test.open, ...test.openClosed, ...test.closedOpened]);
  const byProtection = protectionOpened(test, operatedOpen);
  const corrected = test.openClosed.filter((d) => byProtection.includes(d));
  const opened = [
    ...byProtection.map((d) => `${d}${tripMark}`),
    ...operatedOpen.filter((d) => !byProtection.includes(d)),
  ];
  const closed = [
    ...corrected.map((d) => `${d}${correctedMark}`),
    ...unique([...test.openClosed, ...test.close, ...test.closedOpened]).filter((d) => !corrected.includes(d)),
  ];
  return { opened: joined(opened), closed: joined(closed) };
}

function yesNo(value) {
  return value ? 'YES' : 'NO';
}

/** Did the DAC declare the event? Passing tests did; a failed one did if the SOE shows it. */
function recognized(test) {
  return yesNo(PASSED.has(test.status) || test.eventSeen);
}

function switchFailures(test) {
  return test.failures.filter((f) => /\.SW\.Switch\.Status/.test(f.point));
}

/** "Did the device on the <side> of the fault open to isolate?" from the validation groups. */
function isolated(test, action) {
  const devices = new Set(test.groups.filter((g) => g.action === action).map((g) => g.device));
  if (action === 'IsoFltSrc') {
    // The trip device isolates the source side itself when it is the
    // nearest device upstream; a separate IsoFltSrc group appears otherwise.
    if (!devices.size) return yesNo(test.open.includes(test.trip) || test.openClosed.includes(test.trip));
  } else if (!devices.size) {
    return 'N/A'; // end of the line: nothing downstream to open
  }
  const failed = switchFailures(test).some((f) => devices.has(f.point.split('.')[0]));
  return yesNo(!failed);
}

/** The Comments cell: empty for a clean pass, the reason otherwise. */
function comment(test) {
  if (test.status === 'Complete') return '';
  if (test.status === 'Questionable') {
    return `Automatic FAT: Questionable — review test ${test.index} in the HTML report.`;
  }
  const notOpened = [];
  const notClosed = [];
  const other = [];
  for (const f of test.failures) {
    const device = f.point.split('.')[0];
    if (/\.SW\.Switch\.Status/.test(f.point)) {
      if (f.expected === 'FALSE') notOpened.push(device);
      else if (f.expected === 'TRUE') notClosed.push(device);
    } else if (!/\.Source\.Side$|\.SG\.IsValid$/.test(f.point)) {
      other.push(`${f.point} expected ${f.expected}, was ${f.actual}`);
    }
  }
  const details = [];
  const opens = unique(notOpened);
  const closes = unique(notClosed);
  if (opens.length) details.push(`${listPhrase(opens)} ${test.abnormal ? 'closed' : 'did not open'}`);
  if (closes.length) details.push(`${listPhrase(closes)} ${test.abnormal ? 'opened' : 'did not close'}`);
  details.push(...other.slice(0, 3));
  const reason = test.failReason ? ` (${test.failReason})` : '';
  return `Automatic FAT: ${test.status}${reason}${details.length ? ` — ${details.join('; ')}` : ''}. Test ${test.index} in the HTML report.`;
}

const ALARM_TEXT = { Reclose: 'Reclose Disabled', Remote: 'Remote Disabled' };

function abnormalCondition(test) {
  const alarms = test.alarms.filter((a) => !test.abnormalDevice || a.device === test.abnormalDevice);
  if (!alarms.length) return test.abnormalDevice ? `${test.abnormalDevice} Abnormal` : '';
  return unique(alarms.map((a) => `${a.device} ${ALARM_TEXT[a.alarm] ?? `${a.alarm} alarm`}`)).join('\n');
}

const KIND_LABEL = { fault: 'Fault', openPhase: 'Open Phase', miscoordination: 'Miscoordination' };

/**
 * The plain test an abnormal one re-runs: same event type, trip device,
 * location and starting configuration.
 */
function baselineOf(test, plainTests) {
  const key = (t) => [t.baseKind, t.trip, t.location, [...t.setupOpen].sort(), [...t.setupClose].sort()].join('|');
  const wanted = key(test);
  return plainTests.find((t) => key(t) === wanted) ?? null;
}

/**
 * The column for one test. `context` carries what isn't in the test itself:
 * the engineer's name and, for abnormal tests, the plain tests to find each
 * one's baseline among.
 */
function columnFor(kind, test, { engineer = '', plainTests = [] } = {}) {
  const common = {
    feeder: test.feeder,
    configuration: configuration(test),
    comments: comment(test),
    engineer,
    date: test.date,
  };
  const pass = PASSED.has(test.status);
  switch (kind) {
    case 'fault':
      return {
        ...common,
        location: location(test),
        recognized: recognized(test),
        upstream: isolated(test, 'IsoFltSrc'),
        downstream: isolated(test, 'IsoFltDwn'),
        acceptable: yesNo(pass),
        ...switching(test, { tripMark: '*', correctedMark: '**' }),
        rtn: '',
      };
    case 'openPhase':
      return {
        ...common,
        location: location(test),
        recognized: recognized(test),
        acceptable: yesNo(pass),
        ...switching(test),
      };
    case 'miscoordination':
      return {
        ...common,
        location: location(test),
        recognized: recognized(test),
        acceptable: yesNo(pass),
        ...switching(test, { correctedMark: '*' }),
      };
    case 'abnormal': {
      const baseline = baselineOf(test, plainTests);
      const closedElsewhere = unique(test.close);
      return {
        ...common,
        abnormal: abnormalCondition(test),
        location: `${KIND_LABEL[test.baseKind]}: ${location(test)}`,
        baseline: baseline ? yesNo(PASSED.has(baseline.status)) : '',
        // The block held only if the DAC saw the abnormal condition; a failed
        // test says nothing either way about the HMI tags.
        tags: pass ? 'YES' : '',
        feederUsed: pass ? 'NO' : 'YES',
        elsewhere: closedElsewhere.length ? 'YES' : 'N/A',
        elsewhereClosed: closedElsewhere.join(', '),
      };
    }
    default:
      throw new Error(`unknown sheet kind: ${kind}`);
  }
}

export { baselineOf, columnFor, configuration };
