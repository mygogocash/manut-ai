// What the person has done to a row of the sidebar or the Code page (item 76): pinned it, snoozed it, settled it or archived it.
// A chat (one of Buddy's threads, in Recent and History), a lane and a terminal session each have a key, and one small record
// per key says where its row goes. The rules are here, apart from the markup, so they can be tested without a page.
//
// The idea of the places (pinned on top, snoozed and settled below, an archive) comes from T3 Code's sidebar (pingdotgg/t3code,
// MIT License); the code is this app's own.
//
// Where it is kept: a chat's marks are kept on this computer (localStorage `manut.sidebar.rows`), because the chat itself is
// kept by the runtime and lives on across restarts. A lane and a terminal session are of this run of the app (the sessions'
// list is not saved: sessions/sessions.ts), so their marks are kept in memory only and go when the session is closed.
//
// Rules that must hold:
//  - A row is in one place. Pinning, snoozing, settling and archiving each replace the others.
//  - Snoozing and settling never hide an ask. A row that needs the person is shown in its normal place whatever its marks say
//    (`placeOf`), and the marks are cleared as the ask arrives (`wake`), so the row stays back once the ask is answered.
//  - Opening a settled row brings it back (`opened`).
//  - A record saved by an older build has none of these keys and reads as no marks; a field this build does not know is dropped
//    on reading, never an error.
import { useSyncExternalStore } from "react";

export const ROWS_KEY = "manut.sidebar.rows";

/** One row's marks. Each is the time (ms) it was made or, for `snoozed`, the time the snooze ends. */
export interface RowMark {
  pinned?: number;
  snoozed?: number;
  settled?: true;
  archived?: number;
}
export type RowMarks = Readonly<Record<string, RowMark>>;

/** A chat is `thread:<bot>:<thread>`; a lane or terminal session is `session:<id>`. */
export const threadRowKey = (bot: string, thread: string): string => `thread:${bot}:${thread}`;
export const sessionRowKey = (id: string): string => `session:${id}`;

/** The most rows kept; the oldest marks go first. */
const MAX = 500;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A saved record, defensively: anything malformed or unknown is dropped, and a row with no mark left is not kept. */
export function parseRowMarks(raw: string | null): Record<string, RowMark> {
  const out: Record<string, RowMark> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [key, m] of Object.entries(v as Record<string, unknown>)) {
      if (!key.startsWith("thread:") || !m || typeof m !== "object" || Array.isArray(m)) continue;
      const r = m as Record<string, unknown>;
      const mark: RowMark = {};
      const pinned = num(r.pinned);
      const snoozed = num(r.snoozed);
      const archived = num(r.archived);
      if (pinned !== undefined) mark.pinned = pinned;
      if (snoozed !== undefined) mark.snoozed = snoozed;
      if (r.settled === true) mark.settled = true;
      if (archived !== undefined) mark.archived = archived;
      if (Object.keys(mark).length) out[key] = one(mark);
      if (Object.keys(out).length >= MAX) break;
    }
  } catch {
    /* a broken record reads as none */
  }
  return out;
}

/** A row is in one place: when a record carries several (a hand-edited one), the strongest wins: archived, then pinned, snoozed, settled. */
function one(m: RowMark): RowMark {
  if (m.archived !== undefined) return { archived: m.archived };
  if (m.pinned !== undefined) return { pinned: m.pinned };
  if (m.snoozed !== undefined) return { snoozed: m.snoozed };
  return m.settled ? { settled: true } : {};
}

export type RowPlace = "pinned" | "normal" | "settled" | "snoozed" | "archived";

/** Where a row goes now. `needs`: an approval or question of it waits on the person. Archived stays archived (the person put it
 *  away; Needs you still lists its ask), but a snoozed or settled row that needs the person is back in its normal place. */
export function placeOf(mark: RowMark | undefined, needs: boolean, now: number): RowPlace {
  if (!mark) return "normal";
  if (mark.archived !== undefined) return "archived";
  if (mark.pinned !== undefined) return "pinned";
  if (needs) return "normal";
  if (mark.snoozed !== undefined && mark.snoozed > now) return "snoozed";
  return mark.settled ? "settled" : "normal";
}

/** `items` split into the places, each in the order given, except the pinned, which are in the order they were pinned (first
 *  pinned on top). */
export function arrange<T extends { key: string; needs?: boolean }>(items: readonly T[], marks: RowMarks, now: number): Record<RowPlace, T[]> {
  const out: Record<RowPlace, T[]> = { pinned: [], normal: [], settled: [], snoozed: [], archived: [] };
  for (const it of items) out[placeOf(marks[it.key], !!it.needs, now)].push(it);
  out.pinned.sort((a, b) => (marks[a.key]?.pinned ?? 0) - (marks[b.key]?.pinned ?? 0));
  return out;
}

