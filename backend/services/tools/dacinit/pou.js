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

// --- updating one recloser's settings where it sits ----------------------------

// "Capacity\t:=\t105\t," — the value of one named argument, whatever the
// whitespace. \b keeps "Capacity" from matching inside "TempCapacity".
const argValue = (name) => new RegExp(`(\\b${name}\\s*:=\\s*)([^,)\\s]+)`, 'i');
const isCall = (text, method) => new RegExp(`^\\w+\\s*\\.\\s*${method}\\s*\\(`, 'i').test(text);
const SWITCH_MODE = /^\w+\s*\.\s*DisplaySwitchMode\s*:=\s*(\w+)/i;

const SOURCE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * What a recloser's statements currently say: its capacity, device
 * definition, switch mode (DisplaySwitchMode when written; otherwise implied
 * by a switch definition) and settings-group sources — six { src, sg } from
 * InitSettingsGroups, or null when it has none. `spans` are its deviceIndex
 * entries.
 */
function recloserState(implText, spans) {
  const state = { capacity: null, definition: null, switchMode: null, sources: null };
  for (const span of spans) {
    const text = implText.slice(span.start, span.end);
    if (isCall(text, 'init')) {
      state.capacity = argValue('Capacity').exec(text)?.[2] ?? null;
      state.definition = argValue('DeviceDefinition').exec(text)?.[2] ?? null;
    } else if (isCall(text, 'InitSettingsGroups')) {
      state.sources = SOURCE_LETTERS.map((letter) => ({
        src: argValue(`SRC_${letter}`).exec(text)?.[2] ?? '0',
        sg: argValue(`SG_${letter}`).exec(text)?.[2] ?? '0',
      }));
    } else {
      const mode = SWITCH_MODE.exec(text);
      if (mode) state.switchMode = /^true$/i.test(mode[1]);
    }
  }
  if (state.switchMode == null) state.switchMode = /(_sw$|^recdef_switch)/i.test(state.definition ?? '');
  return state;
}

/**
 * Rewrite only the named settings of one recloser, in place: `patch` may set
 * `capacity` (Capacity and TempCapacity), `definition` (DeviceDefinition),
 * `switchMode` (DisplaySwitchMode — added after the device's SCADA link when
 * the block never wrote one) and `sources` (six { src, sg } for the
 * InitSettingsGroups arguments). Every other byte of its block is kept.
 */
function patchRecloser(implText, name, spans, patch) {
  const ops = [];
  let hasMode = false;
  let after = spans[spans.length - 1];
  for (const span of spans) {
    const text = implText.slice(span.start, span.end);
    let next = text;
    if (isCall(text, 'init')) {
      if (patch.capacity != null) {
        next = next.replace(argValue('Capacity'), `$1${patch.capacity}`)
          .replace(argValue('TempCapacity'), `$1${patch.capacity}`);
      }
      if (patch.definition != null) next = next.replace(argValue('DeviceDefinition'), `$1${patch.definition}`);
    } else if (isCall(text, 'InitSettingsGroups') && patch.sources) {
      const args = SOURCE_LETTERS.flatMap((letter) => [`SRC_${letter}`, `SG_${letter}`]);
      if (args.every((arg) => argValue(arg).test(text))) {
        patch.sources.forEach(({ src, sg }, i) => {
          next = next.replace(argValue(`SRC_${SOURCE_LETTERS[i]}`), `$1${src}`)
            .replace(argValue(`SG_${SOURCE_LETTERS[i]}`), `$1${sg}`);
        });
      } else {
        // A call that leaves arguments out can't take a value for them in
        // place, so it is written out in full.
        next = `${name}.InitSettingsGroups(\n${patch.sources.map(({ src, sg }, i) => `\tSRC_${SOURCE_LETTERS[i]} := ${src},\n\tSG_${SOURCE_LETTERS[i]} := ${sg}`).join(',\n')});`;
      }
    } else if (SWITCH_MODE.test(text)) {
      hasMode = true;
      if (patch.switchMode != null) {
        next = next.replace(/(DisplaySwitchMode\s*:=\s*)\w+/i, `$1${patch.switchMode ? 'TRUE' : 'FALSE'}`);
      }
    }
    if (isCall(text, 'initDaScadaLink')) after = span;
    if (next !== text) ops.push({ start: span.start, end: span.end, text: next });
  }
  if (!hasMode && patch.switchMode != null) {
    ops.push({ start: after.end, end: after.end, text: `\n\n${name}.DisplaySwitchMode := ${patch.switchMode ? 'TRUE' : 'FALSE'};` });
  }
  ops.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const op of ops) {
    out += implText.slice(cursor, op.start) + op.text;
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
  recloserState, patchRecloser,
  appendImplementation,
  readDeclarations, declarationHasDevice, insertDeclarations,
};
