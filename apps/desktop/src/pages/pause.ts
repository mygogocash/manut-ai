// Pause everyone's rules, kept apart from the page so they can be tested without one: how the flow moves between asking,
// paused and back, and how the page's sentences are chosen from what the runtime says. The page is the design canvas's
// "Team: pause everyone" (PauseAll.dc.html). Pausing is the runtime's to do; nothing here stops anyone.
import { dayLabel, hhmm, sameDay } from "../app/time";
import { listText, t, type Key } from "../i18n";
import type { PausedJob, TeamState } from "../runtime/mission";
import { unavailable } from "./load";

/** What the page itself holds: the question is open, everyone has just come back, a request is on its way, and why the last
 *  one did not go. Whether the team is paused is the runtime's to say (`team.state`), not the page's. */
export interface PauseUi {
  ask: boolean;
  back: boolean;
  busy: boolean;
  error: string | null;
}

export const PAUSE_START: PauseUi = { ask: false, back: false, busy: false, error: null };

export type PauseAction =
  | { type: "ask" }
  | { type: "keep" }
  | { type: "begin" }
  | { type: "done"; paused: boolean }
  | { type: "failed"; message: string };

export function pauseReduce(s: PauseUi, a: PauseAction): PauseUi {
  switch (a.type) {
    case "ask":
      return { ask: true, back: false, busy: false, error: null };
    case "keep":
      return { ...s, ask: false, error: null };
    case "begin":
      return { ...s, busy: true, error: null };
    // A pause that went through ends the question; a resume that went through says everyone is back.
    case "done":
      return { ask: false, back: !a.paused, busy: false, error: null };
    case "failed":
      return { ...s, busy: false, error: a.message };
  }
}

/** "Nam, Pim, Ton and Kit": whom a pause stops, by the names the page shows. */
export const memberNames = (members: readonly string[], nameOf: (bot: string) => string): string => listText(members.map(nameOf));

export const routinesLine = (n: number): string => (n === 0 ? t("pause.routines0") : n === 1 ? t("pause.routine1") : t("pause.routines", { n }));

export const jobsLine = (n: number): string => (n === 0 ? t("pause.jobs0") : n === 1 ? t("pause.job1") : t("pause.jobs", { n }));

/** The running jobs that send things, with how much of it has already gone out: "What has already gone out stays out". */
export function goneOut(running: readonly PausedJob[]): { id: string; title: string; sent: number; total: number }[] {
  return running.flatMap((j) => (j.out ? [{ id: j.id, title: j.title, sent: j.out.sent, total: j.out.total }] : []));
}

/** The words the page says a pause does, as the runtime's pause holds (`TeamState.holds`). The canvas's, as Practice runs
 *  it: every member stops at the next safe point, and nothing expires while paused. apps/api's (`routines`): the team's
 *  routines skip their runs and nothing else changes, so a job already running finishes and a request keeps its own
 *  expiry; saying the canvas's words there would promise the owner what the API does not do. */
export function pauseWords(state: Pick<TeamState, "holds"> | null) {
  const api = state?.holds === "routines";
  return {
    stops: (members: number): Key => (api ? (members === 1 ? "pause.r.stops1" : "pause.r.stops") : members === 1 ? "pause.stops1" : "pause.stops"),
    stays: (api ? "pause.r.finish" : "pause.stays") as Key,
    keeps: (api ? "pause.r.keeps" : "pause.keeps") as Key,
    banner: (api ? "pause.r.banner" : "pause.banner") as Key,
    was: (api ? "pause.r.was" : "pause.was") as Key,
    still: (api ? ["pause.still1", "pause.still2", "pause.r.still3", "pause.r.still4"] : ["pause.still1", "pause.still2", "pause.still3", "pause.still4"]) as Key[],
    hint: (api ? "pause.r.hint" : "pause.hint") as Key,
  };
}

/** A stopped job's line in "What was running": what went and what waits, or that its work is kept (a draft sends nothing).
 *  Where the pause holds only routines, a job still running is not stopped, so its line says it is being finished. */
export function pausedJobLine(j: PausedJob, nameOf: (bot: string) => string, holds?: TeamState["holds"]): string {
  if (holds === "routines") return t("pause.r.finishing", { who: nameOf(j.bot) });
  if (!j.out) return t("pause.kept", { who: nameOf(j.bot) });
  const waiting = j.out.total - j.out.sent;
  const gone = t("pause.sentOf", { sent: j.out.sent, total: j.out.total });
  return waiting <= 0 ? gone : `${gone} ${t(waiting === 1 ? "pause.waiting1" : "pause.waiting", { n: waiting })}`;
}

/** When everyone was paused: the time today, with the day too when it was another. */
export function sinceText(sinceSec: number, nowMs: number): string {
  const time = hhmm(new Date(sinceSec * 1000));
  return sameDay(sinceSec, nowMs / 1000) ? time : `${dayLabel(sinceSec, nowMs)} ${time}`;
}

/** Asks the runtime to pause or resume, and says how the page moves on: the runtime's new state and the flow's next move,
 *  or, when the runtime says no (the connected one: "not yet"), its own words and no new state. */
export async function pauseStep(call: () => Promise<TeamState>, resuming: boolean): Promise<{ state: TeamState | null; action: PauseAction }> {
  try {
    return { state: await call(), action: { type: "done", paused: !resuming } };
  } catch (e) {
    const why = unavailable(e);
    return { state: null, action: { type: "failed", message: why.kind === "unavailable" ? why.message : "" } };
  }
}
