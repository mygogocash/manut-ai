// Ton's arithmetic: the daily sales summary, the month's books, the flags Ton
// raises and the CSV export. Pure functions over plain entries. Reading orders
// from a shop and sending books to FlowAccount are not done here.
//
// Money is integer satang everywhere. Ton raises flags and never fixes: the
// only entry that is left out is one that cannot be counted at all.
import { DEFAULT_TIME_ZONE, splitVat } from "@manut/format";

export const CHANNELS = ["line", "shopee", "lazada", "shop"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Sale {
  kind: "sale";
  ref: string;
  channel: Channel;
  amountSatang: number;
  /// Milliseconds since the epoch.
  at: number;
}

export interface Refund {
  kind: "refund";
  /// The `ref` of the sale being refunded.
  ref: string;
  amountSatang: number;
  at: number;
}

export interface Expense {
  kind: "expense";
  ref: string;
  category: string;
  amountSatang: number;
  at: number;
}

export type Entry = Sale | Refund | Expense;

export interface BooksOptions {
  /// A VAT registered shop gets VAT figures; any other shop gets none. Default false.
  vatRegistered?: boolean;
  /// Days are counted in this zone. Default `Asia/Bangkok`.
  timeZone?: string;
}

export type Flag =
  | { kind: "refund_without_sale"; ref: string; day: string; at: number }
  | {
      kind: "refund_exceeds_sale";
      ref: string;
      day: string;
      at: number;
      saleSatang: number;
      /// All refunds of the sale up to and including this one.
      refundedSatang: number;
    }
  | { kind: "duplicate_sale_ref"; ref: string; day: string; at: number; firstAt: number }
  | {
      kind: "invalid_amount";
      entryKind: string;
      ref: string;
      /// Null when the amount was not even a number.
      amountSatang: number | null;
      /// Null when the entry has no usable time.
      day: string | null;
    }
  | {
      kind: "invalid_entry";
      entryKind: string;
      ref: string;
      reason: "shape" | "ref" | "time" | "channel" | "category";
      day: string | null;
    };

export interface Count {
  count: number;
  totalSatang: number;
}

export interface VatTotals {
  salesBeforeVatSatang: number;
  salesVatSatang: number;
  refundsBeforeVatSatang: number;
  refundsVatSatang: number;
  netBeforeVatSatang: number;
  netVatSatang: number;
}

export interface Totals {
  sales: Count & { byChannel: Record<Channel, Count> };
  refunds: Count;
  /// Sales less refunds. Can be negative when a refund has no sale in the period.
  netSatang: number;
  /// Null when the shop is not VAT registered: there are no VAT figures at all.
  vat: VatTotals | null;
  expenses: Count & { byCategory: Array<Count & { category: string }> };
}

export interface DailySummary extends Totals {
  date: string;
  flags: Flag[];
}

export interface BookLine {
  date: string;
  ref: string;
  kind: Entry["kind"];
  /// The channel of a sale or the category of an expense; empty for a refund.
  channelOrCategory: string;
  amountSatang: number;
  beforeVatSatang: number | null;
  vatSatang: number | null;
}

export interface MonthBooks {
  month: string;
  timeZone: string;
  vatRegistered: boolean;
  /// One row per day of the month, days with nothing included.
  days: DailySummary[];
  totals: Totals;
  /// Flags for entries in this month, plus flags for entries that have no usable day.
  flags: Flag[];
  lines: BookLine[];
}

/// Splitting a total needs `total * 200` to stay a safe integer; larger amounts
/// (over 450 billion baht) are not real and are refused as invalid.
const MAX_SATANG = Math.floor(Number.MAX_SAFE_INTEGER / 200);

interface Accepted {
  entry: Entry;
  index: number;
  day: string;
  beforeVat: number | null;
  vat: number | null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // An unknown zone throws a RangeError here: that is a mistake in the caller, not in the data.
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/// `2026-11-23` for a moment, as the calendar reads in the zone.
function dayOf(at: number, timeZone: string): string | null {
  if (typeof at !== "number" || !Number.isFinite(at) || Math.abs(at) > 8.64e15) return null;
  const parts = dayFormatter(timeZone).formatToParts(new Date(at));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year").padStart(4, "0")}-${pick("month")}-${pick("day")}`;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_SATANG;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface Prepared {
  accepted: Accepted[];
  /// Flags in the order the entries were given.
  flags: Flag[];
}

function prepare(entries: readonly Entry[], options: BooksOptions): Prepared {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const vatRegistered = options.vatRegistered === true;
  const accepted: Accepted[] = [];
  // Flags are keyed by entry index so they come out in input order whatever
  // order they were found in.
  const flagged: Array<{ index: number; flag: Flag }> = [];

  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      flagged.push({
        index,
        flag: { kind: "invalid_entry", entryKind: "unknown", ref: "", reason: "shape", day: null },
      });
      return;
    }
    const entryKind = typeof entry.kind === "string" ? entry.kind : "unknown";
    const ref = typeof entry.ref === "string" ? entry.ref : "";
    const day = dayOf(entry.at, timeZone);
    const kindOk = entry.kind === "sale" || entry.kind === "refund" || entry.kind === "expense";
    if (!kindOk) {
      flagged.push({ index, flag: { kind: "invalid_entry", entryKind, ref, reason: "shape", day } });
      return;
    }
    if (!isAmount(entry.amountSatang)) {
      const amount = typeof entry.amountSatang === "number" && Number.isFinite(entry.amountSatang) ? entry.amountSatang : null;
      flagged.push({ index, flag: { kind: "invalid_amount", entryKind, ref, amountSatang: amount, day } });
      return;
    }
    const problem =
      ref === "" ? "ref"
      : day === null ? "time"
      : entry.kind === "sale" && !(CHANNELS as readonly unknown[]).includes(entry.channel) ? "channel"
      : entry.kind === "expense" && (typeof entry.category !== "string" || entry.category.trim() === "") ? "category"
      : null;
    if (problem !== null || day === null) {
      flagged.push({
        index,
        flag: { kind: "invalid_entry", entryKind, ref, reason: problem ?? "time", day },
      });
      return;
    }
    // Each sale and each refund is its own receipt, so each is split on its own.
    const split = vatRegistered && entry.kind !== "expense" ? splitVat(entry.amountSatang) : null;
    accepted.push({
      entry,
      index,
      day,
      beforeVat: split ? split.beforeVat : null,
      vat: split ? split.vat : null,
    });
  });

  const byTime = (a: Accepted, b: Accepted) => a.entry.at - b.entry.at || a.index - b.index;

  // The earliest sale of a ref is the real one; later sales with the same ref
  // are flagged but still counted, because Ton never fixes.
  const firstSale = new Map<string, Sale>();
  const sales = accepted.filter((item) => item.entry.kind === "sale").sort(byTime);
  for (const item of sales) {
    const sale = item.entry as Sale;
    const first = firstSale.get(sale.ref);
    if (!first) {
      firstSale.set(sale.ref, sale);
    } else {
      flagged.push({
        index: item.index,
        flag: { kind: "duplicate_sale_ref", ref: sale.ref, day: item.day, at: sale.at, firstAt: first.at },
      });
    }
  }

  const refunded = new Map<string, number>();
  const refunds = accepted.filter((item) => item.entry.kind === "refund").sort(byTime);
  for (const item of refunds) {
    const refund = item.entry as Refund;
    const sale = firstSale.get(refund.ref);
    if (!sale) {
      flagged.push({
        index: item.index,
        flag: { kind: "refund_without_sale", ref: refund.ref, day: item.day, at: refund.at },
      });
      continue;
    }
    const total = (refunded.get(refund.ref) ?? 0) + refund.amountSatang;
    refunded.set(refund.ref, total);
    if (total > sale.amountSatang) {
      flagged.push({
        index: item.index,
        flag: {
          kind: "refund_exceeds_sale",
          ref: refund.ref,
          day: item.day,
          at: refund.at,
          saleSatang: sale.amountSatang,
          refundedSatang: total,
        },
      });
    }
  }

  flagged.sort((a, b) => a.index - b.index);
  return { accepted, flags: flagged.map((item) => item.flag) };
}

