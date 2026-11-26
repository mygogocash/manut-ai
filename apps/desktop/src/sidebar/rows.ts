// What the person has done to a row of the sidebar or the Code page (item 76): pinned it, snoozed it, settled it or archived it.
// A chat (one of Buddy's threads, in Recent and History), a lane and a terminal session each have a key, and one small record
// per key says where its row goes. The rules are here, apart from the markup, so they can be tested without a page.
//
// The idea of the places (pinned on top, snoozed and settled below, an archive) comes from T3 Code's sidebar (pingdotgg/t3code,
// MIT License); the code is this app's own.
//
// Where it is kept: every row's marks are kept on this computer (localStorage `manut.sidebar.rows`). A chat lives on across
// restarts in the runtime, and a lane and a terminal session come back with the sessions' list (app/resume.ts), so since item 94
// their marks come back with them. A lane is known by its own folder, whose record is under `~/.manut/lanes` (src-tauri/src/lane.rs),
// and a terminal by its link id (`manut://terminal/<linkId>`), which is drawn when the session is made and kept across restarts:
// never by the session's number (`s3`), which a later run may give to another session. A lane's or a terminal's marks go when the
// person closes its session.
//
// Rules that must hold:
//  - A row is in one place. Pinning, snoozing, settling and archiving each replace the others.
//  - Snoozing and settling never hide an ask. A row that needs the person is shown in its normal place whatever its marks say
//    (`placeOf`), and the marks are cleared as the ask arrives (`wake`), so the row stays back once the ask is answered.
//  - Opening a settled row brings it back (`opened`).
//  - A record saved by an older build has none of these keys and reads as no marks; a field this build does not know is dropped
//    on reading, never an error.
import { useSyncExternalStore } from "react";
import { hhmm } from "../app/time";

export const ROWS_KEY = "manut.sidebar.rows";

/** One row's marks. Each is the time (ms) it was made or, for `snoozed`, the time the snooze ends. */
export interface RowMark {
  pinned?: number;
  snoozed?: number;
  /** Snoozed until its turn ends (item 94): the time it was snoozed. It is back when the turn ends, or at once when it asks. */
  untilDone?: number;
  settled?: true;
  archived?: number;
}
export type RowMarks = Readonly<Record<string, RowMark>>;

/** A chat is `thread:<bot>:<thread>`; a lane with a folder of its own is `lane:<that folder>`; any other session (a terminal, a lane
 *  that made no folder) is `session:<its link id>`. A record without a link id (a test's) falls back to its id. */
export const threadRowKey = (bot: string, thread: string): string => `thread:${bot}:${thread}`;
export function sessionRowKey(rec: { id: string; linkId?: string; lane?: { worktree?: string } }): string {
  return rec.lane?.worktree ? `lane:${rec.lane.worktree}` : `session:${rec.linkId || rec.id}`;
}
/** Whether `key` is a session's (a lane or a terminal), whose row goes when the session is closed. */
export const isSessionKey = (key: string): boolean => key.startsWith("session:") || key.startsWith("lane:");
const KEPT = (key: string): boolean => key.startsWith("thread:") || isSessionKey(key);

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
      if (!KEPT(key) || !m || typeof m !== "object" || Array.isArray(m)) continue;
      const r = m as Record<string, unknown>;
      const mark: RowMark = {};
      const pinned = num(r.pinned);
      const snoozed = num(r.snoozed);
      const untilDone = num(r.untilDone);
      const archived = num(r.archived);
      if (pinned !== undefined) mark.pinned = pinned;
      if (snoozed !== undefined) mark.snoozed = snoozed;
      if (untilDone !== undefined) mark.untilDone = untilDone;
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

/** A row is in one place: when a record carries several (a hand-edited one), the strongest wins: archived, then pinned, snoozed
 *  (until a time, then until its turn ends), settled. */
function one(m: RowMark): RowMark {
  if (m.archived !== undefined) return { archived: m.archived };
  if (m.pinned !== undefined) return { pinned: m.pinned };
  if (m.snoozed !== undefined) return { snoozed: m.snoozed };
  if (m.untilDone !== undefined) return { untilDone: m.untilDone };
  return m.settled ? { settled: true } : {};
}

/** Whether a row is snoozed (until a time, or until its turn ends): what an ask wakes. */
const away = (m: RowMark | undefined): boolean => !!m && (m.snoozed !== undefined || m.untilDone !== undefined || m.settled === true);

export type RowPlace = "pinned" | "normal" | "settled" | "snoozed" | "archived";

/** Where a row goes now. `needs`: an approval or question of it waits on the person. Archived stays archived (the person put it
 *  away; Needs you still lists its ask), but a snoozed or settled row that needs the person is back in its normal place. `working`:
 *  its turn runs, which a snooze until it finishes waits for; a row snoozed so that is not working (any more) is back. */
