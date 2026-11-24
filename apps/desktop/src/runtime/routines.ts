// What the Customize page asks of a runtime about the team's routines: what the team does on its own schedule. These are the
// ops behind the page's routines half (src/pages/CustomizePage.tsx, routines.ts). Like Mission Control's (mission.ts) and the
// memory ops (memory.ts), the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime
// that does not answer one does not compile.
//
// The rules are `@manut/routine-rules`': what a routine is, how its timing is said, when it runs next, and that a routine that
// replies, sends, pays or deletes always asks first. A runtime applies them by calling that package, never with a copy of its
// own, and a refusal rejects with the package's reason as its code (`invalid_time`, `must_ask_first`, ...). What the API would
// refuse for a routine's shape is said once more below (`newRoutineRefusal`), by that package, so the connected runtime refuses
// it with nothing sent and Practice refuses the same routines.
//
// These ops are `routine.*`, not `routines.*`: `routines.list` is the older, per-member op behind a member's Schedule tab and
// takes a `bot`. These belong to the whole team and take none.
//
// The team is a shop's, and only its owner sees or changes it. `routine.list` says which shop it read (`shop`, null for the
// person's own sign-in while they are in no shop), and every change names the shop its list was read for, as the Connections and
// People ops do, so a change never lands on another shop because the switcher moved meanwhile. A runtime refuses a shop the
// person only helps at (`owner_only`) with nothing sent, and a shop that is not theirs (`not_found`).
//
// A page never fills a gap with a guess of its own. A runtime that does not know what a routine does or whether it asks first
// says `null`, and the page then shows nothing about it, never a claim either way. Times are seconds since the epoch, as
// everywhere in the protocol, although the package counts milliseconds: each runtime converts at its own edge.
import { createRoutine, type ActionKind, type RoutineRefusal, type Trigger } from "@manut/routine-rules";
import { t, type Key } from "../i18n";

/** A routine as the Routines list shows it. */
export interface RoutineRow {
  id: string;
  /** what it does, in the owner's words ("Morning brief") */
  name: string;
  /** when it runs, as the runtime says it ("Every day at 08:00"). `@manut/routine-rules` says it in English only, so a
   *  runtime that uses it shows English in every language until the package takes a locale. */
  when: string;
  /** what kind of work it is, or null when the runtime does not know (a schedule read from the API only says what to do) */
  action: ActionKind | null;
  /** true when it always asks the owner before it acts; false when it may run without asking (a brief or a draft, which
   *  only the owner sees); null when the runtime cannot say, which the page shows as nothing */
  asksFirst: boolean | null;
  /** switched on: it runs at its times. A paused routine is off and has no next run. */
  enabled: boolean;
  /** when it next starts, in seconds; null for a routine that is off, for one that waits on an event (stock) and for one the
   *  runtime cannot time */
  next: number | null;
  /** the time zone `when` and `next` are in */
  timeZone: string;
  /** whether `routine.remove` can take it away: one of the team's routines. A schedule of the shop's own, which the connected
   *  runtime shows as a routine, is never changed from a session, so it cannot be removed. */
  removable: boolean;
}

/** What a new routine is made of, as the form gives it. */
export interface NewRoutine {
  name: string;
  action: ActionKind;
  trigger: Trigger;
  /** left out, a routine that replies, sends, pays or deletes asks first and a brief or a draft does not */
  asksFirst?: boolean;
}

/** How many routines one shop's team keeps (`MAX_ROUTINES` in apps/api/src/routine-store.ts); a new one past it is refused
 *  `full`. */
export const MAX_ROUTINES = 50;

/** What the package refuses a new routine for, and what the API refuses besides: `invalid_request` for an `asksFirst` that is
 *  neither true nor false. */
export type NewRoutineRefusal = RoutineRefusal | "invalid_request";

/** The API's first refusal of a new routine's shape, in the order it checks (`buildRoutine` in apps/api/src/routine-setup.ts), or
 *  null when it would take it: the package's own (`createRoutine`, so a routine that replies, sends, pays or deletes and says it
 *  need not ask is `must_ask_first`, never quietly changed). The form sends no time zone and no member, so those refusals are
 *  the API's alone. A runtime refuses with it before sending. */
export function newRoutineRefusal(p: { name: unknown; action: unknown; trigger: unknown; asksFirst?: unknown }): NewRoutineRefusal | null {
  if (p.asksFirst !== undefined && typeof p.asksFirst !== "boolean") return "invalid_request";
  const made = createRoutine({
    id: "preview",
    name: p.name as string,
    action: p.action as ActionKind,
    trigger: p.trigger as Trigger,
    ...(p.asksFirst === undefined ? {} : { asksFirst: p.asksFirst }),
  });
  return made.ok ? null : made.reason;
}

/** Every refusal a new routine can get, the package's and the API's (`unknown_member` and `wrong_member` are the API's alone, and the
 *  form sends no member), in words of the owner's. Said once, here: the New routine form says what is wrong with what the owner chose
 *  by it, and the connected runtime says what the API refused by it. `invalid_id` and `invalid_request` are a call that went wrong, not
 *  a form that did, so they have none of their own. */
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

/** What is wrong with a new routine, in the owner's words, by the reason the package or the API gave; null for a reason with no
 *  words of its own. */
export const problemWords = (reason: string): string | null => {
  const key = PROBLEMS.get(reason);
  return key ? t(key) : null;
};

/** The timing as the API reads it, with only the fields its kind has, so nothing a caller left on the object goes with it. Only
 *  for a timing `newRoutineRefusal` took. */
export function triggerBody(t: Trigger): Trigger {
  switch (t.kind) {
    case "daily":
      return { kind: "daily", at: t.at };
    case "weekly":
      return { kind: "weekly", weekdays: [...t.weekdays], at: t.at };
    case "monthly":
      return { kind: "monthly", day: t.day, at: t.at };
    case "window":
      return { kind: "window", from: t.from, to: t.to };
    case "stockBelow":
      return { kind: "stockBelow", threshold: t.threshold };
  }
}

export interface RoutineOps {
  /** Every routine of the team, in the order they were made, and the shop they were read for (null while the person is in no
   *  shop). Refused `owner_only` for a shop the person only helps at. */
  "routine.list": { params: Record<string, never>; result: { shop: string | null; routines: RoutineRow[] } };
  /** Makes a routine, switched on, for `shop` (as `routine.list` named it). `asksFirst` is optional: left out, a routine that
   *  replies, sends, pays or deletes asks first and a brief or a draft does not. Saying `false` for one that must ask is
   *  refused (`must_ask_first`), never quietly changed. */
  "routine.create": { params: { shop: string | null } & NewRoutine; result: { routine: RoutineRow } };
  /** Switches a routine off. It stops running and has no next run. Pausing a paused routine changes nothing. */
  "routine.pause": { params: { shop: string | null; routine: string }; result: { routine: RoutineRow } };
  /** Switches it on again; its next run is worked out from now. */
  "routine.resume": { params: { shop: string | null; routine: string }; result: { routine: RoutineRow } };
  /** Takes a routine away, with its runs and its clock. The answer names the routine and holds none of it. Refused `not_found`
   *  for one the shop no longer has. */
  "routine.remove": { params: { shop: string | null; routine: string }; result: { routine: string } };
}
