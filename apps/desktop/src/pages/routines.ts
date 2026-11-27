// The routines half of Customize, kept apart from the page so it can be tested without one: how a routine's next run is said,
// what the New routine form offers and builds, how the form and the switches move, and how a refusal reaches the owner. The
// design canvas's board is "Customize: memory and routines" (Brain.dc.html). What a routine is, when it runs and that one
// which replies or sends always asks first are `@manut/routine-rules`' rules, which the runtime applies
// (src/runtime/routines.ts); the form asks the package itself whether what the owner chose is a routine, so it cannot
// disagree with the runtime, and nothing here runs a routine.
import { createRoutine, mustAskFirst, type RoutineRefusal, type Trigger } from "@manut/routine-rules";
import { lang, locale, t, type Key } from "../i18n";
import type { OpParams } from "../lib/protocol";
import type { RoutineRow } from "../runtime/routines";
import { unavailable } from "./load";

/** A routine put in its place after it changed: where it stood, or last when the list did not have it. */
export function withRoutine(routines: readonly RoutineRow[], row: RoutineRow): RoutineRow[] {
  return routines.some((r) => r.id === row.id) ? routines.map((r) => (r.id === row.id ? row : r)) : [...routines, row];
}

// ---- when it runs next --------------------------------------------------------------------------------------------------

/** The zone a routine runs in, or undefined (this computer's own) when it names none this computer knows. */
function zoneOf(zone: string): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The calendar day of a moment in a zone, counted in whole days, so that two moments can be compared by day. */
function dayNumber(ms: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(Date.UTC(n("year"), n("month") - 1, n("day")) / 86_400_000);
}

const yearOf = (ms: number, timeZone: string | undefined) => new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date(ms));

/** "Next: Monday 08:00", said quietly under the routine. Today says Today; the days ahead say the day's name for six days, and
 *  after that the date, so that a weekday never means two different days. The clock is the 24-hour one, and the day is the
 *  routine's own, in its own zone. A routine that is off, or has no next run (an event such as stock), has no line. */
export function nextLine(row: Pick<RoutineRow, "next" | "enabled" | "timeZone">, nowMs: number): string | null {
  if (!row.enabled || row.next === null) return null;
  const zone = zoneOf(row.timeZone);
  const at = row.next * 1000;
  // English writes the day first, as the canvas does and as the shop's own country does.
  const tag = lang() === "en" ? "en-GB" : locale();
  const say = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, { timeZone: zone, ...o }).format(new Date(at));
  const ahead = dayNumber(at, zone) - dayNumber(nowMs, zone);
  const day =
    ahead === 0
      ? t("routines.today")
      : ahead >= 1 && ahead <= 6
        ? say({ weekday: "long" })
        : say({ day: "numeric", month: "long", ...(yearOf(at, zone) === yearOf(nowMs, zone) ? {} : { year: "numeric" }) });
  return t("routines.next", { when: `${day} ${say({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}` });
}

/** What a routine does, in the owner's words, and that it asks first: "Send the books to FlowAccount. Asks first." Only a
 *  routine the runtime says always asks gets that. One the runtime cannot say anything about gets nothing, never a claim
 *  that it does not ask. */
export function nameLine(row: Pick<RoutineRow, "name" | "asksFirst">): string {
  return row.asksFirst === true ? t("routines.nameAsks", { name: row.name.replace(/[\s.。…]+$/u, "") }) : row.name;
}

// ---- the New routine form -----------------------------------------------------------------------------------------------

/** The kinds of work the form offers. Payment work is parked, and nothing is deleted on a schedule, so a routine that pays or
 *  deletes is not offered, though the package would make one (asking first). */
export const FORM_ACTIONS = ["brief", "draft", "reply", "send"] as const;
export type FormAction = (typeof FORM_ACTIONS)[number];

/** The five times the canvas names. */
export const FORM_WHENS = ["daily", "weekly", "monthly", "window", "stock"] as const;
export type FormWhen = (typeof FORM_WHENS)[number];

/** What the owner has chosen and typed, as the fields hold it: text, until the package says it makes a routine. Every kind of
 *  time keeps its own fields, so switching back and forth does not lose what was entered. */
export interface RoutineForm {
  name: string;
  action: FormAction;
  when: FormWhen;
  /** HH:MM, for every day, chosen days and a day of the month */
  at: string;
  /** 0 is Sunday */
  weekdays: number[];
  /** "1" to "28", or "last" */
  day: string;
  from: string;
  to: string;
  threshold: string;
}

export const FORM_START: RoutineForm = { name: "", action: "brief", when: "daily", at: "08:00", weekdays: [1], day: "1", from: "21:00", to: "08:00", threshold: "5" };

/** The time the form describes, from the fields its kind of time uses and no others. */
export function formTrigger(f: RoutineForm): Trigger {
  switch (f.when) {
    case "daily":
      return { kind: "daily", at: f.at };
    case "weekly":
      return { kind: "weekly", weekdays: [...f.weekdays].sort((a, b) => a - b), at: f.at };
    case "monthly":
      return { kind: "monthly", day: f.day === "last" ? "last" : Number(f.day), at: f.at };
    case "window":
      return { kind: "window", from: f.from, to: f.to };
    case "stock":
      return { kind: "stockBelow", threshold: Number(f.threshold) };
  }
}

/** What `routine.create` is sent. It never says whether to ask first: the package decides that from the kind of work. */
export const formParams = (f: RoutineForm) => ({ name: f.name, action: f.action, trigger: formTrigger(f) });

