// What the Customize page asks of a runtime about the team's routines: what the team does on its own schedule. These are the
// ops behind the page's routines half (src/pages/CustomizePage.tsx, routines.ts). Like Mission Control's (mission.ts) and the
// memory ops (memory.ts), the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime
// that does not answer one does not compile.
//
// The rules are `@manut/routine-rules`': what a routine is, how its timing is said, when it runs next, and that a routine that
// replies, sends, pays or deletes always asks first. A runtime applies them by calling that package, never with a copy of its
// own, and a refusal rejects with the package's reason as its code (`invalid_time`, `must_ask_first`, ...).
//
// These ops are `routine.*`, not `routines.*`: `routines.list` is the older, per-member op behind a member's Schedule tab and
// takes a `bot`. These belong to the whole team and take none.
//
// A page never fills a gap with a guess of its own. A runtime that does not know what a routine does or whether it asks first
// says `null`, and the page then shows nothing about it, never a claim either way. Times are seconds since the epoch, as
// everywhere in the protocol, although the package counts milliseconds: each runtime converts at its own edge.
import type { ActionKind, Trigger } from "@manut/routine-rules";

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
}

export interface RoutineOps {
  /** Every routine of the team, in the order they were made. */
  "routine.list": { params: Record<string, never>; result: { routines: RoutineRow[] } };
  /** Makes a routine, switched on. `asksFirst` is optional: left out, a routine that replies, sends, pays or deletes asks
   *  first and a brief or a draft does not. Saying `false` for one that must ask is refused (`must_ask_first`), never
   *  quietly changed. */
  "routine.create": { params: { name: string; action: ActionKind; trigger: Trigger; asksFirst?: boolean }; result: { routine: RoutineRow } };
  /** Switches a routine off. It stops running and has no next run. Pausing a paused routine changes nothing. */
  "routine.pause": { params: { routine: string }; result: { routine: RoutineRow } };
  /** Switches it on again; its next run is worked out from now. */
  "routine.resume": { params: { routine: string }; result: { routine: RoutineRow } };
}
