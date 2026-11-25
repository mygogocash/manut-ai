// When a workflow runs by itself (item 77b). Its time is a routine's trigger, so "when is it next" is `@manut/routine-rules`'
// `nextRun`, in the zone the workflow names, else this computer's.
//
// The clock is the app's own and runs only while the app is open, the Mac is awake and Settings › Workflows is on: no service is
// installed and nothing wakes the Mac. Every TICK_MS the app looks at the time (a local check: no network, no disk but the
// workflow folder) and asks `clockStep` what fell due since it last looked. A time that fell due at most GRACE_MS ago runs. One
// further back was missed while nobody could run it, and is not made up later: it is kept in the history as skipped, with why.
// Before this run of the app started, the app was not open; after it, the Mac was asleep (or the app could not look at the
// clock, which is the same to the person: nothing ran then).
import { nextRun, type Routine } from "@manut/routine-rules";
import { computerZone } from "../lib/zone";
import type { Workflow } from "./file";

/** How often the clock is looked at. A minute's schedule would be read late by up to this much. */
export const TICK_MS = 30_000;
/** How late a time may be read and still run: a tick that came a little late (a busy page, a throttled timer) still runs it. */
export const GRACE_MS = 2 * 60_000;
/** The most due times one look reads for one workflow, so a long-closed app does not walk years of days. */
export const DUE_MAX = 400;

/** The zone a workflow's time is in: its own, else this computer's, else UTC. */
export const zoneOf = (wf: Pick<Workflow, "timeZone">): string => wf.timeZone ?? computerZone() ?? "UTC";

/** The workflow's schedule as a routine, for routine-rules' clock; null without one. */
export function routineOf(wf: Workflow): Routine | null {
  if (!wf.schedule) return null;
  return { id: wf.file, name: wf.name, action: "brief", timeZone: zoneOf(wf), trigger: wf.schedule, asksFirst: false };
}

/** When the workflow next runs by itself, strictly after `now`; null without a schedule. */
export function nextAt(wf: Workflow, now: number): number | null {
  const r = routineOf(wf);
  return r ? nextRun(r, now) : null;
}

/** Why a due time did not run. `closed`: the app was not open then. `asleep`: the app was open, but the Mac slept or the clock was
 *  not looked at. `busy`: the workflow's last run was still going. `off`: Workflows was turned off before it started. */
export type SkipWhy = "closed" | "asleep" | "busy" | "off";

export interface ClockIn {
  /** When the clock was last looked at (kept on this computer); null: never, or not since Workflows was turned on. */
  last: number | null;
  /** When this run of the app began looking: a time before it was missed while the app was not open. */
  loadedAt: number;
  now: number;
  /** The workflows read now, each with when the app first saw its file: a time before that was never this workflow's. */
  list: readonly { workflow: Workflow; seenAt: number }[];
}

export interface ClockOut {
  run: { file: string; due: number }[];
  skip: { file: string; due: number; why: "closed" | "asleep" }[];
}

/** What fell due since the clock was last looked at: the times to run now and the times that were missed. Nothing is due at the
 *  first look (`last` null) or when the clock went back. */
export function clockStep(i: ClockIn): ClockOut {
  const out: ClockOut = { run: [], skip: [] };
  if (i.last === null || !Number.isFinite(i.last) || i.now < i.last) return out;
  for (const { workflow, seenAt } of i.list) {
    const r = routineOf(workflow);
    if (!r) continue;
    let at = nextRun(r, Math.max(i.last, seenAt));
    const ran: number[] = [];
    for (let n = 0; at !== null && at <= i.now && n < DUE_MAX; n++) {
      if (i.now - at <= GRACE_MS) ran.push(at);
      else out.skip.push({ file: workflow.file, due: at, why: at < i.loadedAt ? "closed" : "asleep" });
      at = nextRun(r, at);
    }
    // two times inside the grace (a schedule no trigger has today) are one run: the latest
    if (ran.length) out.run.push({ file: workflow.file, due: ran[ran.length - 1] });
  }
  return out;
}