/** The first thing wrong with the form, in the package's own reason, or null. The package is asked, not copied. */
export function formProblem(f: RoutineForm): RoutineRefusal | null {
  const made = createRoutine({ id: "preview", ...formParams(f) });
  return made.ok ? null : made.reason;
}

/** Whether a routine of this kind always asks first, which the form shows before it is added. */
export const formAsksFirst = (f: RoutineForm): boolean => mustAskFirst(f.action);

const PROBLEMS = new Map<RoutineRefusal, Key>([
  ["invalid_name", "routines.problem.name"],
  ["invalid_weekdays", "routines.problem.weekdays"],
  ["invalid_time", "routines.problem.time"],
  ["invalid_day", "routines.problem.day"],
  ["invalid_window", "routines.problem.window"],
  ["invalid_threshold", "routines.problem.threshold"],
]);

/** What is wrong with the form, in the owner's words. A reason the form cannot cause says so in general words. */
export const problemText = (reason: RoutineRefusal): string => t(PROBLEMS.get(reason) ?? "routines.problem.other");

// ---- how the page moves -------------------------------------------------------------------------------------------------

/** What the page itself holds: the form (open, and what it holds), what is wrong with it, a request on its way and why the
 *  last one did not go. Which routines there are, and whether each is on, is the runtime's to say. */
export interface RoutinesUi {
  form: RoutineForm | null;
  problem: RoutineRefusal | null;
  saving: boolean;
  /** the routine whose switch is on its way */
  switching: string | null;
  error: string | null;
}

export const ROUTINES_START: RoutinesUi = { form: null, problem: null, saving: false, switching: null, error: null };

export type RoutinesAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "set"; patch: Partial<RoutineForm> }
  | { type: "weekday"; day: number }
  | { type: "problem"; reason: RoutineRefusal }
  | { type: "begin"; what: "save" }
  | { type: "begin"; what: "switch"; routine: string }
  | { type: "done"; what: "save" | "switch" }
  | { type: "failed"; message: string };

/** Moves the page between editing, waiting on the runtime and done. One request is on its way at a time, and while the form is
 *  being saved it holds still, so a routine is not added twice and what the owner typed is not lost. */
export function routinesReduce(s: RoutinesUi, a: RoutinesAction): RoutinesUi {
  switch (a.type) {
    case "open":
      return s.saving ? s : { ...s, form: { ...FORM_START, weekdays: [...FORM_START.weekdays] }, problem: null, error: null };
    case "close":
      return s.saving ? s : { ...s, form: null, problem: null, error: null };
    case "set":
      return s.saving || !s.form ? s : { ...s, form: { ...s.form, ...a.patch }, problem: null, error: null };
    case "weekday": {
      if (s.saving || !s.form) return s;
      const days = s.form.weekdays.includes(a.day) ? s.form.weekdays.filter((d) => d !== a.day) : [...s.form.weekdays, a.day].sort((x, y) => x - y);
      return { ...s, form: { ...s.form, weekdays: days }, problem: null, error: null };
    }
    case "problem":
      return s.saving ? s : { ...s, problem: a.reason };
    case "begin":
      if (s.saving || s.switching !== null) return s;
      return a.what === "save" ? { ...s, saving: true, error: null } : { ...s, switching: a.routine, error: null };
    // A routine that was added ends the form; one that was refused keeps it, with its words, so the owner can try again.
    case "done":
      return a.what === "save" ? { ...s, form: null, problem: null, saving: false, error: null } : { ...s, switching: null, error: null };
    case "failed":
      return { ...s, saving: false, switching: null, error: a.message };
  }
}

export type RoutineResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Asks the runtime to act and says how the page moves on: what it answered, or the runtime's own words when it would not
 *  (the connected runtime's "Not yet"), with its code. The form has already been checked against the package, so a refusal
 *  here is the runtime's, not the owner's. */
export async function routineStep<T>(call: () => Promise<T>): Promise<RoutineResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    const why = unavailable(e);
    return why.kind === "unavailable" ? { ok: false, code: why.code, message: why.message } : { ok: false, code: "internal", message: "" };
  }
}

/** The store's own actions that reach the runtime, which is all the page's steps need of it. */
export interface RoutineCalls {
  routineCreate(params: OpParams<"routine.create">): Promise<{ routine: RoutineRow }>;
  routinePause(routine: string): Promise<{ routine: RoutineRow }>;
  routineResume(routine: string): Promise<{ routine: RoutineRow }>;
}

/** What the owner did: added the routine the form describes, or flipped a routine's switch. */
export type RoutineDo = { what: "save"; form: RoutineForm } | { what: "switch"; row: RoutineRow };

/** Asks the runtime to do it, and says what the routines are now and how the page moves on. The list is the runtime's answer
 *  put in its place, never a guess; a refusal leaves it as it was, and a routine the runtime says is gone is dropped. */
export async function routineDo(calls: RoutineCalls, rows: readonly RoutineRow[], todo: RoutineDo): Promise<{ rows: RoutineRow[]; action: RoutinesAction }> {
  const done = await routineStep(async () => {
    if (todo.what === "save") return (await calls.routineCreate(formParams(todo.form))).routine;
    return (await (todo.row.enabled ? calls.routinePause(todo.row.id) : calls.routineResume(todo.row.id))).routine;
  });
  if (done.ok) return { rows: withRoutine(rows, done.value), action: { type: "done", what: todo.what } };
  const gone = done.code === "not_found" && todo.what === "switch";
  return { rows: gone ? rows.filter((r) => r.id !== todo.row.id) : [...rows], action: { type: "failed", message: done.message } };
}
