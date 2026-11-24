// The routines half of Customize, kept apart from the page so it can be tested without one: how a routine's next run is said,
// what the New routine form offers and builds, how the form and the switches move, and how a refusal reaches the owner. The
// design canvas's board is "Customize: memory and routines" (Brain.dc.html). What a routine is, when it runs and that one
// which replies or sends always asks first are `@manut/routine-rules`' rules, which the runtime applies
// (src/runtime/routines.ts); the form asks the package itself whether what the owner chose is a routine, so it cannot
// disagree with the runtime, and nothing here runs a routine.
import { createRoutine, mustAskFirst, type RoutineRefusal, type Trigger } from "@manut/routine-rules";
import { lang, locale, t, type Key } from "../i18n";
import { MAX_ROUTINES, type NewRoutine, type RoutineRow } from "../runtime/routines";
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
 *  routine's own, in its own zone. A routine that is off, or has no next run (an event such as stock), has no line. Nor has one
 *  whose next run has already gone by: the connected runtime shows the last good read of the shop while the API cannot be
 *  reached, which can be days old, and "Next: Friday 08:30" would name a day that is over. */
export function nextLine(row: Pick<RoutineRow, "next" | "enabled" | "timeZone">, nowMs: number): string | null {
  if (!row.enabled || row.next === null) return null;
  const at = row.next * 1000;
  if (at < nowMs) return null;
  const zone = zoneOf(row.timeZone);
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

/** What `routine.create` is sent, besides the shop. It never says whether to ask first: the package decides that from the kind of
 *  work. */
export const formParams = (f: RoutineForm): NewRoutine => ({ name: f.name, action: f.action, trigger: formTrigger(f) });

/** The first thing wrong with the form, in the package's own reason, or null. The package is asked, not copied. */
export function formProblem(f: RoutineForm): RoutineRefusal | null {
  const made = createRoutine({ id: "preview", ...formParams(f) });
  return made.ok ? null : made.reason;
}

/** Whether a routine of this kind always asks first, which the form shows before it is added. */
export const formAsksFirst = (f: RoutineForm): boolean => mustAskFirst(f.action);

/** Every refusal a new routine can get, the package's and the API's (`unknown_member` and `wrong_member` are the API's alone, and
 *  the form sends no member), in the owner's words. `invalid_id` and `invalid_request` are a call that went wrong, not a form that
 *  did, and say so in general words. */
const PROBLEMS = new Map<string, Key>([
  ["invalid_name", "routines.problem.name"],
  ["invalid_action", "routines.problem.action"],
  ["invalid_trigger", "routines.problem.trigger"],
  ["invalid_time_zone", "routines.problem.zone"],
  ["invalid_weekdays", "routines.problem.weekdays"],
  ["invalid_time", "routines.problem.time"],
  ["invalid_day", "routines.problem.day"],
  ["invalid_window", "routines.problem.window"],
  ["invalid_threshold", "routines.problem.threshold"],
  ["must_ask_first", "routines.problem.mustAsk"],
  ["unknown_member", "routines.problem.member"],
  ["wrong_member", "routines.problem.member"],
]);

/** What is wrong with the form, in the owner's words. A reason the form cannot cause says so in general words. */
export const problemText = (reason: string): string => t(PROBLEMS.get(reason) ?? "routines.problem.other");

// ---- how the page moves -------------------------------------------------------------------------------------------------

/** What the page itself holds: the form (open, and what it holds), what is wrong with it, a request on its way and why the
 *  last one did not go. Which routines there are, and whether each is on, is the runtime's to say. */
export interface RoutinesUi {
  form: RoutineForm | null;
  problem: RoutineRefusal | null;
  saving: boolean;
  /** the routine whose switch is on its way */
  switching: string | null;
  /** the routine whose Remove question is open, in its row */
  ask: string | null;
  /** the routine whose removal is on its way */
  removing: string | null;
  error: string | null;
}

export const ROUTINES_START: RoutinesUi = { form: null, problem: null, saving: false, switching: null, ask: null, removing: null, error: null };

export type RoutinesAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "set"; patch: Partial<RoutineForm> }
  | { type: "weekday"; day: number }
  | { type: "problem"; reason: RoutineRefusal }
  /** ask whether to remove this routine, in its row */
  | { type: "remove"; routine: string }
  /** the answer that keeps it */
  | { type: "keep" }
  | { type: "begin"; what: "save" }
  | { type: "begin"; what: "switch" | "remove"; routine: string }
  | { type: "done"; what: "save" | "switch" | "remove" }
  | { type: "failed"; message: string }
  /** another shop is shown: nothing asked or typed about the last one stays */
  | { type: "reset" };

/** Whether a request is on its way. */
const busy = (s: RoutinesUi): boolean => s.saving || s.switching !== null || s.removing !== null;

/** Moves the page between editing, waiting on the runtime and done. One request is on its way at a time, and while the form is
 *  being saved it holds still, so a routine is not added twice and what the owner typed is not lost. */
