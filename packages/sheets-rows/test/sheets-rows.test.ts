import { describe, expect, it } from "vitest";
import { CSV_HEADER, monthBooks, type Entry } from "@manut/books";
import { appendRequest, bahtNumber, quoteSheetName } from "../src/index";

const at = (day: number, hour = 10) => Date.UTC(2026, 10, day, hour - 7); // Bangkok wall time

const entries: Entry[] = [
  { kind: "sale", ref: "ORD-1", channel: "shopee", amountSatang: 129033, at: at(3) },
  { kind: "sale", ref: "=HYPERLINK(\"http://evil.example\")", channel: "line", amountSatang: 50000, at: at(4) },
  { kind: "expense", ref: "EXP-1", category: "wax", amountSatang: 12000, at: at(5) },
];

function request(sheetName = "Books") {
  const month = monthBooks(entries, "2026-11", { vatRegistered: true });
  const result = appendRequest(month, { spreadsheetId: "1AbC_dEf-123", sheetName });
  if (!result.ok) throw new Error(result.reason);
  return result.request;
}

describe("the append request", () => {
  it("is spreadsheets.values.append with RAW input and inserted rows", () => {
    const r = request();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/v4/spreadsheets/1AbC_dEf-123/values/Books!A1:append");
    expect(r.query).toEqual({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
    expect(r.body.range).toBe("Books!A1");
    expect(r.body.majorDimension).toBe("ROWS");
  });

  it("starts with the CSV export's header and keeps its columns and order", () => {
    const r = request();
    expect(r.body.values[0]).toEqual([...CSV_HEADER]);
    expect(r.body.values[1]).toEqual(["2026-11-03", "ORD-1", "sale", "shopee", 1290.33, 1205.92, 84.41]);
  });

  it("leaves before VAT and VAT empty where the books have none", () => {
    const expense = request().body.values.find((row) => row[1] === "EXP-1");
    expect(expense).toEqual(["2026-11-05", "EXP-1", "expense", "wax", 120, "", ""]);
  });

  it("keeps a ref that looks like a formula exactly as written, since RAW never runs it", () => {
    const row = request().body.values.find((r) => r[2] === "sale" && r[3] === "line");
    expect(row?.[1]).toBe("=HYPERLINK(\"http://evil.example\")");
  });

  it("sends only the header for an empty month", () => {
    const month = monthBooks([], "2026-02", { vatRegistered: false });
    const result = appendRequest(month, { spreadsheetId: "abc", sheetName: "Books" });
    expect(result.ok && result.request.body.values).toEqual([[...CSV_HEADER]]);
  });

  it("refuses a spreadsheet id or a sheet name it cannot use", () => {
    const month = monthBooks([], "2026-02");
    expect(appendRequest(month, { spreadsheetId: "a/b", sheetName: "Books" })).toEqual({ ok: false, reason: "invalid_spreadsheet_id" });
    expect(appendRequest(month, { spreadsheetId: "", sheetName: "Books" })).toEqual({ ok: false, reason: "invalid_spreadsheet_id" });
    expect(appendRequest(month, { spreadsheetId: "abc", sheetName: "" })).toEqual({ ok: false, reason: "invalid_sheet_name" });
    expect(appendRequest(month, { spreadsheetId: "abc", sheetName: "x".repeat(101) })).toEqual({ ok: false, reason: "invalid_sheet_name" });
  });
});

describe("sheet names in A1 notation", () => {
  it("leaves a plain name bare and quotes one with a space, doubling a quote inside", () => {
    expect(quoteSheetName("Books")).toBe("Books");
    expect(quoteSheetName("Books 2026")).toBe("'Books 2026'");
    expect(quoteSheetName("Fon's books")).toBe("'Fon''s books'");
    expect(quoteSheetName("บัญชี")).toBe("'บัญชี'");
  });

  it("encodes the quoted range in the request path", () => {
    expect(request("Books 2026").path).toBe("/v4/spreadsheets/1AbC_dEf-123/values/'Books%202026'!A1:append");
    expect(request("Books 2026").body.range).toBe("'Books 2026'!A1");
  });
});

describe("amounts", () => {
  it("are baht with at most two decimals whose JSON text never shows a float's tail", () => {
    for (let satang = 0; satang <= 200_000; satang += 7) {
      const value = bahtNumber(satang);
      const text = JSON.stringify(value);
      expect(text).toMatch(/^\d+(\.\d{1,2})?$/);
      expect(Math.round(Number(text) * 100)).toBe(satang);
    }
    expect(JSON.stringify(bahtNumber(129033))).toBe("1290.33");
    expect(JSON.stringify(bahtNumber(129030))).toBe("1290.3");
    expect(JSON.stringify(bahtNumber(100))).toBe("1");
  });
});
