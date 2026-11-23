// History's rules, kept apart from the page so they can be tested without one. The page lists every thread of the
// team, newest first, grouped by the day of its last activity: Today, Yesterday, then dates, as the design canvas's
// History board does. Its search box filters by title, the one thing every thread has that the store already holds.
import { threadsNewestFirst, type MemberThread } from "../sidebar/menu";
import { LANG_TAG, lang as currentLang, t, type Lang } from "../i18n";
import type { ThreadRow } from "../threads/types";

export type HistoryEntry = MemberThread;

/** A day's entries, newest first. Any entry that carries its time as `ts` (seconds) can be grouped: History groups its
 *  threads and its jobs, and the activity log its events. */
export interface HistoryDay<T extends { ts: number } = HistoryEntry> {
  /** this computer's midnight that starts the day, in ms */
  day: number;
  /** how the day is named: the word for today or yesterday, else its date */
  when: "today" | "yesterday" | "earlier";
  entries: T[];
}

/** Every thread of the listed members, newest activity first. */
export function historyEntries(threads: Readonly<Record<string, readonly ThreadRow[]>>, members: readonly string[]): HistoryEntry[] {
  return threadsNewestFirst(threads, members);
}

/** The entries whose title holds `query`, in any case and with the spaces around it ignored. A thread with no title
 *  yet is matched by the name the page shows for it (`untitled`), so what the person reads is what they can find. */
export function matchTitle(entries: readonly HistoryEntry[], query: string, untitled: string): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => (e.row.title || untitled).toLowerCase().includes(q));
}

const midnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Newest-first entries grouped by the day of their last activity, on this computer's clock, newest day first. */
export function byDay<T extends { ts: number }>(entries: readonly T[], nowMs: number): HistoryDay<T>[] {
  const today = midnight(nowMs);
  const n = new Date(today);
  // Yesterday's midnight comes from the calendar, not 24 hours back, so a change of clocks cannot move it.
  const yesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  const days: HistoryDay<T>[] = [];
  for (const e of entries) {
    const day = midnight(e.ts * 1000);
    let group = days[days.length - 1];
    if (!group || group.day !== day) {
      group = { day, when: day === today ? "today" : day === yesterday ? "yesterday" : "earlier", entries: [] };
      days.push(group);
    }
    group.entries.push(e);
  }
  return days;
}

/** A day written out ("Sunday 22 November"), with the year only when it is not this year. English follows the British
 *  order the canvas writes and listText uses; the other languages follow their own. */
export function fullDate(dayMs: number, nowMs: number, l: Lang = currentLang()): string {
  const d = new Date(dayMs);
  const otherYear = d.getFullYear() !== new Date(nowMs).getFullYear();
  return d.toLocaleDateString(l === "en" ? "en-GB" : LANG_TAG[l], { weekday: "long", day: "numeric", month: "long", ...(otherYear ? { year: "numeric" } : {}) });
}

/** How a day's band names it: Today or Yesterday with its date beside, or the date alone. */
export function dayBand(d: Pick<HistoryDay<never>, "day" | "when">, nowMs: number): { label: string; date: string | null } {
  return {
    label: d.when === "today" ? t("time.todayDay") : d.when === "yesterday" ? t("time.yesterday") : fullDate(d.day, nowMs),
    date: d.when === "earlier" ? null : fullDate(d.day, nowMs),
  };
}
