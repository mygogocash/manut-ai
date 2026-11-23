// The request that would append a month of Ton's books to a Google Sheet. Pure: there is no network call and no
// sign-in here. Sending it is a later task, behind the owner's own Google connection and the vault, so this package
// never sees a token.
//
// The request is the Sheets API's `spreadsheets.values.append`
// (https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append, checked
// 23 Nov 2026): `POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append` with a `ValueRange` body. It uses
// `valueInputOption=RAW`, which stores every value as given and never parses it, so a ref a customer chose such as
// `=HYPERLINK(...)` stays text in the sheet and is never run as a formula. That is why, unlike the CSV export, no
// cell gets a leading apostrophe here: under RAW the apostrophe would show in the cell.

import { CSV_HEADER, type BookLine, type MonthBooks } from "@manut/books";

export interface AppendTarget {
  readonly spreadsheetId: string;
  readonly sheetName: string;
}

export type Cell = string | number;

export interface AppendRequest {
  readonly method: "POST";
  /// The path under https://sheets.googleapis.com, with the range percent-encoded.
  readonly path: string;
  readonly query: { readonly valueInputOption: "RAW"; readonly insertDataOption: "INSERT_ROWS" };
  readonly body: { readonly range: string; readonly majorDimension: "ROWS"; readonly values: Cell[][] };
}

export type AppendResult =
  | { readonly ok: true; readonly request: AppendRequest }
  | { readonly ok: false; readonly reason: "invalid_spreadsheet_id" | "invalid_sheet_name" };

/// A spreadsheet id is the part of a sheet's address between `/d/` and the next `/`: letters, digits, `-` and `_`.
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,128}$/;
/// Google Sheets keeps a sheet's name to 100 characters.
const MAX_SHEET_NAME = 100;
const PLAIN_NAME = /^[A-Za-z0-9_]+$/;

/// A sheet's name as A1 notation writes it. Single quotes are required for a name with spaces or special
/// characters (the Sheets API's A1 notation guide); a quote inside the name is doubled, as spreadsheet formulas
/// and widely used clients such as gspread write it, although the guide's own example `'Jon's_Data'` shows it once.
export function quoteSheetName(name: string): string {
  return PLAIN_NAME.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
}

/// Baht as a JSON number with at most two decimals, made from integer satang through exact decimal text, so the
/// request never carries a float's tail such as 1290.3299999. 129033 satang is 1290.33; 129030 is 1290.3.
export function bahtNumber(satang: number): number {
  const whole = Math.floor(satang / 100);
  const rest = satang - whole * 100;
  return Number(`${whole}.${String(rest).padStart(2, "0")}`);
}

function row(line: BookLine): Cell[] {
  return [
    line.date,
    line.ref,
    line.kind,
    line.channelOrCategory,
    bahtNumber(line.amountSatang),
    line.beforeVatSatang === null ? "" : bahtNumber(line.beforeVatSatang),
    line.vatSatang === null ? "" : bahtNumber(line.vatSatang),
  ];
}

/// The append request for one month, with the CSV export's header first and its columns in the same order.
export function appendRequest(month: MonthBooks, target: AppendTarget): AppendResult {
  if (typeof target.spreadsheetId !== "string" || !SPREADSHEET_ID.test(target.spreadsheetId)) {
    return { ok: false, reason: "invalid_spreadsheet_id" };
  }
  const name = target.sheetName;
  if (typeof name !== "string" || name.length === 0 || [...name].length > MAX_SHEET_NAME) {
    return { ok: false, reason: "invalid_sheet_name" };
  }
  const range = `${quoteSheetName(name)}!A1`;
  return {
    ok: true,
    request: {
      method: "POST",
      path: `/v4/spreadsheets/${target.spreadsheetId}/values/${encodeURIComponent(range)}:append`,
      query: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      body: { range, majorDimension: "ROWS", values: [[...CSV_HEADER], ...month.lines.map(row)] },
    },
  };
}
