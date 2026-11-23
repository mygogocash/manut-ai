import { describe, expect, it } from "vitest";
import { dayOffset, formatBaht, formatClock, formatStamp, langOf, parseBahtToSatang } from "../src/format";

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

  it("marks Thai text so it is read as Thai", () => {
    expect(langOf("ขอบคุณค่ะ")).toBe("th");
    expect(langOf("Thank you")).toBeUndefined();
  });
});
