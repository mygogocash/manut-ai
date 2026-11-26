/// Money and time the way the canvas writes them: the baht sign first (฿1,290), 24-hour clock times, and
/// every time in the shop's own zone, whatever zone the viewer's device is in.

export const SHOP_TIME_ZONE = "Asia/Bangkok";

/// ฿1,290 for whole baht, ฿1,290.50 when there are satang.
export function formatBaht(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.round(satang));
  const baht = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}฿${whole}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/// Reads "1290", "1,290", "฿1,290.50" or "1290.5" as satang. Anything else, zero or negative is null. The
/// digits are read as text, never through a float, so 0.29 baht is exactly 29 satang.
export function parseBahtToSatang(input: string): number | null {
  const text = input.replace(/[฿\s]/g, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(text)) return null;
  const [whole = "", fraction = ""] = text.replace(/,/g, "").split(".");
  const satang = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(satang) || satang <= 0) return null;
  return satang;
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHOP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/// 14:05
export function formatClock(iso: string, locale = "en-GB"): string {
  let format = clockFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      timeZone: SHOP_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    clockFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

/// 24 November
export function formatDate(iso: string, locale = "en-GB"): string {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeZone: SHOP_TIME_ZONE, day: "numeric", month: "long" });
    dateFormats.set(locale, format);
  }
  return format.format(new Date(iso));
}

/// 2026-11-24: the shop's calendar day as an ISO 8601 date, for file names. Built from the parts, so it
/// never depends on how a locale happens to order or punctuate a date.
export function formatIsoDate(iso: string): string {
  const parts = dayKeyFormat.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/// Whole days from `now` to `iso` on the shop's calendar: 0 today, 1 tomorrow, -1 yesterday.
export function dayOffset(iso: string, now: number): number {
  const key = (ms: number) => Date.parse(`${dayKeyFormat.format(new Date(ms))}T00:00:00Z`);
  return Math.round((key(Date.parse(iso)) - key(now)) / (24 * 60 * 60 * 1000));
}

/// The console's short stamp: "09:12" today, "22 November 09:12" on any other day.
export function formatStamp(iso: string, now: number = Date.now()): string {
  const clock = formatClock(iso);
  return dayOffset(iso, now) === 0 ? clock : `${formatDate(iso)} ${clock}`;
}

const weekdayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: SHOP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

/// Friday 27 November: a day with its weekday, as the canvas writes "away until Friday 27 November". Built from the parts,
/// as `formatIsoDate` is, so it never depends on how a locale happens to punctuate a date.
export function formatWeekdayDate(iso: string): string {
  const parts = weekdayFormat.formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

/// The shop's zone has no daylight saving, so its offset from UTC never changes.
const SHOP_OFFSET = "+07:00";
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/// The last second of a day on the shop's calendar ("2026-11-27", as a date field writes it), as an ISO 8601 time in UTC:
/// the moment an owner who says "until Friday" is still away at. Null for anything that is not a day that exists.
export function endOfShopDay(day: string): string | null {
  if (!CALENDAR_DAY.test(day)) return null;
  const ms = Date.parse(`${day}T23:59:59${SHOP_OFFSET}`);
  if (!Number.isFinite(ms)) return null;
  // A day that does not exist ("2026-02-30") may be rolled into the next month: only a time that reads back as the same
  // day on the shop's calendar is that day.
  const iso = new Date(ms).toISOString();
  return formatIsoDate(iso) === day ? iso : null;
}

/// Thai text gets `lang="th"` so it is read and shaped as Thai; anything else is left to the page language.
export function langOf(text: string): "th" | undefined {
  return /[฀-๿]/.test(text) ? "th" : undefined;
}
