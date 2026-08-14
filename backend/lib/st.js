// Tiny IEC 61131-3 Structured Text tokenizer — backend twin of
// frontend/src/lib/st.ts (the PDF report colors logic diffs with it; the
// frontend copy drives the app's code views). Keep the two in lockstep.
//
// Line-oriented with explicit comment state so (* block comments *) survive
// line breaks: callers fold `state` through consecutive lines of one source.

const ST_START = { inComment: false };

const KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM', 'FUNCTION', 'END_FUNCTION', 'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
  'METHOD', 'END_METHOD', 'ACTION', 'END_ACTION', 'INTERFACE', 'END_INTERFACE',
  'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL',
  'VAR_STAT', 'END_VAR', 'CONSTANT', 'RETAIN', 'PERSISTENT', 'AT',
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
  'RETURN', 'EXIT', 'CONTINUE',
  'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'TRUE', 'FALSE', 'NULL',
  'TYPE', 'END_TYPE', 'STRUCT', 'END_STRUCT', 'ARRAY', 'POINTER', 'REFERENCE', 'REF_TO',
  'EXTENDS', 'IMPLEMENTS', 'THIS', 'SUPER', 'ABSTRACT',
]);

const TYPES = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
  'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT',
  'REAL', 'LREAL', 'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
  'STRING', 'WSTRING', 'CHAR', 'WCHAR', 'ANY', 'ANY_NUM', 'ANY_INT',
  'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD', 'CTUD', 'RS', 'SR',
]);

// Typed literals (T#5S, 16#FF) then plain numbers, then identifiers; strings
// and comments are carved out by the scanner before this runs.
const TOKEN = /(?:[A-Za-z_]\w*|\d+)#[\w.+-]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[A-Za-z_]\w*/g;
const STRING = /^'(?:[^']|'')*'?/;

function classify(text) {
  if (text.includes('#') || /^\d/.test(text)) return { kind: 'num', text };
  const upper = text.toUpperCase();
  if (KEYWORDS.has(upper)) return { kind: 'kw', text };
  if (TYPES.has(upper)) return { kind: 'type', text };
  return { kind: 'plain', text };
}

/** Tokenize one line, threading block-comment state from the previous line. */
function tokenizeLine(line, state) {
  const tokens = [];
  let rest = line;
  let inComment = state.inComment;

  const emitCode = (chunk) => {
    let last = 0;
    for (const match of chunk.matchAll(TOKEN)) {
      if (match.index > last) tokens.push({ kind: 'plain', text: chunk.slice(last, match.index) });
      tokens.push(classify(match[0]));
      last = match.index + match[0].length;
    }
    if (last < chunk.length) tokens.push({ kind: 'plain', text: chunk.slice(last) });
  };

  while (rest) {
    if (inComment) {
      const end = rest.indexOf('*)');
      if (end === -1) {
        tokens.push({ kind: 'com', text: rest });
        rest = '';
      } else {
        tokens.push({ kind: 'com', text: rest.slice(0, end + 2) });
        rest = rest.slice(end + 2);
        inComment = false;
      }
      continue;
    }

    // The earliest of string / line comment / block comment wins — a string
    // may contain '//' and a comment may contain quotes, so order matters.
    const starts = [rest.indexOf("'"), rest.indexOf('//'), rest.indexOf('(*')];
    const present = starts.filter((index) => index !== -1);
    if (!present.length) {
      emitCode(rest);
      break;
    }
    const stop = Math.min(...present);
    emitCode(rest.slice(0, stop));
    rest = rest.slice(stop);

    if (stop === starts[0]) {
      const text = STRING.exec(rest)[0];
      tokens.push({ kind: 'str', text });
      rest = rest.slice(text.length);
    } else if (stop === starts[1]) {
      tokens.push({ kind: 'com', text: rest });
      rest = '';
    } else {
      // Consume the '(*' opener NOW — scanning for '*)' from the opener
      // itself would let '(*)' close on its own '*'.
      tokens.push({ kind: 'com', text: '(*' });
      rest = rest.slice(2);
      inComment = true;
    }
  }

  return { tokens, state: { inComment } };
}

export { ST_START, tokenizeLine };