/** A change to one row. */
export type RowAction = { do: "pin" } | { do: "unpin" } | { do: "snooze"; until: number } | { do: "settle" } | { do: "wake" } | { do: "open" } | { do: "archive" } | { do: "restore" };

/** `marks` with `action` done to `key` at `now`. The same object back when nothing changes. */
export function applyRow(marks: RowMarks, key: string, action: RowAction, now: number): RowMarks {
  const was = marks[key];
  let next: RowMark | null;
  switch (action.do) {
    case "pin":
      next = was?.archived !== undefined || was?.pinned !== undefined ? was : { pinned: now };
      break;
    case "unpin":
      next = was?.pinned === undefined ? was ?? null : null;
      break;
    case "snooze":
      next = was?.archived !== undefined ? was : { snoozed: action.until };
      break;
    case "settle":
      next = was?.archived !== undefined ? was : { settled: true };
      break;
    case "wake":
      next = was && (was.snoozed !== undefined || was.settled) ? null : was ?? null;
      break;
    case "open":
      // opening a settled row brings it back; a snooze waits for its time or an ask
      next = was?.settled ? null : was ?? null;
      break;
    case "archive":
      next = was?.archived !== undefined ? was : { archived: now };
      break;
    case "restore":
      next = was?.archived === undefined ? was ?? null : null;
      break;
  }
  if (next === (was ?? null)) return marks;
  const rest = Object.fromEntries(Object.entries(marks).filter(([k]) => k !== key));
  return next ? { ...rest, [key]: next } : rest;
}

/** `marks` with the snoozed and settled marks of every row in `keys` cleared: an ask came. */
export function wakeAll(marks: RowMarks, keys: readonly string[], now: number): RowMarks {
  let out = marks;
  for (const k of keys) out = applyRow(out, k, { do: "wake" }, now);
  return out;
}

/** `marks` without the rows `alive` does not name (a lane or session that was closed) and without a snooze that has ended. */
export function sweep(marks: RowMarks, now: number, alive: (key: string) => boolean): RowMarks {
  const kept = Object.entries(marks).filter(([k, m]) => alive(k) && !(m.snoozed !== undefined && m.snoozed <= now));
  return kept.length === Object.keys(marks).length ? marks : Object.fromEntries(kept);
}

/** When the next snooze ends after `now` (ms), or null when none is running. */
export function nextWake(marks: RowMarks, now: number): number | null {
  let at: number | null = null;
  for (const m of Object.values(marks)) if (m.snoozed !== undefined && m.snoozed > now && (at === null || m.snoozed < at)) at = m.snoozed;
  return at;
}

/** The plain choices a snooze offers: an hour, tomorrow morning and next week, on this computer's clock. Tomorrow and next week
 *  are at 9:00; next week is the coming Monday (a week from now when it is Monday). */
export type SnoozeId = "hour" | "tomorrow" | "week";
export const SNOOZES: readonly SnoozeId[] = ["hour", "tomorrow", "week"];
export function snoozeUntil(id: SnoozeId, now: number): number {
  const d = new Date(now);
  if (id === "hour") return now + 3_600_000;
  if (id === "tomorrow") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9).getTime();
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + toMonday, 9).getTime();
}

// ---- the store ----------------------------------------------------------------------------------------------------

let marks: RowMarks | null = null;
const listeners = new Set<() => void>();

function load(): RowMarks {
  if (!marks) {
    try {
      marks = parseRowMarks(typeof localStorage !== "undefined" ? localStorage.getItem(ROWS_KEY) : null);
    } catch {
      marks = {};
    }
  }
  return marks;
}

export const getRowMarks = (): RowMarks => load();

export function setRowMarks(next: RowMarks): void {
  if (next === load()) return;
  marks = next;
  try {
    // only chats are kept: a session's id is of this run
    const kept = Object.fromEntries(Object.entries(next).filter(([k]) => k.startsWith("thread:")));
    localStorage.setItem(ROWS_KEY, JSON.stringify(kept));
  } catch {
    /* no storage */
  }
  for (const fn of listeners) fn();
}

/** Do `action` to row `key`. */
export const markRow = (key: string, action: RowAction, now: number = Date.now()): void => setRowMarks(applyRow(load(), key, action, now));
/** Clear the snoozed and settled marks of `keys` (a no-op when none has one). */
export const wakeRows = (keys: readonly string[], now: number = Date.now()): void => setRowMarks(wakeAll(load(), keys, now));
/** Drop what `sweep` says. */
export const sweepRows = (alive: (key: string) => boolean, now: number = Date.now()): void => setRowMarks(sweep(load(), now, alive));
/** A test starts from none. */
export function resetRowMarks(next: RowMarks = {}): void {
  marks = next;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useRowMarks = (): RowMarks => useSyncExternalStore(subscribe, getRowMarks, getRowMarks);