function totalsOf(items: readonly Accepted[], vatRegistered: boolean): Totals {
  const byChannel = Object.fromEntries(CHANNELS.map((channel) => [channel, { count: 0, totalSatang: 0 }])) as Record<Channel, Count>;
  const sales: Count = { count: 0, totalSatang: 0 };
  const refunds: Count = { count: 0, totalSatang: 0 };
  const expenses: Count = { count: 0, totalSatang: 0 };
  const categories = new Map<string, Count>();
  const vat: VatTotals = {
    salesBeforeVatSatang: 0,
    salesVatSatang: 0,
    refundsBeforeVatSatang: 0,
    refundsVatSatang: 0,
    netBeforeVatSatang: 0,
    netVatSatang: 0,
  };

  for (const item of items) {
    const entry = item.entry;
    if (entry.kind === "sale") {
      sales.count += 1;
      sales.totalSatang += entry.amountSatang;
      const channel = byChannel[entry.channel];
      channel.count += 1;
      channel.totalSatang += entry.amountSatang;
      vat.salesBeforeVatSatang += item.beforeVat ?? 0;
      vat.salesVatSatang += item.vat ?? 0;
    } else if (entry.kind === "refund") {
      refunds.count += 1;
      refunds.totalSatang += entry.amountSatang;
      vat.refundsBeforeVatSatang += item.beforeVat ?? 0;
      vat.refundsVatSatang += item.vat ?? 0;
    } else {
      expenses.count += 1;
      expenses.totalSatang += entry.amountSatang;
      const category = entry.category;
      const row = categories.get(category) ?? { count: 0, totalSatang: 0 };
      row.count += 1;
      row.totalSatang += entry.amountSatang;
      categories.set(category, row);
    }
  }

  vat.netBeforeVatSatang = vat.salesBeforeVatSatang - vat.refundsBeforeVatSatang;
  vat.netVatSatang = vat.salesVatSatang - vat.refundsVatSatang;
  const byCategory = [...categories.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, row]) => ({ category, ...row }));
  return {
    sales: { ...sales, byChannel },
    refunds,
    netSatang: sales.totalSatang - refunds.totalSatang,
    vat: vatRegistered ? vat : null,
    expenses: { ...expenses, byCategory },
  };
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (!match || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`date must be a real day written YYYY-MM-DD, got "${date}"`);
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/// One day's books. `date` is `YYYY-MM-DD` as the calendar reads in the shop's
/// zone. Throws a RangeError for a date that is not a real day.
export function dailySummary(entries: readonly Entry[], date: string, options: BooksOptions = {}): DailySummary {
  parseDate(date);
  const { accepted, flags } = prepare(entries, options);
  return summaryFor(accepted, flags, date, options.vatRegistered === true);
}

