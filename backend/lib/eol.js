// One home for line-ending normalization — SEL/Windows exports mix CRLF and
// LF, and every consumer that splits or compares source must agree.
function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n');
}

export { normalizeEol };
