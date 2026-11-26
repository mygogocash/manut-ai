import { describe, expect, it } from "vitest";
import { crc16, formatAmount, PromptPayError, promptPayPayload, targetOf } from "../src/index";

/// Vectors copied from dtinth/promptpay-qr's index.test.js (MIT), the reference
/// this package follows. Each must match byte for byte.
describe("reference vectors", () => {
  const cases: [string, string, number | undefined, string][] = [
    ["local phone number", "0801234567", undefined, "00020101021129370016A000000677010111011300668012345675802TH530376463046197"],
    ["dashed local phone number", "080-123-4567", undefined, "00020101021129370016A000000677010111011300668012345675802TH530376463046197"],
    ["dashed international phone number", "+66-89-123-4567", undefined, "00020101021129370016A000000677010111011300668912345675802TH5303764630429C1"],
    ["national id", "1111111111111", undefined, "00020101021129370016A000000677010111021311111111111115802TH530376463047B5A"],
    ["dashed national id", "1-1111-11111-11-1", undefined, "00020101021129370016A000000677010111021311111111111115802TH530376463047B5A"],
    ["tax id", "0123456789012", undefined, "00020101021129370016A000000677010111021301234567890125802TH530376463040CBD"],
    ["e-wallet id", "012345678901234", undefined, "00020101021129390016A00000067701011103150123456789012345802TH530376463049781"],
  ];
  for (const [name, id, amount, expected] of cases) {
    it(name, () => {
      expect(promptPayPayload(amount === undefined ? { id } : { id, amountSatang: amount })).toBe(expected);
    });
  }

  it("an amount makes the code dynamic and carries the amount", () => {
    // The reference uses "000-000-0000", which this package refuses as a phone
    // number, so the same fields are checked here with the tax-id route and the
    // amount field compared on its own.
    const payload = promptPayPayload({ id: "0123456789012", amountSatang: 422 });
    expect(payload.startsWith("000201010212")).toBe(true);
    expect(payload).toContain("54044.22");
    const body = payload.slice(0, -4);
    expect(payload.slice(-4)).toBe(crc16(body).toString(16).toUpperCase().padStart(4, "0"));
  });
});

describe("crc16", () => {
  it("matches the reference's amount vector", () => {
    const reference = "00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469";
    expect(crc16(reference.slice(0, -4)).toString(16).toUpperCase()).toBe("E469");
  });

  it("is CRC-16/CCITT-FALSE (check value of 123456789 is 29B1)", () => {
    expect(crc16("123456789")).toBe(0x29b1);
  });
});

describe("amounts", () => {
  it("formats whole satang as baht with two decimals", () => {
    expect(formatAmount(129000)).toBe("1290.00");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(78300)).toBe("783.00");
  });

  it("refuses zero, negative, fractional and oversized amounts", () => {
    for (const bad of [0, -100, 12.5, Number.NaN, 1e15]) {
      expect(() => formatAmount(bad)).toThrow(PromptPayError);
    }
  });
});

describe("ids", () => {
  it("knows each kind", () => {
    expect(targetOf("081-234-5678").kind).toBe("phone");
    expect(targetOf("+66812345678").kind).toBe("phone");
    expect(targetOf("1111111111111").kind).toBe("taxId");
    expect(targetOf("012345678901234").kind).toBe("eWallet");
  });

  it("refuses anything that is not a valid id rather than guessing", () => {
    for (const bad of ["", "12345", "1234567890", "000-000-0000", "81234567890", "12345678901234"]) {
      expect(() => targetOf(bad)).toThrow(PromptPayError);
    }
  });
});
