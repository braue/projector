// The four FAT checkout sheets an automatic-FAT report fills, and where each
// answer goes. The shapes are the standard SEL ES DAC FAT workbook's (taken
// from a hand-completed FAT — see tools/build-fat-template.mjs): label
// columns on the left, one column per test from `firstCol` on, a substation
// band in row 4, the test id formula in row 5, and the FAT rows below.
//
// Row numbers are 1-based sheet rows. The template ships with exactly these
// rows; a test (fatsheets.test.js) holds the template's labels to them.

const SHEETS = {
  fault: {
    name: 'Fault Test Checkout',
    prefix: 'FT',
    firstCol: 4,
    rows: {
      feeder: 6, configuration: 7, location: 8,
      recognized: 9, upstream: 10, downstream: 11, acceptable: 12,
      opened: 13, closed: 14, rtn: 15, comments: 16, engineer: 17, date: 18,
    },
  },
  openPhase: {
    name: 'Open Phase Test Checkout',
    prefix: 'OP',
    firstCol: 4,
    rows: {
      feeder: 6, configuration: 7, location: 8,
      recognized: 9, acceptable: 10, opened: 11, closed: 12,
      comments: 13, engineer: 14, date: 15,
    },
  },
  miscoordination: {
    name: 'Miscoordination Test Checkout',
    prefix: 'MIS',
    firstCol: 4,
    rows: {
      feeder: 6, configuration: 7, location: 8,
      recognized: 9, acceptable: 10, opened: 11, closed: 12,
      comments: 13, engineer: 14, date: 15,
    },
  },
  abnormal: {
    name: 'Abnormal Condition Checkout',
    prefix: 'ABN',
    firstCol: 5,
    rows: {
      feeder: 6, configuration: 7, abnormal: 8, location: 9,
      baseline: 10, tags: 11, feederUsed: 12, elsewhere: 13, elsewhereClosed: 14,
      comments: 15, engineer: 16, date: 17,
    },
  },
};

const KIND_ORDER = ['fault', 'openPhase', 'miscoordination', 'abnormal'];

// Where the sheets go when the workbook doesn't have them yet: right after
// this one (the standard workbook's order), else before the first of the
// others, else at the end.
const INSERT_AFTER = 'Simulator HMI screens';
const INSERT_BEFORE = [
  'Commanded Status Checkout', 'Loss of Source Checkout', 'Under Frequency Test Checkout',
  'Capacity Limited Checkout', 'Settings Management Checkout',
];

// Sheets whose row 4 bands substations over row-6 feeders — where a workbook
// already says which feeder sits under which substation, in which colour.
const BAND_SOURCES = ['Under Frequency Test Checkout', 'Loss of Source Checkout'];

export { BAND_SOURCES, INSERT_AFTER, INSERT_BEFORE, KIND_ORDER, SHEETS };