export function placeOf(mark: RowMark | undefined, needs: boolean, now: number, working = false): RowPlace {
  if (!mark) return "normal";
  if (mark.archived !== undefined) return "archived";
  if (mark.pinned !== undefined) return "pinned";
  if (needs) return "normal";
  if (mark.snoozed !== undefined && mark.snoozed > now) return "snoozed";
  if (mark.untilDone !== undefined) return working ? "snoozed" : "normal";
  return mark.settled ? "settled" : "normal";
}

/** `items` split into the places, each in the order given, except the pinned, which are in the order they were pinned (first
 *  pinned on top). */
export function arrange<T extends { key: string; needs?: boolean; working?: boolean }>(items: readonly T[], marks: RowMarks, now: number): Record<RowPlace, T[]> {
  const out: Record<RowPlace, T[]> = { pinned: [], normal: [], settled: [], snoozed: [], archived: [] };
  for (const it of items) out[placeOf(marks[it.key], !!it.needs, now, !!it.working)].push(it);
  out.pinned.sort((a, b) => (marks[a.key]?.pinned ?? 0) - (marks[b.key]?.pinned ?? 0));
  return out;
}

/** A change to one row. */
export type RowAction = { do: "pin" } | { do: "unpin" } | { do: "snooze"; until: number } | { do: "snoozeTurn" } | { do: "settle" } | { do: "wake" } | { do: "open" } | { do: "archive" } | { do: "restore" };

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
    case "snoozeTurn":
      next = was?.archived !== undefined || was?.untilDone !== undefined ? was : { untilDone: now };
      break;
    case "settle":
      // settling a settled row changes nothing (and so holds nothing to undo)
      next = was?.archived !== undefined || was?.settled ? was : { settled: true };
      break;
    case "wake":
      next = away(was) ? null : was ?? null;
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

/** `marks` with `action` done to every row of `keys` at `now` (item 94: several rows at once). The same object back when nothing
 *  changes. */
export function applyRows(marks: RowMarks, keys: readonly string[], action: RowAction, now: number): RowMarks {
  let out = marks;
  for (const k of keys) out = applyRow(out, k, action, now);
  return out;
}

// ---- undo (item 94) -------------------------------------------------------------------------------------------------
//
// Pin, Snooze, Done for now and Archive can each be taken back for a few seconds, with ⌘Z while the sidebar or the row has focus,
// or the Undo of the quiet toast that says what was done. One action is kept, the newest: it holds exactly the mark each row it
// touched had before (none, for a row that had none), so undoing puts back that mark and nothing else, for one row or for all the
// rows of a bulk action. The idea of undoing a settle or a snooze comes from T3 Code's sidebar (pingdotgg/t3code, MIT License,
// `threadUndo.ts`); the code is this app's own.

/** The actions that can be undone. */
export type UndoKind = "pin" | "snooze" | "settle" | "archive";
/** How long the Undo toast stays: a few seconds, as the brief asks. */
export const UNDO_MS = 6_000;

/** One action that can be taken back. `before` names every row it changed, with the mark it had (undefined: none). */
export interface RowUndo {
  id: number;
  kind: UndoKind;
  /** What the toast calls it: the row's name, or how many rows. */
  name: string;
  before: Readonly<Record<string, RowMark | undefined>>;
  /** When it was done, and when the toast goes (ms). */
  at: number;
  until: number;
}

/** The kind of undo an action is, or null for one that is not undone (unpin, bring back, open, restore). */
export function undoKind(action: RowAction): UndoKind | null {
  if (action.do === "snoozeTurn") return "snooze";
  return action.do === "pin" || action.do === "snooze" || action.do === "settle" || action.do === "archive" ? action.do : null;
}

/** What each row of `keys` had in `was` that `next` changed: the record an undo needs. Empty when nothing changed. */
export function changedFrom(was: RowMarks, next: RowMarks, keys: readonly string[]): Record<string, RowMark | undefined> {
  const out: Record<string, RowMark | undefined> = {};
  for (const k of keys) if (was[k] !== next[k]) out[k] = was[k];
  return out;
}

