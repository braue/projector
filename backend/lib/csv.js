// Minimal CSV writer for tool reports. RFC-4180 quoting, CRLF rows — what
// Excel opens cleanly, since these reports usually end up there.

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV document from a header row and data rows (arrays of cells). */
function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export { toCsv };
