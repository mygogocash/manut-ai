import { describe, expect, it } from "vitest";
import { splitVat } from "@manut/format";
import { booksCsv, dailySummary, monthBooks, type Entry } from "../src/index";

/// A moment as the clock reads in Bangkok (UTC+7, no daylight saving).
const bkk = (y: number, m: number, d: number, h = 12, mi = 0) => Date.UTC(y, m - 1, d, h - 7, mi);

const sale = (ref: string, amountSatang: number, at: number, channel: "line" | "shopee" | "lazada" | "shop" = "line"): Entry => ({
  kind: "sale", ref, channel, amountSatang, at,
});
const refund = (ref: string, amountSatang: number, at: number): Entry => ({ kind: "refund", ref, amountSatang, at });
const expense = (ref: string, category: string, amountSatang: number, at: number): Entry => ({
  kind: "expense", ref, category, amountSatang, at,
});

describe("dailySummary", () => {
  it("counts sales by channel, refunds, net and expenses without VAT figures for an unregistered shop", () => {
    const entries = [
      sale("A1", 129000, bkk(2026, 11, 23, 9)),
      sale("A2", 78300, bkk(2026, 11, 23, 10), "shopee"),
      sale("A3", 5000, bkk(2026, 11, 23, 11), "line"),
      refund("A2", 10000, bkk(2026, 11, 23, 15)),
      expense("E1", "packaging", 20000, bkk(2026, 11, 23, 8)),
      expense("E2", "ads", 30000, bkk(2026, 11, 23, 9)),
      expense("E3", "ads", 1000, bkk(2026, 11, 23, 9)),
    ];
    const day = dailySummary(entries, "2026-11-23");
    expect(day.sales.count).toBe(3);
    expect(day.sales.totalSatang).toBe(212300);
    expect(day.sales.byChannel).toEqual({
      line: { count: 2, totalSatang: 134000 },
      shopee: { count: 1, totalSatang: 78300 },
      lazada: { count: 0, totalSatang: 0 },
      shop: { count: 0, totalSatang: 0 },
    });
    expect(day.refunds).toEqual({ count: 1, totalSatang: 10000 });
    expect(day.netSatang).toBe(202300);
    expect(day.vat).toBeNull();
    expect(day.expenses).toEqual({
      count: 3,
      totalSatang: 51000,
      byCategory: [
        { category: "ads", count: 2, totalSatang: 31000 },
        { category: "packaging", count: 1, totalSatang: 20000 },
      ],
    });
    expect(day.flags).toEqual([]);
  });

  it("splits VAT on every sale and every refund on its own for a registered shop", () => {
    const entries = [
      sale("A1", 129000, bkk(2026, 11, 23, 9)),
      sale("A2", 78300, bkk(2026, 11, 23, 10)),
      sale("A3", 390000, bkk(2026, 11, 23, 11)),
      refund("A1", 129000, bkk(2026, 11, 23, 12)),
      expense("E1", "rent", 100000, bkk(2026, 11, 23, 8)),
    ];
    const day = dailySummary(entries, "2026-11-23", { vatRegistered: true });
    expect(day.vat).toEqual({
      salesBeforeVatSatang: 120561 + 73178 + 364486,
      salesVatSatang: 8439 + 5122 + 25514,
      refundsBeforeVatSatang: 120561,
      refundsVatSatang: 8439,
      netBeforeVatSatang: 73178 + 364486,
      netVatSatang: 5122 + 25514,
    });
    expect(day.vat!.salesBeforeVatSatang + day.vat!.salesVatSatang).toBe(day.sales.totalSatang);
    expect(day.vat!.netBeforeVatSatang + day.vat!.netVatSatang).toBe(day.netSatang);
  });

  it("sums the splits, not the split of the sum", () => {
    // Two receipts of 1 satang each split to 1 + 0 each; the split of 2 satang is 2 + 0 too,
    // but 5 + 5 splits to 5 + 0 twice while 10 splits to 9 + 1.
    const entries = [sale("A", 5, bkk(2026, 11, 23)), sale("B", 5, bkk(2026, 11, 23))];
    const day = dailySummary(entries, "2026-11-23", { vatRegistered: true });
    expect(day.vat!.salesBeforeVatSatang).toBe(splitVat(5).beforeVat * 2);
    expect(day.vat!.salesBeforeVatSatang).not.toBe(splitVat(10).beforeVat);
  });

  it("puts a day across midnight in Bangkok on the right date", () => {
    const entries = [
      sale("A", 1000, bkk(2026, 11, 22, 23, 59)),
      sale("B", 2000, bkk(2026, 11, 23, 0, 0)),
      sale("C", 4000, bkk(2026, 11, 23, 23, 59)),
      sale("D", 8000, bkk(2026, 11, 24, 0, 0)),
    ];
    expect(dailySummary(entries, "2026-11-22").sales.totalSatang).toBe(1000);
    expect(dailySummary(entries, "2026-11-23").sales.totalSatang).toBe(6000);
    expect(dailySummary(entries, "2026-11-24").sales.totalSatang).toBe(8000);
    // 17:00 UTC on the 22nd is already the 23rd in Bangkok.
    expect(dailySummary([sale("Z", 100, Date.UTC(2026, 10, 22, 17, 0))], "2026-11-23").sales.count).toBe(1);
  });

  it("counts days in another time zone when asked", () => {
    const entries = [sale("A", 1000, Date.UTC(2026, 10, 23, 23, 30))];
    expect(dailySummary(entries, "2026-11-23", { timeZone: "UTC" }).sales.count).toBe(1);
    expect(dailySummary(entries, "2026-11-24", { timeZone: "Asia/Bangkok" }).sales.count).toBe(1);
    expect(dailySummary(entries, "2026-11-23", { timeZone: "America/Los_Angeles" }).sales.count).toBe(1);
  });

  it("is empty, with zeros, for a day with nothing", () => {
    const day = dailySummary([], "2026-11-23", { vatRegistered: true });
    expect(day.sales.count).toBe(0);
    expect(day.netSatang).toBe(0);
    expect(day.vat).toEqual({
      salesBeforeVatSatang: 0, salesVatSatang: 0, refundsBeforeVatSatang: 0, refundsVatSatang: 0,
      netBeforeVatSatang: 0, netVatSatang: 0,
    });
    expect(day.expenses.byCategory).toEqual([]);
  });

  it("refuses a date that is not a real day", () => {
    for (const bad of ["2026-11-31", "2026-13-01", "2026-1-1", "", "2026-02-29", "yesterday"]) {
      expect(() => dailySummary([], bad)).toThrow(RangeError);
    }
    expect(() => dailySummary([], "2028-02-29")).not.toThrow();
  });
});

