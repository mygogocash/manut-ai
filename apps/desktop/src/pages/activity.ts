// The activity log's rules, kept apart from the page so they can be tested without one: which events a filter keeps, how
// they group into days, what a customer's message shows and when, and what an export holds. The page is the design
// canvas's Activity.dc.html. Every day here is this computer's, as History's are.
//
// A customer's message text is private. It is hidden until the owner shows it, never searched, and left out of an export
// unless the owner ticks "Include customer message text" for that export (the tick is not kept for the next one).
import { hhmm } from "../app/time";
import { ACTIVITY_KINDS, type ActivityEvent, type ActivityKind } from "../runtime/mission";
import { toCsv } from "./csv";
import { byDay, type HistoryDay } from "./history";
import { pad } from "../lib/pad";

export const ALL = "all";

export type Range = "today" | "7" | "30" | "custom";
/** The date ranges, in the order their chips show them. */
export const RANGES: readonly Range[] = ["today", "7", "30", "custom"];

export interface Filters {
  /** a member's name, `OWNER`, or ALL */
  who: string;
  kind: ActivityKind | typeof ALL;
  range: Range;
  /** `YYYY-MM-DD`, for a custom range; "" is open */
  from: string;
  to: string;
  query: string;
}

/** The canvas opens on everyone, every kind and the last 7 days. */
export const NO_FILTERS: Filters = { who: ALL, kind: ALL, range: "7", from: "", to: "", query: "" };

export const filtersOn = (f: Filters): boolean => f.who !== ALL || f.kind !== ALL || f.range !== "7" || f.query.trim() !== "";

export type FilterAction =
  | { type: "who"; who: string }
  | { type: "kind"; kind: ActivityKind | typeof ALL }
  | { type: "range"; range: Range }
  | { type: "from"; from: string }
  | { type: "to"; to: string }
  | { type: "query"; query: string }
  /** Show older read older work into the log (`widenFor`): `oldest` is its oldest event (seconds), `now` the clock (ms) */
  | { type: "widen"; oldest: number; now: number }
  | { type: "clear" };

export function filterReduce(f: Filters, a: FilterAction): Filters {
  switch (a.type) {
    case "who":
      return { ...f, who: a.who };
    case "kind":
      return { ...f, kind: a.kind };
    case "range":
      return { ...f, range: a.range };
    case "from":
      return { ...f, from: a.from };
    case "to":
      return { ...f, to: a.to };
    case "query":
      return { ...f, query: a.query };
    case "widen":
      return widenFor(f, a.oldest, a.now);
    case "clear":
      return NO_FILTERS;
  }
}

/** The filters once Show older has read older work into the log, so that what it read can be seen. The person pressed
 *  for older work, and a range of the last days (today, 7 or 30) would hide what is older than it, so the press would look
 *  as if it did nothing: such a range that leaves out the oldest event the log now holds becomes the days from that
 *  event's day to today. A range of the person's own dates stays as they set it, and so does every other filter. */
export function widenFor(f: Filters, oldestSec: number, nowMs: number): Filters {
  if (f.range === "custom" || inRange(oldestSec, f.range, nowMs, "", "")) return f;
  return { ...f, range: "custom", from: dayOf(oldestSec * 1000), to: dayOf(nowMs) };
}

const midnight = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** A `YYYY-MM-DD` as its day's midnight on this computer, or null when it is not a day on the calendar. */
export function parseDay(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date.getTime() : null;
}

/** Whether a moment (seconds) falls in the range, by calendar days on this computer's clock: today; today and the six days
 *  before; today and the twenty-nine before; or the days from `from` to `to` (a side that is empty or not a day is open,
 *  and a range given backwards is the same range). */
export function inRange(atSec: number, range: Range, nowMs: number, from: string, to: string): boolean {
  const day = midnight(atSec * 1000);
  // Whole days apart, counted on the calendar so a change of clocks cannot move a day.
  const age = Math.round((midnight(nowMs) - day) / 86_400_000);
  switch (range) {
    case "today":
      return age <= 0;
    case "7":
      return age <= 6;
    case "30":
      return age <= 29;
    case "custom": {
      let lo = parseDay(from);
      let hi = parseDay(to);
      if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
      return (lo === null || day >= lo) && (hi === null || day <= hi);
    }
  }
}

/** The events the filters keep, in the order given. The search reads the title, the item, who approved and the kind's
 *  name, as the canvas's does, and never a message's text: a hidden message cannot be found by its words. */
export function filterEvents(events: readonly ActivityEvent[], f: Filters, nowMs: number, kindLabel: (kind: ActivityKind) => string): ActivityEvent[] {
  const q = f.query.trim().toLowerCase();
  return events.filter(
    (e) =>
      (f.who === ALL || e.who === f.who) &&
      (f.kind === ALL || e.kind === f.kind) &&
      inRange(e.at, f.range, nowMs, f.from, f.to) &&
      (!q || `${e.title} ${e.item} ${e.approval} ${kindLabel(e.kind)}`.toLowerCase().includes(q)),
  );
}

