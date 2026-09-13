// Minimal, surgical editing of a POU XML file: append generated Structured
// Text into the single <Implementation> CDATA block, or rewrite one device's
// statements where they already sit, changing nothing else in the file. A POU
// export is
//   <RTACModule><POU>…<Content>
//     <Interface><![CDATA[…]]></Interface>
//     <Implementation><![CDATA[…ST…]]></Implementation>
//   </Content></POU></RTACModule>
// A CDATA section cannot itself contain "]]>", so splicing before the first
// "]]>" after the Implementation's "<![CDATA[" is unambiguous — and a string
// splice keeps every other byte identical, so projector's Compare shows a
// clean, minimal diff (unlike a full XML round-trip, which reformats).

const IMPL_OPEN = '<Implementation>';
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/** Locate the Implementation CDATA span; throws if the file isn't a POU. */
function locate(xml) {
  const impl = xml.indexOf(IMPL_OPEN);
  if (impl < 0) throw new Error('not a POU export: no <Implementation> element');
  const contentStart = xml.indexOf(CDATA_OPEN, impl);
  if (contentStart < 0) throw new Error('Implementation has no CDATA section');
  const start = contentStart + CDATA_OPEN.length;
  const end = xml.indexOf(CDATA_CLOSE, start);
  if (end < 0) throw new Error('Implementation CDATA is unterminated');
  return { start, end };
}

/** The current ST body of a POU (the Implementation CDATA content). */
function readImplementation(xml) {
  const { start, end } = locate(xml);
  return xml.slice(start, end);
}

/** Replace the Implementation CDATA content with `implText`, touching nothing
 *  else in the file — the write half of readImplementation. */
function writeImplementation(xml, implText) {
  const { start, end } = locate(xml);
  return xml.slice(0, start) + implText + xml.slice(end);
}

/**
 * Split ST into its top-level statements — the spans between semicolons, with
 * comments and string literals skipped so a ";" inside either never ends a
 * statement. A span starts at the statement's first code character (leading
 * whitespace and preceding comment lines stay outside it, and so survive an
 * edit) and ends just past its ";".
 */
function statements(text) {
  const out = [];
  let i = 0;
  let start = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (c === '(' && text[i + 1] === '*') {
      const close = text.indexOf('*)', i + 2);
      i = close < 0 ? text.length : close + 2;
    } else if (/\s/.test(c)) {
      i += 1;
    } else {
      if (start < 0) start = i;
      if (c === "'" || c === '"') {
        i += 1;
        while (i < text.length && text[i] !== c) i += text[i] === '$' ? 2 : 1;
        i += 1;
      } else if (c === ';') {
        out.push({ start, end: i + 1 });
        start = -1;
        i += 1;
      } else {
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Every device the implementation acts on, from one scan: the lowercased
 * device name (Structured Text is case-insensitive) to the spans of its
 * statements, in order. A device's statements are the ones beginning
 * "<name>." — "R048.Init(", "R048.DisplaySwitchMode := TRUE;".
 */
function deviceIndex(implText) {
  const index = new Map();
  for (const span of statements(implText)) {
    const head = /^([A-Za-z_][A-Za-z_0-9]*)\s*\./.exec(implText.slice(span.start, span.end));
    if (!head) continue;
    const key = head[1].toLowerCase();
    const spans = index.get(key);
    if (spans) spans.push(span);
    else index.set(key, [span]);
  }
  return index;
}

/**
 * Rewrite devices in place: each edit is `{ spans, text }` from deviceIndex,
 * and its first span becomes `text` while the rest go away, taking the blank
 * space that separated them. The device's block stays exactly where the
 * engineer put it (and keeps any comment written above it), so a regenerated
 * init with changed parameters lands as an edit rather than a second copy at
 * the bottom of the file. One pass over the text, so every edit's spans are
 * still valid when it is applied.
 */
function replaceDevices(implText, edits) {
  const ops = edits.flatMap(({ spans, text }) => spans.map(
    (span, idx) => ({ ...span, text: idx === 0 ? text : null }),
  )).sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const op of ops) {
    const lead = implText.slice(cursor, op.start);
    out += op.text == null ? lead.replace(/\s*$/, '') : lead + op.text;
    cursor = op.end;
  }
  return out + implText.slice(cursor);
}

/** Return `implText` with `text` appended, separated by a blank line. */
function appendImplementation(implText, text) {
  return `${implText.replace(/\s*$/, '')}\n\n${text}\n`;
}

// --- DeviceDeclarations (a GVL, not a POU) ----------------------------------

// A GVL export is <RTACModule><GVL>…<Content><![CDATA[VAR_GLOBAL … END_VAR]]>.
// Its CDATA sits directly under <Content> (a POU's <Content> instead wraps
// <Interface>/<Implementation> elements), so the direct-CDATA shape is what
// distinguishes the two.
const CONTENT_OPEN = '<Content>';

function locateGvl(xml) {
  const content = xml.indexOf(CONTENT_OPEN);
  if (content < 0) throw new Error('not a GVL export: no <Content> element');
  const contentStart = xml.indexOf(CDATA_OPEN, content);
  if (contentStart < 0 || !/^\s*$/.test(xml.slice(content + CONTENT_OPEN.length, contentStart))) {
    throw new Error('Content is not a direct GVL CDATA');
  }
  const start = contentStart + CDATA_OPEN.length;
  const end = xml.indexOf(CDATA_CLOSE, start);
  if (end < 0) throw new Error('GVL Content CDATA is unterminated');
  return { start, end };
}

/** The declaration body (the VAR_GLOBAL … END_VAR text) of a GVL. */
function readDeclarations(xml) {
  const { start, end } = locateGvl(xml);
  return xml.slice(start, end);
}

/** Is a device already declared? Its name appears as a whole token in the
 *  comma-separated declaration list (underscores are word chars, so
 *  "F4473A" never matches inside "F4473A_Conn"). */
function declarationHasDevice(content, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(content);
}

/**
 * Return xml with `text` inserted into the GVL's VAR_GLOBAL block, just before
 * its END_VAR — the same "append a labeled batch before END_VAR" convention
 * the file is already maintained by. The rest of the file is untouched.
 */
function insertDeclarations(xml, text) {
  const { start, end } = locateGvl(xml);
  const content = xml.slice(start, end);
  const endVar = content.lastIndexOf('END_VAR');
  if (endVar < 0) throw new Error('GVL has no END_VAR');
  const before = content.slice(0, endVar).replace(/\s*$/, '');
  const after = content.slice(endVar);
  const body = `${before}\n\n${text}\n\n${after}`;
  return xml.slice(0, start) + body + xml.slice(end);
}

export {
  readImplementation, writeImplementation, deviceIndex, replaceDevices,
  appendImplementation,
  readDeclarations, declarationHasDevice, insertDeclarations,
};