describe("flags", () => {
  const at = bkk(2026, 11, 23, 10);

  it("flags a refund with no sale and still counts it", () => {
    const day = dailySummary([refund("NOPE", 5000, at)], "2026-11-23");
    expect(day.flags).toEqual([{ kind: "refund_without_sale", ref: "NOPE", day: "2026-11-23", at }]);
    expect(day.refunds).toEqual({ count: 1, totalSatang: 5000 });
    expect(day.netSatang).toBe(-5000);
  });

  it("accepts a refund on a later day than its sale", () => {
    const entries = [sale("A", 10000, bkk(2026, 11, 20)), refund("A", 10000, bkk(2026, 11, 23))];
    expect(dailySummary(entries, "2026-11-23").flags).toEqual([]);
  });

  it("flags refunds of one sale that together exceed it, from the refund that tips it over", () => {
    const entries = [
      sale("A", 10000, bkk(2026, 11, 23, 9)),
      refund("A", 6000, bkk(2026, 11, 23, 10)),
      refund("A", 4000, bkk(2026, 11, 23, 11)),
      refund("A", 1, bkk(2026, 11, 23, 12)),
    ];
    const flags = dailySummary(entries, "2026-11-23").flags;
    expect(flags).toEqual([
      { kind: "refund_exceeds_sale", ref: "A", day: "2026-11-23", at: bkk(2026, 11, 23, 12), saleSatang: 10000, refundedSatang: 10001 },
    ]);
    expect(dailySummary(entries, "2026-11-23").refunds.totalSatang).toBe(10001);
  });

  it("flags the second sale with the same ref and counts both", () => {
    const entries = [sale("A", 1000, bkk(2026, 11, 23, 11)), sale("A", 1000, bkk(2026, 11, 23, 9))];
    const day = dailySummary(entries, "2026-11-23");
    expect(day.sales.count).toBe(2);
    expect(day.flags).toEqual([
      { kind: "duplicate_sale_ref", ref: "A", day: "2026-11-23", at: bkk(2026, 11, 23, 11), firstAt: bkk(2026, 11, 23, 9) },
    ]);
  });

  it("puts a flag on the day of the entry it is about", () => {
    const entries = [sale("A", 1000, bkk(2026, 11, 22)), sale("A", 1000, bkk(2026, 11, 23))];
    expect(dailySummary(entries, "2026-11-22").flags).toEqual([]);
    expect(dailySummary(entries, "2026-11-23").flags).toHaveLength(1);
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "100" as unknown as number, undefined as unknown as number])(
    "leaves out an entry with amount %s and flags it",
    (amount) => {
      const entries = [sale("A", amount, at), sale("B", 1000, at)];
      const day = dailySummary(entries, "2026-11-23", { vatRegistered: true });
      expect(day.sales.count).toBe(1);
      expect(day.sales.totalSatang).toBe(1000);
      expect(day.flags).toHaveLength(1);
      expect(day.flags[0]).toMatchObject({ kind: "invalid_amount", entryKind: "sale", ref: "A", day: "2026-11-23" });
    },
  );

  it("flags an invalid refund or expense amount too", () => {
    const day = dailySummary([refund("A", 0, at), expense("E", "x", -1, at)], "2026-11-23");
    expect(day.flags.map((flag) => flag.kind)).toEqual(["invalid_amount", "invalid_amount"]);
    expect(day.refunds.count).toBe(0);
    expect(day.expenses.count).toBe(0);
  });

  it("does not let an invalid refund count towards a sale's limit", () => {
    const entries = [sale("A", 1000, at), refund("A", -1000, at), refund("A", 1000, at)];
    expect(dailySummary(entries, "2026-11-23").flags.map((flag) => flag.kind)).toEqual(["invalid_amount"]);
  });

  it("keeps the flags in the order the entries came", () => {
    const entries = [refund("X", 1, at), sale("A", 0, at), sale("D", 5, at), sale("D", 5, at)];
    expect(dailySummary(entries, "2026-11-23").flags.map((flag) => flag.kind)).toEqual([
      "refund_without_sale",
      "invalid_amount",
      "duplicate_sale_ref",
    ]);
  });

  it("leaves out and flags entries it cannot place or name, without throwing", () => {
    const entries = [
      sale("", 1000, at),
      { ...sale("A", 1000, at), at: Number.NaN },
      { ...sale("B", 1000, at), channel: "tiktok" as "line" },
      expense("E", "  ", 1000, at),
      { kind: "gift", ref: "G", amountSatang: 1000, at } as unknown as Entry,
      null as unknown as Entry,
      sale("OK", 1000, at),
    ];
    const month = monthBooks(entries, "2026-11");
    expect(month.totals.sales.count).toBe(1);
    expect(month.flags.map((flag) => (flag.kind === "invalid_entry" ? flag.reason : flag.kind))).toEqual([
      "ref", "time", "channel", "category", "shape", "shape",
    ]);
    // Flags with no day belong to the month, not to a day row.
    expect(month.days.every((row) => row.flags.every((flag) => flag.day === row.date))).toBe(true);
    expect(month.flags.filter((flag) => flag.day === null)).toHaveLength(2);
  });
});

