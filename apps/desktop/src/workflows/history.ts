// A workflow's runs (item 77b): when each started, which step it reached and how it ended, kept on this computer
// (`localStorage` `manut.workflows.runs`) like the other per-computer records, and bounded. Each workflow keeps its newest
// RUNS_KEPT runs that did something, and its newest skipped runs up to Settings › Workflows' "Skipped runs kept" (T3 Code's
// Labs setting of the same name). A run still going is never dropped. A record that cannot be read is left out, never an error.
import { maskSecrets } from "../lib/secrets";
import type { SkipWhy } from "./schedule";

/** How many runs that did something each workflow keeps. */
export const RUNS_KEPT = 20;
/** A reason's words from the agent are cut to this many characters (after any key in them is hidden). */
export const DETAIL_MAX = 300;

/** Why a run ended that was not done. */
export type EndWhy =
  /** the agent is not installed, is turned off on Settings › Providers, or has no chat here */
  | "agent"
  /** the lane could not start (the folder, the agent's start) */
  | "start"
  /** the next step could not be handed to the agent */
  | "send"
  /** a step's turn failed */
  | "turn"
  /** the agent ended in the middle */
  | "ended"
  /** the person stopped the turn */
  | "interrupted"
  /** the person asked the run to stop after its step */
  | "person"
  /** Workflows was turned off, so the run stopped after its step */
  | "off"
  /** the lane was closed */
  | "closed_lane"
  /** the app closed while it ran */
  | "app_closed";

export type RunState = "running" | "done" | "failed" | "stopped" | "skipped";

export interface RunRec {
  id: string;
  /** the workflow's file */
  file: string;
  /** its name when it ran */
  name: string;
  by: "person" | "schedule";
  /** when it started, or (skipped) when it was due; ms */
  at: number;
  /** the time it was due, for a run the schedule started or skipped */
  due?: number;
  /** how many steps the workflow had */
  steps: number;
  /** the step it reached, 1-based (0: none sent) */
  reached: number;
  state: RunState;
  why?: EndWhy | SkipWhy;
  /** the agent's own words for a failure, keys hidden and cut */
  detail?: string;
  /** the lane's session, while the app knows it */
  session?: string;
  ended?: number;
}

const STATES: readonly RunState[] = ["running", "done", "failed", "stopped", "skipped"];
const WHYS: readonly string[] = ["agent", "start", "send", "turn", "ended", "interrupted", "person", "off", "closed_lane", "app_closed", "closed", "asleep", "busy"];
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v && v.length <= max ? v : undefined);

/** A reason's words as the history keeps them: any key hidden by the app's one masker, then cut, so a cut never leaves part of
 *  a key the masker could not know. */
export const detailOf = (text: string): string => {
  const masked = maskSecrets(text.replace(/\s+/g, " ").trim());
  return masked.length > DETAIL_MAX ? `${masked.slice(0, DETAIL_MAX - 1)}…` : masked;
};

function parseRun(v: unknown): RunRec | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = short(o.id, 64);
  const file = short(o.file, 100);
  const name = short(o.name, 200);
  if (!id || !file || !name || (o.by !== "person" && o.by !== "schedule") || !num(o.at) || !num(o.steps) || !num(o.reached)) return null;
  if (!STATES.includes(o.state as RunState)) return null;
  const r: RunRec = { id, file, name, by: o.by, at: o.at, steps: o.steps, reached: o.reached, state: o.state as RunState };
  if (num(o.due)) r.due = o.due;
  if (typeof o.why === "string" && WHYS.includes(o.why)) r.why = o.why as RunRec["why"];
  const detail = short(o.detail, DETAIL_MAX + 1);
  if (detail) r.detail = detail;
  const session = short(o.session, 16);
  if (session) r.session = session;
  if (num(o.ended)) r.ended = o.ended;
  return r;
}

/** The saved runs, newest first; what cannot be read is left out. */
export function parseRuns(text: string | null): RunRec[] {
  try {
    const v: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(v) ? v.map(parseRun).filter((r): r is RunRec => !!r).sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

/** The runs kept: for each workflow, the newest RUNS_KEPT that did something and the newest `skippedKept` skipped ones, and every
 *  run still going. Newest first. */
export function keepRuns(list: readonly RunRec[], skippedKept: number): RunRec[] {
  const sorted = [...list].sort((a, b) => b.at - a.at);
  const done = new Map<string, number>();
  const skipped = new Map<string, number>();
  return sorted.filter((r) => {
    if (r.state === "running") return true;
    const seen = r.state === "skipped" ? skipped : done;
    const n = seen.get(r.file) ?? 0;
    seen.set(r.file, n + 1);
    return n < (r.state === "skipped" ? skippedKept : RUNS_KEPT);
  });
}

/** Runs saved as still going by an earlier run of the app: it closed while they ran, so they ended then. */
export function settleLeftovers(list: readonly RunRec[], now: number): RunRec[] {
  return list.map((r) => (r.state === "running" ? { ...r, state: "stopped", why: "app_closed", ended: now } : r));
}
