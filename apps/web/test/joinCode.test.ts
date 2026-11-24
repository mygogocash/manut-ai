import { describe, expect, it } from "vitest";
import { clock, codeFrom, maskEmail, visitDeviceId, waitText, waitWords } from "../src/join/code";
import { en } from "../src/join/strings";
import { normalizeEmail } from "../src/api/email";

describe("the join page's small rules", () => {
  it("reads a code from what was typed or pasted", () => {
    expect(codeFrom("246810")).toBe("246810");
    expect(codeFrom("246 810")).toBe("246810");
    expect(codeFrom("246-810")).toBe("246810");
    expect(codeFrom("Your Manut AI code is 482915. It works for 10 minutes.")).toBe("482915");
    expect(codeFrom("４８２９１５")).toBe("482915");
    expect(codeFrom("๔๘๒๙๑๕")).toBe("482915");
    expect(codeFrom("12")).toBe("12");
    expect(codeFrom("1234567")).toBe("123456");
    expect(codeFrom("abc")).toBe("");
  });

  it("hides an address but for its first character and its domain", () => {
    expect(maskEmail("fon@baanmali.example")).toBe("f•••@baanmali.example");
    expect(maskEmail("m@baanmali.example")).toBe("m•••@baanmali.example");
    expect(maskEmail("not-an-address")).toBe("not-an-address");
  });

  it("says a wait as a clock under an hour, and in words beyond", () => {
    expect(clock(60)).toBe("1:00");
    expect(clock(41.2)).toBe("0:42");
    expect(clock(0)).toBe("0:00");
    expect(waitWords(42, en)).toBe("1 minute");
    expect(waitWords(61, en)).toBe("2 minutes");
    expect(waitWords(119 * 60, en)).toBe("119 minutes");
    expect(waitWords(120 * 60, en)).toBe("2 hours");
    expect(waitWords(30_000, en)).toBe("9 hours");
    expect(waitText(42, en)).toBe("0:42");
    expect(waitText(5 * 3600, en)).toBe("5 hours");
  });

  it("names each visit's device afresh, within the exchange's 128 characters", () => {
    const first = visitDeviceId();
    expect(first).toMatch(/^web-[0-9a-f-]{32,36}$/);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(visitDeviceId()).not.toBe(first);
  });

  it("reads an address as the API does", () => {
    expect(normalizeEmail("  Mint@BaanMali.example ")).toBe("mint@baanmali.example");
    for (const bad of ["", "mint", "mint@", "@x", "mi nt@x.example", "a@b@c", `${"a".repeat(250)}@b.example`]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
  });
});