function summaryFor(accepted: readonly Accepted[], flags: readonly Flag[], date: string, vatRegistered: boolean): DailySummary {
  return {
    date,
    ...totalsOf(
      accepted.filter((item) => item.day === date),
      vatRegistered,
    ),
    flags: flags.filter((flag) => flag.day === date),
  };
}

/// A month's books, one row per day. `month` is `YYYY-MM`. Throws a RangeError
/// for a month that is not written like that.
export function monthBooks(entries: readonly Entry[], month: string, options: BooksOptions = {}): MonthBooks {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const year = Number(match?.[1]);
  const monthNumber = Number(match?.[2]);
  if (!match || monthNumber < 1 || monthNumber > 12) {
    throw new RangeError(`month must be written YYYY-MM, got "${month}"`);
  }
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const vatRegistered = options.vatRegistered === true;
  const { accepted, flags } = prepare(entries, options);

  const days: DailySummary[] = [];
  for (let day = 1; day <= daysInMonth(year, monthNumber); day += 1) {
    days.push(summaryFor(accepted, flags, `${month}-${String(day).padStart(2, "0")}`, vatRegistered));
  }

  const inMonth = accepted.filter((item) => item.day.startsWith(`${month}-`)).sort((a, b) => a.entry.at - b.entry.at || a.index - b.index);
  const lines: BookLine[] = inMonth.map((item) => ({
    date: item.day,
    ref: item.entry.ref,
    kind: item.entry.kind,
    channelOrCategory: item.entry.kind === "sale" ? item.entry.channel : item.entry.kind === "expense" ? item.entry.category : "",
    amountSatang: item.entry.amountSatang,
    beforeVatSatang: item.beforeVat,
    vatSatang: item.vat,
  }));

  return {
    month,
    timeZone,
    vatRegistered,
    days,
    totals: totalsOf(inMonth, vatRegistered),
    // A flag with no usable day cannot sit on any day row, so the month carries it.
    flags: flags.filter((flag) => flag.day === null || flag.day.startsWith(`${month}-`)),
    lines,
  };
}

/// Baht with two decimals, made from integer satang so no float is involved.
function baht(satang: number): string {
  const whole = Math.floor(satang / 100);
  return `${whole}.${String(satang - whole * 100).padStart(2, "0")}`;
}

/// A text field that starts with one of these is run as a formula by a
/// spreadsheet, so it gets a leading apostrophe. Tab and carriage return are
/// on the usual lists too.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export const CSV_HEADER = ["date", "ref", "kind", "channel_or_category", "amount", "before_vat", "vat"] as const;

/// RFC 4180 CSV of a month: a header, then one line per entry, joined by CRLF
/// with no line after the last. Refund amounts are positive; the kind column
/// says it is a refund. Before-VAT and VAT are empty for a shop that is not
/// VAT registered and for expenses.
export function booksCsv(month: MonthBooks): string {
  const rows = month.lines.map((line) =>
    [
      line.date,
      line.ref,
      line.kind,
      line.channelOrCategory,
      baht(line.amountSatang),
      line.beforeVatSatang === null ? "" : baht(line.beforeVatSatang),
      line.vatSatang === null ? "" : baht(line.vatSatang),
    ]
      .map(csvField)
      .join(","),
  );
  return [CSV_HEADER.join(","), ...rows].join("\r\n");
}