export function routinesReduce(s: RoutinesUi, a: RoutinesAction): RoutinesUi {
  switch (a.type) {
    case "open":
      return busy(s) ? s : { ...s, form: { ...FORM_START, weekdays: [...FORM_START.weekdays] }, problem: null, ask: null, error: null };
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
    // One question at a time: asking about a routine closes the form, so what is on the page is one thing the owner is deciding.
    case "remove":
      return busy(s) ? s : { ...s, ask: a.routine, form: null, problem: null, error: null };
    case "keep":
      return busy(s) ? s : { ...s, ask: null, error: null };
    case "begin":
      if (busy(s)) return s;
      if (a.what === "save") return { ...s, saving: true, error: null };
      return a.what === "switch" ? { ...s, switching: a.routine, error: null } : { ...s, removing: a.routine, error: null };
    // A routine that was added ends the form, and one that was removed ends its question; one that was refused keeps both, with its
    // words, so the owner can try again.
    case "done":
      if (a.what === "save") return { ...s, form: null, problem: null, saving: false, error: null };
      return a.what === "switch" ? { ...s, switching: null, error: null } : { ...s, ask: null, removing: null, error: null };
    case "failed":
      return { ...s, saving: false, switching: null, removing: null, error: a.message };
    case "reset":
      return ROUTINES_START;
  }
}

/** What the runtime's refusals say to the owner, by code: how many routines the team keeps, that a routine is gone, and the words a
 *  new routine's own refusals have in the form. Any other refusal (the connected runtime's "Not yet", an owner-only shop, an API
 *  that did not answer) is shown in the runtime's own words, which it says in the app's language. */
export function refusalText(code: string, message: string): string {
  if (code === "full") return t("routines.err.full", { max: MAX_ROUTINES });
  if (code === "not_found") return t("rt.notFound");
  return PROBLEMS.has(code) ? problemText(code) : message;
}

export type RoutineResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Asks the runtime to act and says how the page moves on: what it answered, or the words to show when it would not (the
 *  connected runtime's "Not yet"), with the runtime's code. The form has already been checked against the package, so a refusal
 *  here is the runtime's, not the owner's. */
export async function routineStep<T>(call: () => Promise<T>): Promise<RoutineResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    const why = unavailable(e);
    return why.kind === "unavailable" ? { ok: false, code: why.code, message: refusalText(why.code, why.message) } : { ok: false, code: "internal", message: "" };
  }
}

/** The store's own actions that reach the runtime, which is all the page's steps need of it. */
export interface RoutineCalls {
  routineCreate(params: NewRoutine): Promise<{ routine: RoutineRow }>;
  routinePause(routine: string): Promise<{ routine: RoutineRow }>;
  routineResume(routine: string): Promise<{ routine: RoutineRow }>;
  routineRemove(routine: string): Promise<{ routine: string }>;
}

/** The store's actions as the page calls them: each change names the shop (`routine.*` in src/runtime/routines.ts). */
export interface RoutineActions {
  routineCreate(shop: string | null, params: NewRoutine): Promise<{ routine: RoutineRow }>;
  routinePause(shop: string | null, routine: string): Promise<{ routine: RoutineRow }>;
  routineResume(shop: string | null, routine: string): Promise<{ routine: RoutineRow }>;
  routineRemove(shop: string | null, routine: string): Promise<{ routine: string }>;
}

/** The actions for `shop`, the one the list on the page was read for. A change never goes to the shop the switcher shows by the
 *  time it is sent: the runtime acts on the shop it is told, which is the list's. */
export function routineCallsFor(actions: RoutineActions, shop: string | null): RoutineCalls {
  return {
    routineCreate: (params) => actions.routineCreate(shop, params),
    routinePause: (routine) => actions.routinePause(shop, routine),
    routineResume: (routine) => actions.routineResume(shop, routine),
    routineRemove: (routine) => actions.routineRemove(shop, routine),
  };
}

/** What the owner did: added the routine the form describes, flipped a routine's switch, or removed one. */
export type RoutineDo = { what: "save"; form: RoutineForm } | { what: "switch"; row: RoutineRow } | { what: "remove"; row: RoutineRow };

export interface RoutineStep {
  rows: RoutineRow[];
  action: RoutinesAction;
  /** the list the owner sees may be out of date: read it again */
  reread: boolean;
}

/** The refusals that mean the owner cannot tell whether the change happened (the API did not answer, or answered in a way this
 *  build cannot read): it is never said to be done, and the list is read again to see. */
const MOVED_ON = new Set(["unavailable"]);

/** Asks the runtime to do it, and says what the routines are now and how the page moves on. The list is the runtime's answer
 *  put in its place, never a guess; a refusal leaves it as it was, and a routine the runtime says is gone is dropped. */
export async function routineDo(calls: RoutineCalls, rows: readonly RoutineRow[], todo: RoutineDo): Promise<RoutineStep> {
  const done = await routineStep<RoutineRow | string>(async () => {
    if (todo.what === "save") return (await calls.routineCreate(formParams(todo.form))).routine;
    if (todo.what === "remove") return (await calls.routineRemove(todo.row.id)).routine;
    return (await (todo.row.enabled ? calls.routinePause(todo.row.id) : calls.routineResume(todo.row.id))).routine;
  });
  if (done.ok) {
    // A removal answers which routine went, and holds none of it; the other answers are the routine as it now stands.
    const next = typeof done.value === "string" ? rows.filter((r) => r.id !== done.value) : withRoutine(rows, done.value);
    return { rows: next, action: { type: "done", what: todo.what }, reread: false };
  }
  const gone = done.code === "not_found" && todo.what !== "save";
  return { rows: gone ? rows.filter((r) => r.id !== todo.row.id) : [...rows], action: { type: "failed", message: done.message }, reread: MOVED_ON.has(done.code) };
}
