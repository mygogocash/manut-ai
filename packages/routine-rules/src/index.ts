/// Routines: what one is, when it runs next, and how its timing is said. Pure
/// functions only; running a routine is somebody else's job. Nothing here
/// throws: a refusal is a result value, and a function handed something that
/// is not a routine answers `null` or an empty string.

export type ActionKind = "brief" | "draft" | "reply" | "send" | "pay" | "delete";

export type Trigger =
  | { kind: "daily"; at: string }
  | { kind: "weekly"; weekdays: number[]; at: string }
  | { kind: "monthly"; day: number | "last"; at: string }
  | { kind: "window"; from: string; to: string }
  | { kind: "stockBelow"; threshold: number };

export type Routine = {
  id: string;
  name: string;
  action: ActionKind;
  timeZone: string;
  trigger: Trigger;
  asksFirst: boolean;
};

export type RoutineInput = {
  id: string;
  name: string;
  action: ActionKind;
  timeZone?: string;
  trigger: Trigger;
  asksFirst?: boolean;
};

export type RoutineRefusal =
  | "invalid_id"
  | "invalid_name"
  | "invalid_action"
  | "invalid_time_zone"
  | "invalid_trigger"
  | "invalid_time"
  | "invalid_weekdays"
  | "invalid_day"
  | "invalid_window"
  | "invalid_threshold"
  | "must_ask_first";

export type RoutineResult = { ok: true; routine: Routine } | { ok: false; reason: RoutineRefusal };

export type ScheduleShape = { hour: number; minute: number; weekdays: number[]; timeZone: string };

export const DEFAULT_TIME_ZONE = "Asia/Bangkok";

const ACTIONS: readonly ActionKind[] = ["brief", "draft", "reply", "send", "pay", "delete"];
/// These kinds reach a customer, a service, money or data, so they always ask.
const ALWAYS_ASK: readonly ActionKind[] = ["reply", "send", "pay", "delete"];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function mustAskFirst(action: ActionKind): boolean {
  return ALWAYS_ASK.includes(action);
}

// ---- time of day --------------------------------------------------------

/// "08:00" to minutes after midnight, or null when it is not exactly HH:MM.
function minutesOf(at: unknown): number | null {
  if (typeof at !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ---- validation ---------------------------------------------------------

const zoneOk = new Map<string, boolean>();
function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  const known = zoneOk.get(zone);
  if (known !== undefined) return known;
  let ok = true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    ok = false;
  }
  zoneOk.set(zone, ok);
  return ok;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function checkTrigger(t: unknown): RoutineRefusal | null {
  if (!isObject(t)) return "invalid_trigger";
  switch (t.kind) {
    case "daily":
      return minutesOf(t.at) === null ? "invalid_time" : null;
    case "weekly": {
      if (minutesOf(t.at) === null) return "invalid_time";
      const days = t.weekdays;
      if (!Array.isArray(days) || days.length === 0) return "invalid_weekdays";
      return days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? null : "invalid_weekdays";
    }
    case "monthly": {
      if (minutesOf(t.at) === null) return "invalid_time";
      const d = t.day;
      if (d === "last") return null;
      return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 28 ? null : "invalid_day";
    }
    case "window": {
      const a = minutesOf(t.from);
      const b = minutesOf(t.to);
      if (a === null || b === null) return "invalid_time";
      return a === b ? "invalid_window" : null;
    }
    case "stockBelow":
      return typeof t.threshold === "number" && Number.isSafeInteger(t.threshold) && t.threshold >= 1
        ? null
        : "invalid_threshold";
    default:
      return "invalid_trigger";
  }
}

/// The first reason a routine is not valid, or null. Checks a stored routine
/// as strictly as `createRoutine` checks an input.
export function checkRoutine(routine: unknown): RoutineRefusal | null {
  if (!isObject(routine)) return "invalid_trigger";
  if (typeof routine.id !== "string" || routine.id.trim() === "") return "invalid_id";
  const name = routine.name;
  if (typeof name !== "string" || [...name.trim()].length < 1 || [...name.trim()].length > 80) return "invalid_name";
  if (!ACTIONS.includes(routine.action as ActionKind)) return "invalid_action";
  if (!validZone(routine.timeZone)) return "invalid_time_zone";
  const trigger = checkTrigger(routine.trigger);
  if (trigger) return trigger;
  if (typeof routine.asksFirst !== "boolean") return "must_ask_first";
  if (mustAskFirst(routine.action as ActionKind) && routine.asksFirst === false) return "must_ask_first";
  return null;
}

/// Builds a routine from an input. The time zone defaults to Asia/Bangkok;
/// `asksFirst` is forced true for reply, send, pay and delete, and asking for
/// false there is refused rather than quietly overridden.
export function createRoutine(input: RoutineInput): RoutineResult {
  if (!isObject(input)) return { ok: false, reason: "invalid_id" };
  const action = input.action;
  const asksFirst =
    input.asksFirst === undefined ? ACTIONS.includes(action) && mustAskFirst(action) : input.asksFirst;
  const routine: Routine = {
    id: typeof input.id === "string" ? input.id.trim() : (input.id as never),
    name: typeof input.name === "string" ? input.name.trim() : (input.name as never),
    action,
    timeZone: input.timeZone === undefined ? DEFAULT_TIME_ZONE : (input.timeZone as string),
    trigger: input.trigger,
    asksFirst: asksFirst as boolean,
  };
  const reason = checkRoutine(routine);
  return reason ? { ok: false, reason } : { ok: true, routine };
}

// ---- wall clock in a zone ----------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(zone, f);
  }
  return f;
}

/// The zone's offset from UTC in ms at an instant (east is positive).
function offsetAt(zone: string, ms: number): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const parts = formatterFor(zone).formatToParts(new Date(whole));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return asUtc - whole;
}

