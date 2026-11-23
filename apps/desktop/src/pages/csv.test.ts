// The activity log's export is a file a person opens in a spreadsheet, so a field must never be able to run as a formula
// and must never break the row it sits in. The rules are packages/books' `booksCsv` (RFC 4180, CRLF between records, a
// leading apostrophe on a field that starts with `=`, `+`, `-`, `@`, a tab or a carriage return).
import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "./csv";

describe("a CSV field", () => {
  it("is left as it is when nothing in it needs care", () => {
    expect(csvField("Nam sent 3 LINE replies")).toBe("Nam sent 3 LINE replies");
    expect(csvField("")).toBe("");
    expect(csvField("ขออภัยที่พัสดุล่าช้านะคะ")).toBe("ขออภัยที่พัสดุล่าช้านะคะ");
  });

  it.each([
    ["=1+1", "'=1+1"],
    ["+66 81 234 5678", "'+66 81 234 5678"],
    ["-5", "'-5"],
    ["@SUM(A1:A9)", "'@SUM(A1:A9)"],
    ["\tdo not run", "'\tdo not run"],
  ])("starts %j with an apostrophe so a spreadsheet reads it as text", (field, out) => {
    expect(csvField(field)).toBe(out);
  });

  it("guards a leading carriage return too, and quotes it because it is a line break", () => {
    expect(csvField("\rhello")).toBe('"\'\rhello"');
  });

  it("guards only the start of a field", () => {
    for (const field of ["a=b", "1+1", "well-known", "me@shop", "x\ty"]) expect(csvField(field)).toBe(field);
  });

  it("quotes a field that holds a comma, a double quote or a line break, and doubles each quote", () => {
    expect(csvField("Khun Ploy, Khun Mint")).toBe('"Khun Ploy, Khun Mint"');
    expect(csvField('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("two\r\nlines")).toBe('"two\r\nlines"');
  });

  it("guards first and quotes after, so a guarded field that needs quotes keeps its apostrophe inside them", () => {
    expect(csvField("=a,b")).toBe('"\'=a,b"');
    expect(csvField('@"x"')).toBe('"\'@""x"""');
  });
});

describe("a CSV file", () => {
  it("joins its records with CRLF and ends none with one, each field guarded and quoted on its own", () => {
    expect(
      toCsv([
        ["Time", "Event"],
        ["09:14", "Nam sent 3 replies, all delivered"],
        ["09:20", "=cmd()"],
      ]),
    ).toBe('Time,Event\r\n09:14,"Nam sent 3 replies, all delivered"\r\n09:20,\'=cmd()');
  });

  it("is empty for no records", () => {
    expect(toCsv([])).toBe("");
  });
});