/** `marks` with each row of `before` set back to exactly the mark it had: deleted where it had none. */
export function restoreRows(marks: RowMarks, before: Readonly<Record<string, RowMark | undefined>>): RowMarks {
  const keys = Object.keys(before);
  if (keys.every((k) => marks[k] === before[k])) return marks;
  const out: Record<string, RowMark> = Object.fromEntries(Object.entries(marks).filter(([k]) => !(k in before)));
  for (const k of keys) {
    const m = before[k];
    if (m) out[k] = m;
  }
  return out;
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

/** `marks` without the snoozes until a turn ends of the rows in `done`: rows listed now whose turn is not running (item 94). */
export function finishAll(marks: RowMarks, done: readonly string[]): RowMarks {
  let out = marks;
  for (const k of done) if (out[k]?.untilDone !== undefined) out = applyRow(out, k, { do: "wake" }, 0);
  return out;
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

/** The time a person picked in the snooze menu's date and time fields (`2026-11-27`, `09:30`), on this computer's clock, or null
 *  when it is not a real time ahead of `now`: a malformed field, a date that does not exist (31 February), a time a clock change
 *  skips, or a time that has passed. Lifted from T3 Code's `resolveCustomSnooze` (pingdotgg/t3code, MIT License,
 *  `packages/client-runtime/src/state/threadSettled.ts`). */
export function pickedTime(date: string, time: string, now: number): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const at = new Date(`${date}T${time}:00`);
  // a date that rolled over, or a local time that does not exist, reads back differently
  if (dayField(at) !== date || timeField(at) !== time) return null;
  const ms = at.getTime();
  return Number.isFinite(ms) && ms > now ? ms : null;
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** A day as a date field holds it (`2026-11-27`), on this computer's clock. */
export const dayField = (d: Date): string => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A time as a time field holds it (`09:30`). */
export const timeField = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A time ahead as the day's time, with the weekday when it is not today ("09:00", "Thu 09:00"). */
export function untilWord(at: number, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString() ? hhmm(d) : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm(d)}`;
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
    const kept = Object.entries(next).filter(([k]) => KEPT(k));
    // the newest marks are kept when there are more than MAX (reading keeps the first MAX)
    localStorage.setItem(ROWS_KEY, JSON.stringify(Object.fromEntries(kept.slice(-MAX))));
  } catch {
    /* no storage */
  }
  for (const fn of listeners) fn();
}

/** Do `action` to row `key`. */
export const markRow = (key: string, action: RowAction, now: number = Date.now()): void => setRowMarks(applyRow(load(), key, action, now));

let undo: RowUndo | null = null;
let undoSeq = 0;
let undoTimer: ReturnType<typeof setTimeout> | null = null;
const undoListeners = new Set<() => void>();
const undoChanged = () => {
  for (const fn of undoListeners) fn();
};
function setUndo(next: RowUndo | null): void {
  if (undoTimer !== null) clearTimeout(undoTimer);
  undoTimer = null;
  undo = next;
  if (next) undoTimer = setTimeout(() => setUndo(null), Math.max(0, next.until - Date.now()));
  undoChanged();
}

/** The person does `action` to the rows of `keys` (one, or several selected), which the toast calls `name`. Pin, Snooze, Done for
 *  now and Archive become the one action Undo takes back, when they changed something. */
export function actOnRows(keys: readonly string[], action: RowAction, name: string, now: number = Date.now()): void {
  const was = load();
  const next = applyRows(was, keys, action, now);
  setRowMarks(next);
  const kind = undoKind(action);
  const before = changedFrom(was, next, keys);
  if (kind && Object.keys(before).length) setUndo({ id: ++undoSeq, kind, name, before, at: now, until: now + UNDO_MS });
}

/** Take back the action Undo holds: each row it touched gets exactly the mark it had. False when there is none. */
export function undoRows(): boolean {
  if (!undo) return false;
  const before = undo.before;
  setUndo(null);
  setRowMarks(restoreRows(load(), before));
  return true;
}

/** The action Undo holds, or null once its few seconds are over. */
export const getRowUndo = (): RowUndo | null => undo;
const subscribeUndo = (fn: () => void) => {
  undoListeners.add(fn);
  return () => void undoListeners.delete(fn);
};
export const useRowUndo = (): RowUndo | null => useSyncExternalStore(subscribeUndo, getRowUndo, getRowUndo);
/** Clear the snoozed and settled marks of `keys` (a no-op when none has one). */
export const wakeRows = (keys: readonly string[], now: number = Date.now()): void => setRowMarks(wakeAll(load(), keys, now));
/** Bring back the rows of `keys` snoozed until their turn ended, now that it has (a no-op when none is). */
export const finishRows = (keys: readonly string[]): void => setRowMarks(finishAll(load(), keys));
/** Drop what `sweep` says. */
export const sweepRows = (alive: (key: string) => boolean, now: number = Date.now()): void => setRowMarks(sweep(load(), now, alive));
/** A test starts from none. */
export function resetRowMarks(next: RowMarks = {}): void {
  marks = next;
  setUndo(null);
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useRowMarks = (): RowMarks => useSyncExternalStore(subscribe, getRowMarks, getRowMarks);
