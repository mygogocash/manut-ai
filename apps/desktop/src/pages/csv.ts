// CSV the way a spreadsheet should read it. A field is a person's or a customer's words, so it must never run as a
// formula when the file is opened and never break the row it is in. These are the rules of packages/books' `booksCsv`
// (RFC 4180: CRLF between records, a field with a comma, a double quote or a line break quoted with its quotes
// doubled), with the guard it has: a field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a
// leading apostrophe. The guard comes first, so a guarded field that then needs quotes keeps its apostrophe inside them.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvField(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Records joined by CRLF, the last without one, each field guarded and quoted on its own. */
export function toCsv(records: readonly (readonly string[])[]): string {
  return records.map((record) => record.map(csvField).join(",")).join("\r\n");
}