type Ymd = { y: number; m: number; d: number };

function wallDate(zone: string, ms: number): Ymd {
  const t = new Date(ms + offsetAt(zone, ms));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function addDays(date: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekdayOf(date: Ymd): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/// The instant a wall time (date and minutes after midnight) happens in a
/// zone. A time that happens twice gives the first; a time inside a spring
/// gap gives the first minute after the gap.
function instantOf(zone: string, date: Ymd, minutes: number): number {
  const wall = Date.UTC(date.y, date.m - 1, date.d, 0, minutes);
  const before = offsetAt(zone, wall - DAY);
  const after = offsetAt(zone, wall + DAY);
  const offsets = before === after ? [before] : [before, after];
  const hits = offsets.map((o) => wall - o).filter((utc) => offsetAt(zone, utc) === wall - utc);
  if (hits.length > 0) return Math.min(...hits);
  // In a gap: the wall time never showed. The change happened between the two
  // candidate instants; find its minute by bisection.
  let lo = wall - Math.max(before, after);
  let hi = wall - Math.min(before, after);
  if (lo > hi) [lo, hi] = [hi, lo];
  const target = Math.max(before, after);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE;
    if (offsetAt(zone, mid) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---- next run -----------------------------------------------------------

function matchesDay(trigger: Trigger, date: Ymd): boolean {
  switch (trigger.kind) {
    case "daily":
    case "window":
      return true;
    case "weekly":
      return trigger.weekdays.includes(weekdayOf(date));
    case "monthly":
      return date.d === (trigger.day === "last" ? daysInMonth(date.y, date.m) : trigger.day);
    default:
      return false;
  }
}

function startMinutes(trigger: Trigger): number {
  return trigger.kind === "window" ? (minutesOf(trigger.from) ?? 0) : trigger.kind === "stockBelow" ? 0 : (minutesOf(trigger.at) ?? 0);
}

/// The next start strictly after `now`, in ms; null for an event trigger
/// (`stockBelow`), a routine that is not valid, or a `now` that is not a time.
export function nextRun(routine: Routine, now: number): number | null {
  if (typeof now !== "number" || !Number.isFinite(now) || checkRoutine(routine)) return null;
  const { trigger, timeZone } = routine;
  if (trigger.kind === "stockBelow") return null;
  const minutes = startMinutes(trigger);
  // Start a day early: the zone's date may trail or lead UTC's, and a
  // gap-shifted run can land on the previous scan date. 13 months covers a
  // monthly routine and a weekly one through any daylight-saving week.
  const today = wallDate(timeZone, now);
  for (let i = -1; i < 400; i++) {
    const date = addDays(today, i);
    if (!matchesDay(trigger, date)) continue;
    const at = instantOf(timeZone, date, minutes);
    if (at > now) return at;
  }
  return null;
}

/// Whether a `window` routine is running at `now`. False for every other
/// kind and for anything that is not a valid routine. A window that crosses
/// midnight (21:00 to 08:00) belongs to the evening it started on.
export function inWindow(routine: Routine, now: number): boolean {
  if (typeof now !== "number" || !Number.isFinite(now) || checkRoutine(routine)) return false;
  const { trigger, timeZone } = routine;
  if (trigger.kind !== "window") return false;
  const from = minutesOf(trigger.from) ?? 0;
  const to = minutesOf(trigger.to) ?? 0;
  const t = new Date(now + offsetAt(timeZone, now));
  const minute = t.getUTCHours() * 60 + t.getUTCMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

// ---- the API's schedule -------------------------------------------------

/// What `apps/api`'s `ScheduleJSON` can run: an hour, a minute, weekdays and a
/// zone. Its weekdays count Sunday as 1 to Saturday as 7 (`wallParts` there),
/// not Sunday as 0 as a routine's do, so each day is shifted by one. Daily
/// runs on all seven. Null for monthly, window and event triggers, which it
/// cannot express, and for an invalid routine.
export function toSchedule(routine: Routine): ScheduleShape | null {
  if (checkRoutine(routine)) return null;
  const { trigger, timeZone } = routine;
  if (trigger.kind !== "daily" && trigger.kind !== "weekly") return null;
  const minutes = minutesOf(trigger.at) ?? 0;
  const weekdays =
    trigger.kind === "daily"
      ? [1, 2, 3, 4, 5, 6, 7]
      : [...new Set(trigger.weekdays)].sort((a, b) => a - b).map((d) => d + 1);
  return { hour: Math.floor(minutes / 60), minute: minutes % 60, weekdays, timeZone };
}

// ---- words --------------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/// The trigger in English, as the Routines list shows it. Empty text for a
/// routine that is not valid.
export function describeTrigger(routine: Routine): string {
  if (checkRoutine(routine)) return "";
  const t = routine.trigger;
  switch (t.kind) {
    case "daily":
      return `Every day at ${t.at}`;
    case "weekly": {
      const days = [...new Set(t.weekdays)].sort((a, b) => a - b);
      if (days.length === 7) return `Every day at ${t.at}`;
      return `Every ${joinWords(days.map((d) => DAY_NAMES[d] ?? ""))} at ${t.at}`;
    }
    case "monthly":
      return t.day === "last"
        ? `On the last day of the month at ${t.at}`
        : `On the ${ordinal(t.day)} of each month at ${t.at}`;
    case "window":
      return (minutesOf(t.from) ?? 0) > (minutesOf(t.to) ?? 0)
        ? `Every night after ${t.from}`
        : `Every day from ${t.from} to ${t.to}`;
    case "stockBelow":
      return `When stock drops under ${t.threshold}`;
  }
}
