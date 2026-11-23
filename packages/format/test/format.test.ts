import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatTime, parseMoney, splitVat } from "../src/index";

describe("formatMoney", () => {
  it.each([
    [129000, "฿1,290"],
    [40, "฿0.40"],
    [5, "฿0.05"],
    [0, "฿0"],
    [100, "฿1"],
    [123456789, "฿1,234,567.89"],
    [99999, "฿999.99"],
    [100000, "฿1,000"],
  ])("%i satang is %s", (satang, text) => {
    expect(formatMoney(satang)).toBe(text);
  });

  it("shows two decimals every time with always", () => {
    expect(formatMoney(129000, { always: true })).toBe("฿1,290.00");
    expect(formatMoney(40, { always: true })).toBe("฿0.40");
    expect(formatMoney(0, { always: true })).toBe("฿0.00");
  });

  it("refuses negative, fractional and unsafe amounts", () => {
    expect(() => formatMoney(-1)).toThrow(RangeError);
    expect(() => formatMoney(12.5)).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN)).toThrow(RangeError);
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe("parseMoney", () => {
  it.each([
    ["1290", 129000],
    ["1,290", 129000],
    ["฿1,290.50", 129050],
    ["1290.5", 129050],
    ["  ฿ 1,290  ", 129000],
    ["0.40", 40],
    ["฿1,234,567.89", 123456789],
    ["12.05", 1205],
  ])("reads %j as %i satang", (text, satang) => {
    expect(parseMoney(text)).toBe(satang);
  });

  it.each([
    "", "abc", "0", "0.00", "-5", "1,29", "1,2900", "12.345", "1.", ".5", "1 290", "฿฿5", "5฿",
    "1e3", "NaN", "12,34,567", "9999999999999999999",
  ])("refuses %j", (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it("reads back what formatMoney writes", () => {
    for (const satang of [1, 40, 129000, 129050, 123456789]) {
      expect(parseMoney(formatMoney(satang))).toBe(satang);
    }
  });
});

describe("splitVat", () => {
  it.each([
    [129000, 120561, 8439],
    [78300, 73178, 5122],
    [390000, 364486, 25514],
    [107, 100, 7],
    [1, 1, 0],
  ])("splits %i into %i and %i", (total, beforeVat, vat) => {
    expect(splitVat(total)).toEqual({ beforeVat, vat });
  });

  it("always adds up to the total", () => {
    for (let total = 1; total <= 5000; total++) {
      const { beforeVat, vat } = splitVat(total);
      expect(beforeVat + vat).toBe(total);
      expect(vat).toBeGreaterThanOrEqual(0);
    }
  });

  it("refuses zero, negative, fractional and enormous totals", () => {
    expect(() => splitVat(0)).toThrow(RangeError);
    expect(() => splitVat(-100)).toThrow(RangeError);
    expect(() => splitVat(10.5)).toThrow(RangeError);
    expect(() => splitVat(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});

// Bangkok is UTC+7 all year. These instants are written in Bangkok time.
const at = (iso: string) => new Date(`${iso}+07:00`);
const now = at("2026-11-23T10:00:00");

describe("formatTime", () => {
  it("says minutes under an hour", () => {
    expect(formatTime(at("2026-11-23T09:48:00"), now)).toBe("12 min ago");
    expect(formatTime(at("2026-11-23T09:00:01"), now)).toBe("59 min ago");
    expect(formatTime(at("2026-11-23T09:59:30"), now)).toBe("just now");
  });

  it("shows the clock for earlier today", () => {
    expect(formatTime(at("2026-11-23T09:00:00"), now)).toBe("09:00");
    expect(formatTime(at("2026-11-23T09:14:00"), at("2026-11-23T18:00:00"))).toBe("09:14");
    expect(formatTime(at("2026-11-23T00:00:00"), at("2026-11-23T23:59:00"))).toBe("00:00");
  });

  it("treats midnight as the start of a day", () => {
    const early = at("2026-11-23T00:10:00");
    expect(formatTime(at("2026-11-22T23:55:00"), early)).toBe("15 min ago");
    expect(formatTime(at("2026-11-22T23:00:00"), early)).toBe("Yesterday 23:00");
    expect(formatTime(at("2026-11-22T00:00:00"), early)).toBe("Yesterday 00:00");
    expect(formatTime(at("2026-11-21T23:59:00"), early)).toBe("Sat 21 Nov");
  });

  it("says yesterday with the clock", () => {
    expect(formatTime(at("2026-11-22T18:40:00"), now)).toBe("Yesterday 18:40");
  });

  it("shows weekday, day and month earlier this year", () => {
    expect(formatTime(at("2026-11-20T12:00:00"), now)).toBe("Fri 20 Nov");
    expect(formatTime(at("2026-01-01T00:00:00"), now)).toBe("Thu 1 Jan");
  });

  it("shows the full date in another year", () => {
    expect(formatTime(at("2025-11-20T12:00:00"), now)).toBe("20 Nov 2025");
  });

  it("handles the year change", () => {
    const newYear = at("2027-01-01T00:20:00");
    expect(formatTime(at("2026-12-31T23:50:00"), newYear)).toBe("30 min ago");
    expect(formatTime(at("2026-12-31T22:00:00"), newYear)).toBe("Yesterday 22:00");
    expect(formatTime(at("2026-12-30T22:00:00"), newYear)).toBe("30 Dec 2026");
  });

  it("reads days in the given time zone, not UTC", () => {
    // 17:30 UTC on the 22nd is 00:30 on the 23rd in Bangkok but still the 22nd in London.
    const moment = new Date("2026-11-22T17:30:00Z");
    const later = new Date("2026-11-23T06:00:00Z");
    expect(formatTime(moment, later)).toBe("00:30");
    expect(formatTime(moment, later, { timeZone: "Europe/London" })).toBe("Yesterday 17:30");
  });

  it("does not call a future moment 'ago'", () => {
    expect(formatTime(at("2026-11-23T10:05:00"), now)).toBe("10:05");
    expect(formatTime(at("2026-11-24T10:05:00"), now)).toBe("Tue 24 Nov");
  });

  it("refuses invalid dates", () => {
    expect(() => formatTime(new Date("nope"), now)).toThrow(RangeError);
    expect(() => formatTime(now, new Date("nope"))).toThrow(RangeError);
  });
});

describe("formatDate", () => {
  it("writes the date in full", () => {
    expect(formatDate(at("2026-11-22T12:00:00"))).toBe("Sunday 22 November");
    expect(formatDate(at("2026-01-01T00:00:00"))).toBe("Thursday 1 January");
  });

  it("uses the zone's day, Bangkok by default", () => {
    const moment = new Date("2026-11-22T20:00:00Z");
    expect(formatDate(moment)).toBe("Monday 23 November");
    expect(formatDate(moment, { timeZone: "UTC" })).toBe("Sunday 22 November");
  });
});
