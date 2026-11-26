import { describe, expect, it } from "vitest";
import { dayOffset, endOfShopDay, formatBaht, formatClock, formatIsoDate, formatStamp, formatWeekdayDate, langOf,
  parseBahtToSatang } from "../src/format";

describe("money and time", () => {
  it("writes baht with the sign first and satang only when there are some", () => {
    expect(formatBaht(129000)).toBe("฿1,290");
    expect(formatBaht(129050)).toBe("฿1,290.50");
    expect(formatBaht(18600)).toBe("฿186");
    expect(formatBaht(5)).toBe("฿0.05");
    expect(formatBaht(123456789)).toBe("฿1,234,567.89");
  });

  it("reads baht as exact satang and refuses anything unclear", () => {
    expect(parseBahtToSatang("1,290")).toBe(129000);
    expect(parseBahtToSatang("฿1290.5")).toBe(129050);
    expect(parseBahtToSatang(" 0.29 ")).toBe(29);
    expect(parseBahtToSatang("12,34")).toBeNull();
    expect(parseBahtToSatang("1.234")).toBeNull();
    expect(parseBahtToSatang("0")).toBeNull();
    expect(parseBahtToSatang("-5")).toBeNull();
    expect(parseBahtToSatang("")).toBeNull();
  });

  it("writes 24-hour times in the shop's time zone", () => {
    expect(formatClock("2026-11-23T12:42:00Z")).toBe("19:42");
    expect(formatClock("2026-11-22T17:05:00Z")).toBe("00:05");
    const now = Date.parse("2026-11-23T03:00:00Z");
    expect(dayOffset("2026-11-23T16:59:00Z", now)).toBe(0);
    expect(dayOffset("2026-11-23T17:00:00Z", now)).toBe(1);
    expect(formatStamp("2026-11-23T02:12:00Z", now)).toBe("09:12");
    expect(formatStamp("2026-11-24T03:00:00Z", now)).toBe("24 November 10:00");
  });

  it("writes the shop's calendar day as an ISO 8601 date", () => {
    expect(formatIsoDate("2026-11-23T03:00:00Z")).toBe("2026-11-23");
    expect(formatIsoDate("2026-11-23T16:59:00Z")).toBe("2026-11-23");
    expect(formatIsoDate("2026-11-23T17:00:00Z")).toBe("2026-11-24");
    expect(formatIsoDate("2026-01-04T20:00:00Z")).toBe("2026-01-05");
  });

  it("marks Thai text so it is read as Thai", () => {
    expect(langOf("ขอบคุณค่ะ")).toBe("th");
    expect(langOf("Thank you")).toBeUndefined();
  });

  it("writes a day with its weekday on the shop's calendar, whatever the viewer's zone", () => {
    expect(formatWeekdayDate("2026-11-27T03:00:00Z")).toBe("Friday 27 November");
    expect(formatWeekdayDate("2026-11-27T16:59:59Z")).toBe("Friday 27 November");
    // 17:00 UTC is already the next morning in Bangkok.
    expect(formatWeekdayDate("2026-11-27T17:00:00Z")).toBe("Saturday 28 November");
    expect(formatWeekdayDate("2026-11-22T03:00:00Z")).toBe("Sunday 22 November");
  });

  it("finds the last moment of a day on the shop's calendar, and refuses what is not a day", () => {
    expect(endOfShopDay("2026-11-27")).toBe("2026-11-27T16:59:59.000Z");
    expect(endOfShopDay("2026-12-31")).toBe("2026-12-31T16:59:59.000Z");
    expect(formatIsoDate(endOfShopDay("2026-11-27")!)).toBe("2026-11-27");
    for (const bad of ["", "27/11/2026", "2026-13-01", "2026-02-30", "2026-11-27T10:00", " 2026-11-27", "tomorrow"]) {
      expect(endOfShopDay(bad)).toBeNull();
    }
  });
});