export interface ActivityDay {
  /** this computer's midnight that starts the day, in ms */
  day: number;
  when: HistoryDay["when"];
  /** newest first */
  events: ActivityEvent[];
}

/** Events grouped by day, newest first. */
export function groupDays(events: readonly ActivityEvent[], nowMs: number): ActivityDay[] {
  const newest = [...events].sort((a, b) => b.at - a.at).map((event) => ({ ts: event.at, event }));
  return byDay(newest, nowMs).map((d) => ({ day: d.day, when: d.when, events: d.entries.map((x) => x.event) }));
}

/** The event the details show: the one picked while it is still listed, else the first, else none. */
export function selectedEvent(list: readonly ActivityEvent[], picked: string | null): ActivityEvent | null {
  return list.find((e) => e.id === picked) ?? list[0] ?? null;
}

/** What the details show of an event's words. A customer's message is hidden until the owner shows it for that event; the
 *  shop's own post is public, so it is shown and there is nothing to hide. */
export type TextView = { kind: "none" } | { kind: "hidden" } | { kind: "shown"; private: boolean; body: string; canHide: boolean };

export function textView(e: ActivityEvent, shown: ReadonlySet<string>): TextView {
  if (!e.text) return { kind: "none" };
  if (!e.text.private) return { kind: "shown", private: false, body: e.text.body, canHide: false };
  return shown.has(e.id) ? { kind: "shown", private: true, body: e.text.body, canHide: true } : { kind: "hidden" };
}

// ---- the export ------------------------------------------------------------------------------------------------------

export interface ExportState {
  open: boolean;
  range: Range;
  from: string;
  to: string;
  /** the kinds the file includes, in the chips' order */
  kinds: readonly ActivityKind[];
  /** include customer message text; off every time the dialog opens */
  text: boolean;
  /** saving the file was asked for and this app cannot do it yet */
  note: "not_yet" | null;
}

export const EXPORT_START: ExportState = { open: false, range: "7", from: "", to: "", kinds: [...ACTIVITY_KINDS], text: false, note: null };

export type ExportAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "range"; range: Range }
  | { type: "from"; from: string }
  | { type: "to"; to: string }
  | { type: "kind"; kind: ActivityKind }
  | { type: "text" }
  | { type: "note"; note: "not_yet" };

/** Saving was asked for and the app cannot do it yet. */
export const SAVE_NOT_YET: ExportAction = { type: "note", note: "not_yet" };

/** Any change to what the file holds takes a refusal's note away, since the note was about the file as it was. */
export function exportReduce(x: ExportState, a: ExportAction): ExportState {
  switch (a.type) {
    case "open":
      return { ...x, open: true, text: false, note: null };
    case "close":
      return { ...x, open: false, note: null };
    case "range":
      return { ...x, range: a.range, note: null };
    case "from":
      return { ...x, from: a.from, note: null };
    case "to":
      return { ...x, to: a.to, note: null };
    case "kind": {
      const on = new Set(x.kinds);
      if (on.has(a.kind)) on.delete(a.kind);
      else on.add(a.kind);
      return { ...x, kinds: ACTIVITY_KINDS.filter((k) => on.has(k)), note: null };
    }
    case "text":
      return { ...x, text: !x.text, note: null };
    case "note":
      return { ...x, note: a.note };
  }
}

/** The events the file would hold: in the chosen range and of the chosen kinds. */
export function exportEvents(events: readonly ActivityEvent[], x: ExportState, nowMs: number): ActivityEvent[] {
  return events.filter((e) => x.kinds.includes(e.kind) && inRange(e.at, x.range, nowMs, x.from, x.to));
}

/** The words an export is written in: the owner's language, chosen by the page. */
export interface ExportWords {
  header: readonly string[];
  who(who: string): string;
  kind(kind: ActivityKind): string;
  status(status: string): string;
}


/** A moment (ms) as its day on this computer, `YYYY-MM-DD`: how a range of dates and the file's day column write a day. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The file: a header row and one row per event (its day and time, who, what, the item, who approved, how it ended, where,
 *  whether it can be undone, a note and the words). The words column holds the shop's own post text always and a customer's
 *  message text only when the export was asked to include it, so the message stays out of a file unless it is chosen. */
export function exportCsv(events: readonly ActivityEvent[], x: ExportState, nowMs: number, words: ExportWords): string {
  const rows = exportEvents(events, x, nowMs).map((e) => {
    const d = new Date(e.at * 1000);
    return [
      dayOf(e.at * 1000),
      hhmm(d),
      words.who(e.who),
      words.kind(e.kind),
      e.title,
      e.item,
      e.approval,
      words.status(e.status),
      e.where,
      e.undo,
      e.note,
      e.text && (!e.text.private || x.text) ? e.text.body : "",
    ];
  });
  return toCsv([words.header, ...rows]);
}
