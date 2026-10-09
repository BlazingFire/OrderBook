/**
 * Dependency-free CSV writer, shared by Logs export and (from Stage 5)
 * Reports export.
 *
 * CRLF row endings (the format Excel expects); any field containing a
 * comma, quote, CR or LF is quoted; a field starting with `=`, `+`, `-` or
 * `@` is formula-injection-prone in Excel and gets a leading apostrophe —
 * this is a shop PC where the exported file is opened directly. An absent
 * value (`null` or `undefined`) is an **empty** cell, never `0` — the same
 * absent-not-zero rule the wire contract uses everywhere else.
 */

// `=` `+` `-` `@` start a formula; a TAB or a carriage return in front of one is
// how a cell gets past a check that looks only at the first character. One
// behind apostrophes of the value's own is guarded too: the reader takes
// exactly one apostrophe off such a cell (`lib/spreadsheet.ts#parseCsv`), so
// "'-90 BEND" comes back as it was written.
const FORMULA_PREFIX = /^'*[=+\-@\t\r]/;

/** Renders one CSV field: quoted if needed, formula-injection-guarded. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = typeof value === 'string' ? value : String(value);

  if (FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/** Renders rows as CSV lines, each ending in CRLF, for a document built a batch at a time. */
export function csvLines(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows.map((row) => row.map(csvCell).join(',') + '\r\n').join('');
}

/** Renders a complete CSV document: a header row plus one row per record. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return csvLines([headers, ...rows]);
}
