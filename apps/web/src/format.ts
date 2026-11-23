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

/// Thai text gets `lang="th"` so it is read and shaped as Thai; anything else is left to the page language.
export function langOf(text: string): "th" | undefined {
  return /[฀-๿]/.test(text) ? "th" : undefined;
}