describe("monthBooks", () => {
  it.each([
    ["2026-02", 28],
    ["2028-02", 29],
    ["2026-04", 30],
    ["2026-11", 30],
    ["2026-12", 31],
    ["2026-01", 31],
  ])("has one row per day for %s", (month, count) => {
    const books = monthBooks([], month);
    expect(books.days).toHaveLength(count);
    expect(books.days[0]!.date).toBe(`${month}-01`);
    expect(books.days.at(-1)!.date).toBe(`${month}-${count}`);
    expect(books.totals.sales.count).toBe(0);
  });

  it("refuses a month not written YYYY-MM", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "2026", "2026-11-01", "nov"]) {
      expect(() => monthBooks([], bad)).toThrow(RangeError);
    }
  });

  const entries: Entry[] = [
    sale("A1", 129000, bkk(2026, 10, 31, 23, 59)),
    sale("A2", 78300, bkk(2026, 11, 1, 0, 0), "shopee"),
    sale("A3", 390000, bkk(2026, 11, 15, 13), "lazada"),
    sale("A4", 33333, bkk(2026, 11, 30, 23, 59), "shop"),
    sale("A5", 777, bkk(2026, 12, 1, 0, 0)),
    refund("A2", 1001, bkk(2026, 11, 2, 9)),
    refund("A3", 99999, bkk(2026, 11, 30, 10)),
    expense("E1", "rent", 500000, bkk(2026, 11, 5, 9)),
    expense("E2", "ads", 123, bkk(2026, 11, 5, 9)),
  ];

  it.each([false, true])("makes the days add up to the month (VAT registered: %s)", (vatRegistered) => {
    const books = monthBooks(entries, "2026-11", { vatRegistered });
    const sum = (pick: (row: (typeof books.days)[number]) => number) => books.days.reduce((total, row) => total + pick(row), 0);
    expect(sum((row) => row.sales.totalSatang)).toBe(books.totals.sales.totalSatang);
    expect(sum((row) => row.sales.count)).toBe(3);
    expect(sum((row) => row.refunds.totalSatang)).toBe(books.totals.refunds.totalSatang);
    expect(sum((row) => row.netSatang)).toBe(books.totals.netSatang);
    expect(sum((row) => row.expenses.totalSatang)).toBe(books.totals.expenses.totalSatang);
    for (const channel of ["line", "shopee", "lazada", "shop"] as const) {
      expect(sum((row) => row.sales.byChannel[channel].totalSatang)).toBe(books.totals.sales.byChannel[channel].totalSatang);
    }
    expect(books.totals.sales.totalSatang).toBe(78300 + 390000 + 33333);
    expect(books.totals.netSatang).toBe(78300 + 390000 + 33333 - 1001 - 99999);
    if (vatRegistered) {
      for (const key of Object.keys(books.totals.vat!) as Array<keyof NonNullable<typeof books.totals.vat>>) {
        expect(sum((row) => row.vat![key])).toBe(books.totals.vat![key]);
      }
      expect(books.totals.vat!.salesBeforeVatSatang + books.totals.vat!.salesVatSatang).toBe(books.totals.sales.totalSatang);
    } else {
      expect(books.totals.vat).toBeNull();
      expect(books.days.every((row) => row.vat === null)).toBe(true);
    }
  });

  it("leaves other months out, includes empty days, and matches dailySummary", () => {
    const books = monthBooks(entries, "2026-11");
    expect(books.days[2]!.sales.count).toBe(0);
    expect(books.days[0]).toEqual(dailySummary(entries, "2026-11-01"));
    expect(books.lines.map((line) => line.ref)).toEqual(["A2", "A2", "E1", "E2", "A3", "A3", "A4"]);
    expect(books.lines.every((line) => line.date.startsWith("2026-11-"))).toBe(true);
  });

  it("carries the flags of its own days", () => {
    const books = monthBooks([...entries, refund("MISSING", 1, bkk(2026, 11, 9)), refund("A5", 1, bkk(2026, 11, 9))], "2026-11");
    expect(books.flags.map((flag) => flag.kind)).toEqual(["refund_without_sale"]);
    expect(books.days[8]!.flags).toHaveLength(1);
  });

  it("reports the zone and the VAT setting it used", () => {
    expect(monthBooks([], "2026-11")).toMatchObject({ timeZone: "Asia/Bangkok", vatRegistered: false });
    expect(monthBooks([], "2026-11", { vatRegistered: true, timeZone: "UTC" })).toMatchObject({ timeZone: "UTC", vatRegistered: true });
  });
});

