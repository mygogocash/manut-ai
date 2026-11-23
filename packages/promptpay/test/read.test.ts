import { describe, expect, it } from "vitest";
import { crc16, promptPayPayload, readPromptPayPayload } from "../src/index";

/// Rebuilds a payload with a new body and a correct CRC, so a test can break
/// one field at a time without tripping the CRC check first.
function sealed(body: string): string {
  const open = `${body}6304`;
  return open + crc16(open).toString(16).toUpperCase().padStart(4, "0");
}
const GUID = "0016A000000677010111";
const sub = (id: string, v: string) => `${id}${String(v.length).padStart(2, "0")}${v}`;
function make(over: { poi?: string; merchant?: string; country?: string; currency?: string; amount?: string; format?: string }): string {
  const f = (id: string, v: string) => `${id}${String(v.length).padStart(2, "0")}${v}`;
  return sealed(
    f("00", over.format ?? "01") +
      f("01", over.poi ?? "11") +
      f("29", over.merchant ?? GUID + sub("01", "0066801234567")) +
      f("58", over.country ?? "TH") +
      f("53", over.currency ?? "764") +
      (over.amount === undefined ? "" : f("54", over.amount)),
  );
}

describe("round trips", () => {
  const ids: [string, string, string, string][] = [
    ["phone", "0801234567", "phone", "0801234567"],
    ["dashed phone", "080-123-4567", "phone", "0801234567"],
    ["international phone", "+66-89-123-4567", "phone", "0891234567"],
    ["national id", "1111111111111", "taxId", "1111111111111"],
    ["tax id", "0123456789012", "taxId", "0123456789012"],
    ["e-wallet", "012345678901234", "eWallet", "012345678901234"],
  ];
  for (const [name, input, kind, id] of ids) {
    it(`${name} without an amount`, () => {
      expect(readPromptPayPayload(promptPayPayload({ id: input }))).toEqual({ ok: true, kind, id, method: "static" });
    });
    it(`${name} with an amount`, () => {
      expect(readPromptPayPayload(promptPayPayload({ id: input, amountSatang: 129050 }))).toEqual({
        ok: true,
        kind,
        id,
        amountSatang: 129050,
        method: "dynamic",
      });
    });
  }

  it("keeps small and round amounts exact", () => {
    for (const amountSatang of [1, 40, 100, 129000, 123456789]) {
      const read = readPromptPayPayload(promptPayPayload({ id: "0801234567", amountSatang }));
      expect(read).toMatchObject({ ok: true, amountSatang });
    }
  });

  it("accepts a lower-case CRC", () => {
    const payload = promptPayPayload({ id: "0801234567" });
    expect(readPromptPayPayload(payload.slice(0, -4) + payload.slice(-4).toLowerCase()).ok).toBe(true);
  });
});

describe("refusals", () => {
  const good = promptPayPayload({ id: "0801234567", amountSatang: 5000 });

  it("a test payload built by hand is readable", () => {
    expect(readPromptPayPayload(make({ amount: "50.00", poi: "12" }))).toMatchObject({ ok: true, amountSatang: 5000 });
  });
  it("not text", () => {
    expect(readPromptPayPayload(undefined as unknown as string)).toEqual({ ok: false, reason: "not_text" });
  });
  it("empty and short text", () => {
    expect(readPromptPayPayload("")).toEqual({ ok: false, reason: "bad_crc" });
    expect(readPromptPayPayload("6304")).toEqual({ ok: false, reason: "bad_crc" });
  });
  it("a wrong CRC", () => {
    const last = good.endsWith("0") ? "1" : "0";
    expect(readPromptPayPayload(good.slice(0, -1) + last)).toEqual({ ok: false, reason: "bad_crc" });
  });
  it("a changed digit with the old CRC", () => {
    expect(readPromptPayPayload(good.replace("0801234567".slice(1), "9801234567".slice(0, 9)))).toEqual({
      ok: false,
      reason: expect.stringMatching(/bad_crc|bad_length/),
    });
  });
  it("a CRC that is not hex", () => {
    expect(readPromptPayPayload(`${good.slice(0, -4)}ZZZZ`)).toEqual({ ok: false, reason: "bad_crc" });
  });
  it("a length that runs past the end", () => {
    expect(readPromptPayPayload(sealed("0099"))).toEqual({ ok: false, reason: "bad_length" });
  });
  it("a length that is not digits", () => {
    expect(readPromptPayPayload(sealed("00AB01"))).toEqual({ ok: false, reason: "bad_length" });
  });
  it("the same tag twice", () => {
    expect(readPromptPayPayload(sealed("000201000201"))).toEqual({ ok: false, reason: "bad_length" });
  });
  it("a wrong payload format", () => {
    expect(readPromptPayPayload(make({ format: "02" }))).toEqual({ ok: false, reason: "bad_format" });
  });
  it("a wrong point of initiation", () => {
    expect(readPromptPayPayload(make({ poi: "13" }))).toEqual({ ok: false, reason: "bad_format" });
  });
  it("a wrong GUID", () => {
    expect(readPromptPayPayload(make({ merchant: "0016A000000677010112" + sub("01", "0066801234567") }))).toEqual({
      ok: false,
      reason: "bad_guid",
    });
  });
  it("no merchant block", () => {
    expect(readPromptPayPayload(sealed("00020101021158025TH".replace("5TH", "TH") + "5303764"))).toEqual({
      ok: false,
      reason: "bad_guid",
    });
  });
  it("a wrong country", () => {
    expect(readPromptPayPayload(make({ country: "US" }))).toEqual({ ok: false, reason: "bad_country" });
  });
  it("a wrong currency", () => {
    expect(readPromptPayPayload(make({ currency: "840" }))).toEqual({ ok: false, reason: "bad_currency" });
  });
  it("a phone number of the wrong shape", () => {
    expect(readPromptPayPayload(make({ merchant: GUID + sub("01", "0081234567890") }))).toEqual({
      ok: false,
      reason: "bad_id",
    });
  });
  it("an id of the wrong length", () => {
    expect(readPromptPayPayload(make({ merchant: GUID + sub("02", "123456789012") }))).toEqual({ ok: false, reason: "bad_id" });
  });
  it("an id of nothing but zeros", () => {
    expect(readPromptPayPayload(make({ merchant: GUID + sub("02", "0000000000000") }))).toEqual({ ok: false, reason: "bad_id" });
  });
  it("two kinds of id at once", () => {
    expect(readPromptPayPayload(make({ merchant: GUID + sub("01", "0066801234567") + sub("02", "0123456789012") }))).toEqual({
      ok: false,
      reason: "bad_id",
    });
  });
  it("no id at all", () => {
    expect(readPromptPayPayload(make({ merchant: GUID }))).toEqual({ ok: false, reason: "bad_id" });
  });
  it("a dynamic code without an amount", () => {
    expect(readPromptPayPayload(make({ poi: "12" }))).toEqual({ ok: false, reason: "bad_amount" });
  });
  it("an amount that is not a number, zero or too precise", () => {
    for (const amount of ["abc", "0.00", "-5.00", "1.234", "1,000.00", ""]) {
      expect(readPromptPayPayload(make({ poi: "12", amount }))).toEqual({ ok: false, reason: "bad_amount" });
    }
  });
  it("never throws on odd input", () => {
    for (const text of ["\u0000", "６３０４", "63040000", "00".repeat(50), "x".repeat(500)]) {
      expect(() => readPromptPayPayload(text)).not.toThrow();
      expect(readPromptPayPayload(text).ok).toBe(false);
    }
  });
});
