// What the SEL index knows about a document beyond its words: a readable
// title, and how much each page reads like an explanation rather than a table.
//
// Both are worked out from the indexed text itself, not the PDFs, so they can
// be (re)derived for an existing index without the library or poppler present
// (tools/build-sel-index.mjs --derive). Page text is stored whitespace-
// collapsed, so a title has to be found by the shape of each document type's
// first page rather than by its line breaks.

const MAX_TITLE = 140;

/** Cut at a word boundary, and drop trailing punctuation left by the cut. */
function trimTitle(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').replace(/\s*®\s*/g, ' ').trim();
  if (t.length > MAX_TITLE) t = `${t.slice(0, MAX_TITLE).replace(/\s+\S*$/, '')}…`;
  t = t.replace(/[\s,;:–-]+$/, '');
  return t.length >= 6 && !scanJunk(t) ? t : null;
}

const SHORT_WORDS = new Set(['a', 'an', 'as', 'at', 'by', 'in', 'of', 'on', 'or', 'to', 'vs', 'ac', 'dc', 'pc', 'io']);

/** Badly scanned covers break words apart: "Sing le-Po le Trip Re I ay". */
function scanJunk(title) {
  const fragments = title
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]{1,2}$/.test(w) && !SHORT_WORDS.has(w.toLowerCase()) && !/^[A-Z]{2}$/.test(w));
  return fragments.length >= 2;
}

// --- application guides ---------------------------------------------------
//
//   Application Guide Volume III AG2019-07 <title> <authors> INTRODUCTION …
//
// The title runs from the guide number to the author list. The authors sit
// just before the first section heading (INTRODUCTION, BACKGROUND, …); on the
// guides without one, they run straight into the first sentence.

const AG_START = /Application Guide\s+Volume [IVX]+\s+AG\s?[\d-]+\s+(?:TM\s+)?/;
const AG_HEADING = /\s(?:\d\.\s*)?(?:INTRODUCTION|Introduction|BACKGROUND|OVERVIEW|ABSTRACT|SUMMARY|PURPOSE|DESCRIPTION|REQUIREMENTS|SCOPE|Note:)(?=\s|$)/u;
// One author: First ["Nick"] [M.] Last, optionally ", Jr." and the like.
const NAME = String.raw`\p{Lu}[\p{Ll}'’-]+(?:\s“[^”]{1,20}”)?(?:\s\p{Lu}\.)*\s(?:Mc|Mac|O’|O')?\p{Lu}[\p{L}'’-]+(?:,?\s(?:Jr|Sr|II|III)\.?)?`;
const NAMES = String.raw`\s${NAME}(?:(?:,\s|,?\sand\s)${NAME})*`;
const AUTHORS_AT_END = new RegExp(`${NAMES}$`, 'u');
// No heading: a sentence opener, or a run-in capitals heading, ends the list.
const AUTHORS_THEN_TEXT = new RegExp(
  String.raw`${NAMES}(?=\s(?:The|This|These|A|An|In|Refer|Figure|Many|For|When|Most|Each|It)\s|\s\p{Lu}{4,}\s\p{Lu}{2,})`,
  'u',
);

function guideTitle(page1) {
  const start = page1.match(AG_START);
  if (!start) return null;
  const rest = page1.slice(start.index + start[0].length, start.index + start[0].length + 600);
  const heading = rest.match(AG_HEADING);
  if (heading) return trimTitle(rest.slice(0, heading.index).replace(AUTHORS_AT_END, ''));
  const authors = rest.match(AUTHORS_THEN_TEXT);
  return authors ? trimTitle(rest.slice(0, authors.index)) : null;
}

// --- instruction manuals ---------------------------------------------------
//
//   SEL-734 Advanced Metering System Instruction Manual 20260522 …
//   Instruction Manual SEL-451-6 Relay SEL-451-6 Protection, … Instruction Manual 2026…
//
// The title is what precedes the last "Instruction Manual" on the cover; a
// running header ("Instruction Manual SEL-451-6 Relay") in front of it goes.

function manualTitle(page1) {
  const head = page1.slice(0, 320);
  const at = head.lastIndexOf('Instruction Manual');
  if (at <= 0) return null;
  let title = head.slice(0, at).trim();
  // The header's words come out interleaved with the cover's on some
  // manuals ("Instruction Relay SEL-411L Manual SEL-411L …"); the title
  // starts at the model's second mention.
  const model = /^Instruction/.test(title) && title.match(/SEL-[\w-]+/);
  if (model) {
    const again = title.indexOf(model[0], model.index + model[0].length);
    if (again !== -1) title = title.slice(again);
  }
  // A plain running header with no second mention: just drop the words.
  title = title.replace(/^Instruction Manual\s+/, '');
  // Pre-2000 covers are all capitals and scan badly; better no title than that.
  if (!/[a-z]/.test(title)) return null;
  return trimTitle(title);
}

// --- data sheets and ordering information ----------------------------------
//
// Product name and tagline, up to where the feature list or part-number
// builder begins.

const SHEET_END = /\s(?:Major |Key |New )?Features\b|\sPart Number\b|\(\d\)|\s(?:[A-Z0-9] ){3,}|\sThe SEL-|\sFigure \d/;

function sheetTitle(page1) {
  if (/^Copyright ©/.test(page1)) return null;
  const head = page1.replace(/^[\s®]+/, '').slice(0, 300);
  const end = head.search(SHEET_END);
  return trimTitle(end > 0 ? head.slice(0, end) : head.slice(0, 100).replace(/\s+\S*$/, ''));
}

/**
 * A readable title for one document, from the text of its first page, or
 * null when its cover does not follow its type's usual shape.
 */
function docTitle(folder, page1) {
  const text = String(page1 ?? '').replace(/^[^A-Za-z]*(?=[A-Z])/, '');
  if (folder === 'Application Guides') return guideTitle(text);
  if (folder === 'Instruction Manuals') return manualTitle(text);
  if (folder === 'Data Sheets' || folder === 'Ordering Information') return sheetTitle(text);
  return null;
}

// --- page quality -----------------------------------------------------------
//
// bm25 loves a page that lists a term without explaining it: a feature matrix
// with "Switch-Onto-Fault • • • •", a settings dump of "79RIS 79SEQ 79CLS", a
// table of contents. Those pages are mostly short codes, numbers and bullets;
// an explanation is mostly ordinary lowercase words strung into sentences.

const WORD = /^[a-z][a-z'’-]{2,}[,.;:)]?$/;

/**
 * 0 (table, list, settings dump) to 1 (running prose), from the share of
 * tokens that are ordinary words and how often sentences end.
 */
function proseScore(body) {
  const tokens = String(body ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length < 30) return 0.3;
  let words = 0;
  let stops = 0;
  for (const t of tokens) {
    if (WORD.test(t)) words++;
    if (/[a-z]{2}[.?!]$/.test(t)) stops++;
  }
  const wordShare = words / tokens.length; // ~0.55+ in prose, <0.25 in tables
  const sentences = (stops / tokens.length) * 100; // ~3–6 per 100 tokens in prose
  const a = Math.min(1, Math.max(0, (wordShare - 0.15) / 0.4));
  const b = Math.min(1, sentences / 3);
  return Math.round((0.7 * a + 0.3 * b) * 100) / 100;
}

export { docTitle, proseScore };
