// Small time formatters shared by the sidebar and the timeline. `ts` is seconds since epoch. Words and units
// follow the current language; weekday and month names come from Intl in that language.
import { locale, t } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** "Mon" / "周一"; "Monday" / "星期一" with `long`. */
export const weekdayName = (d: Date, long = false) => d.toLocaleDateString(locale(), { weekday: long ? "long" : "short" });
/** "Nov 2" / "11月2日". */
export const monthDay = (d: Date) => d.toLocaleDateString(locale(), { month: "short", day: "numeric" });

/** Sidebar time: "now" (<1 min), "14:02" (today), "Mon" (this week), "Nov 2" (older). */
export function shortTime(ts: number, nowMs = Date.now()): string {
  const d = new Date(ts * 1000);
  if (nowMs - d.getTime() < 60_000) return t("time.nowShort");
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return hhmm(d);
  if (days < 7) return weekdayName(d);
  return monthDay(d);
}

/** Day divider label: "Today", "Yesterday", "Monday", "Nov 2". */
export function dayLabel(ts: number, nowMs = Date.now()): string {
  const d = new Date(ts * 1000);
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return t("time.todayDay");
  if (days === 1) return t("time.yesterday");
  if (days < 7) return weekdayName(d, true);
  return monthDay(d);
}

export const sameDay = (a: number, b: number) => startOfDay(new Date(a * 1000)) === startOfDay(new Date(b * 1000));

/** A moment as a one-line note says it: "14:05" on the day it is, and the day first on any other day ("Nov 22 14:05"),
 *  so a time from yesterday is never taken for one from this morning. Both in ms. */
export function dayTime(atMs: number, nowMs = Date.now()): string {
  const d = new Date(atMs);
  return sameDay(atMs / 1000, nowMs / 1000) ? hhmm(d) : `${monthDay(d)} ${hhmm(d)}`;
}

/** A day in full: "Sunday, November 22" / "11月22日星期日". `atMs` in ms. */
export const longDay = (atMs: number) => new Date(atMs).toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" });

/** "38s", "2m 41s", "1h 4m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("unit.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("unit.ms", { m, s: s % 60 });
  return t("unit.hm", { h: Math.floor(m / 60), m: m % 60 });
}

/** A running turn's age for the sidebar's time slot: "12s", "1m", "2h". */
export function busyFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("unit.s", { n: s });
  if (s < 3600) return t("unit.m", { n: Math.floor(s / 60) });
  return t("unit.h", { n: Math.floor(s / 3600) });
}