describe("booksCsv", () => {
  const lines = (csv: string) => csv.split("\r\n");

  it("writes a header and one line per entry in time order, amounts as baht made from integers", () => {
    const entries = [
      expense("E1", "packaging", 20050, bkk(2026, 11, 5, 9)),
      sale("A2", 129000, bkk(2026, 11, 2, 10), "shopee"),
      refund("A2", 5, bkk(2026, 11, 3, 10)),
    ];
    const csv = booksCsv(monthBooks(entries, "2026-11", { vatRegistered: true }));
    expect(lines(csv)).toEqual([
      "date,ref,kind,channel_or_category,amount,before_vat,vat",
      "2026-11-02,A2,sale,shopee,1290.00,1205.61,84.39",
      "2026-11-03,A2,refund,,0.05,0.05,0.00",
      "2026-11-05,E1,expense,packaging,200.50,,",
    ]);
  });

  it("leaves VAT empty for an unregistered shop", () => {
    const csv = booksCsv(monthBooks([sale("A", 100, bkk(2026, 11, 2))], "2026-11"));
    expect(lines(csv)[1]).toBe("2026-11-02,A,sale,line,1.00,,");
  });

  it("has only the header for an empty month", () => {
    expect(booksCsv(monthBooks([], "2026-11"))).toBe("date,ref,kind,channel_or_category,amount,before_vat,vat");
  });

  it("quotes fields with commas, quotes and line breaks as RFC 4180 says", () => {
    const entries = [
      expense("a,b", 'say "hi"', 100, bkk(2026, 11, 2, 9)),
      expense("line\nbreak", "plain", 100, bkk(2026, 11, 2, 10)),
      expense("cr\rhere", "x", 100, bkk(2026, 11, 2, 11)),
    ];
    const csv = booksCsv(monthBooks(entries, "2026-11"));
    expect(csv).toContain('2026-11-02,"a,b",expense,"say ""hi""",1.00,,');
    expect(csv).toContain('"line\nbreak"');
    expect(csv).toContain('"cr\rhere"');
  });

  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx"])("guards a field that starts with %j so a spreadsheet never runs it", (ref) => {
    const csv = booksCsv(monthBooks([expense(ref, "x", 100, bkk(2026, 11, 2))], "2026-11"));
    const row = lines(csv)[1]!;
    expect(row.split(",")[1]).toBe(`'${ref}`);
  });

  it("guards and quotes together, and guards the category and channel columns", () => {
    const csv = booksCsv(monthBooks([expense("=1,2", "=HYPERLINK(x)", 100, bkk(2026, 11, 2))], "2026-11"));
    expect(lines(csv)[1]).toBe(`2026-11-02,"'=1,2",expense,'=HYPERLINK(x),1.00,,`);
  });

  it("does not guard an equals sign that is not at the start", () => {
    const csv = booksCsv(monthBooks([expense("a=b", "x-y", 100, bkk(2026, 11, 2))], "2026-11"));
    expect(lines(csv)[1]).toBe("2026-11-02,a=b,expense,x-y,1.00,,");
  });

  it("prints large and small amounts without a float", () => {
    const csv = booksCsv(monthBooks([sale("A", 123456789012, bkk(2026, 11, 2)), sale("B", 1, bkk(2026, 11, 2))], "2026-11"));
    expect(csv).toContain(",1234567890.12,");
    expect(csv).toContain(",0.01,");
  });
});
