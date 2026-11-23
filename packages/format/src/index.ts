/// How Manut AI writes money and times.
///
/// Money is always integer satang (CLAUDE.md): no float ever decides what a
/// shop is owed, so every function here refuses a fractional or unsafe amount
/// instead of rounding it. Text is English for now; the `locale` argument is
/// already threaded through so Thai can be added without changing callers.

export type Locale = "en";

const SATANG_PER_BAHT = 100;
const BAHT = "฿";
/// Thai VAT is 7 percent and Thai shop prices already include it.
const VAT_PERCENT = 7;

function assertAmount(satang: number, what: string): void {
  if (!Number.isSafeInteger(satang)) {
    throw new RangeError(`${what} must be a whole number of satang`);
  }
}

export interface FormatMoneyOptions {
  /// Show two decimals every time (`฿1,290.00`), for receipts.
  always?: boolean;
  locale?: Locale;
}

/// 129000 gives `฿1,290`; 40 gives `฿0.40`. Negative amounts are refused: a
/// refund is its own screen, not a minus sign.
export function formatMoney(satang: number, options: FormatMoneyOptions = {}): string {
  assertAmount(satang, "amount");
  if (satang < 0) throw new RangeError("amount must not be negative");
  const baht = Math.floor(satang / SATANG_PER_BAHT);
  const rest = satang % SATANG_PER_BAHT;
  // Group digits by hand so the output never depends on the runtime's ICU data.
  const grouped = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (rest === 0 && !options.always) return `${BAHT}${grouped}`;
  return `${BAHT}${grouped}.${String(rest).padStart(2, "0")}`;
}

const TYPED_MONEY = /^฿?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/// Reads what a person types: `1290`, `1,290`, `฿1,290.50`, `1290.5`. Anything
/// else, including zero, negatives, three decimals or misplaced commas, gives
/// `null`: a guessed amount is worse than asking again.
export function parseMoney(text: string): number | null {
  const match = TYPED_MONEY.exec(text.trim());
  if (!match) return null;
  const baht = Number((match[1] ?? "").replaceAll(",", ""));
  const rest = Number((match[2] ?? "").padEnd(2, "0"));
  const satang = baht * SATANG_PER_BAHT + rest;
  if (!Number.isSafeInteger(satang) || satang <= 0) return null;
  return satang;
}

export interface VatSplit {
  beforeVat: number;
  vat: number;
}

/// Splits a VAT-inclusive total. `beforeVat` is the total over 1.07, rounded
/// half up in integers, and `vat` is what is left, so the two always add up
/// to the total exactly.
export function splitVat(totalSatang: number): VatSplit {
  assertAmount(totalSatang, "total");
  if (totalSatang <= 0) throw new RangeError("total must be more than zero");
  const divisor = 100 + VAT_PERCENT;
  const scaled = totalSatang * 100;
  if (!Number.isSafeInteger(scaled * 2)) throw new RangeError("total is too large");
  // Rounding half up: floor((2 * scaled + divisor) / (2 * divisor)).
  const beforeVat = Math.floor((2 * scaled + divisor) / (2 * divisor));
  return { beforeVat, vat: totalSatang - beforeVat };
}

export const DEFAULT_TIME_ZONE = "Asia/Bangkok";

interface Calendar {
  year: number;
  month: string;
  day: number;
  weekday: string;
  weekdayLong: string;
  monthLong: string;
  hour: string;
  minute: string;
  /// Days since 1970-01-01 of the calendar date in the zone, to compare days.
  dayNumber: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function calendarOf(moment: Date, timeZone: string): Calendar {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(moment)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const day = Number(parts.day);
  const monthIndex = MONTHS_SHORT.indexOf(parts.month ?? "");
  if (monthIndex < 0 || !Number.isFinite(year) || !Number.isFinite(day)) {
    throw new RangeError("could not read the date in that time zone");
  }
  return {
    year,
    month: parts.month ?? "",
    day,
    weekday: parts.weekday ?? "",
    weekdayLong: WEEKDAYS_LONG[WEEKDAYS_SHORT.indexOf(parts.weekday ?? "")] ?? "",
    monthLong: MONTHS_LONG[monthIndex] ?? "",
    hour: (parts.hour ?? "00").padStart(2, "0"),
    minute: (parts.minute ?? "00").padStart(2, "0"),
    dayNumber: Math.round(Date.UTC(year, monthIndex, day) / 86_400_000),
  };
}

// Month and weekday names are fixed tables, not ICU output, so the text is the
// same on every runtime (the Worker, a browser and the desktop app).
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface FormatTimeOptions {
  /// An IANA time zone name; days and clock times are read in it.
  timeZone?: string;
  locale?: Locale;
}

function checkDate(date: Date, what: string): void {
  if (Number.isNaN(date.getTime())) throw new RangeError(`${what} is not a valid date`);
}

/// A moment as the app shows it, relative to `now`:
/// under an hour ago `12 min ago` (`just now` under a minute), earlier today
/// `09:14`, yesterday `Yesterday 18:40`, earlier this year `Fri 20 Nov`,
/// another year `20 Nov 2025`. A moment ahead of `now` is not "ago", so it
/// falls through to the clock and calendar forms.
export function formatTime(moment: Date, now: Date, options: FormatTimeOptions = {}): string {
  checkDate(moment, "moment");
  checkDate(now, "now");
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const elapsed = now.getTime() - moment.getTime();
  if (elapsed >= 0 && elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return minutes === 0 ? "just now" : `${minutes} min ago`;
  }
  const at = calendarOf(moment, timeZone);
  const today = calendarOf(now, timeZone);
  const clock = `${at.hour}:${at.minute}`;
  if (at.dayNumber === today.dayNumber) return clock;
  if (at.dayNumber === today.dayNumber - 1) return `Yesterday ${clock}`;
  if (at.year === today.year) return `${at.weekday} ${at.day} ${at.month}`;
  return `${at.day} ${at.month} ${at.year}`;
}

/// A date in full, without the year: `Sunday 22 November`.
export function formatDate(moment: Date, options: FormatTimeOptions = {}): string {
  checkDate(moment, "moment");
  const at = calendarOf(moment, options.timeZone ?? DEFAULT_TIME_ZONE);
  return `${at.weekdayLong} ${at.day} ${at.monthLong}`;
}
