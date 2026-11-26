// The words a running turn shows: a tool call as "<Verb> <detail>", the working and thinking lines, the answer as far
// as it can be shown yet, and the plan the agent sent; with the timings the steer queue waits by. Split out of
// store.ts (item 125d), which re-exports what it exported before.
import { t as tr, type Key } from "../i18n";
import type { PlanItem } from "../lib/protocol";
import { hideSplitBlocks } from "../threads/types";
import type { Turn } from "./types";

// ---- activity text --------------------------------------------------------------------------

const VERBS: Record<string, Key> = {
  terminal: "live.running",
  read_file: "live.reading",
  search_files: "live.searching",
  web_search: "live.searchingWeb",
  web_extract: "live.reading",
  write_file: "live.editing",
  patch: "live.editing",
  delegate_task: "live.asking",
  skill_view: "live.usingSkill",
  skill_use: "live.usingSkill",
};

/** "<Verb> <detail>" for a tool call, the verb in the current language; unknown tools keep their own name. */
export function activityText(name: string, detail: string): string {
  const verb = VERBS[name] ? tr(VERBS[name]) : name;
  const d = (detail ?? "").trim();
  return d ? `${verb} ${d}` : verb;
}

/** The live text split for display: when it is the latest tool's text, `code` holds its command or path. */
/** The status of a turn found running on open, before any event: shown as "Working…" in the current language. */
export const WORKING = "Working…";
/** The status a turn gets from `thinking`, before any tool or status text. */
export const THINKING = "Thinking…";
/** A held message sent whose turn has not started after this long (a command Hermes answered with no turn) no
 *  longer holds the steer queue. */
export const PENDING_TURN_MS = 15_000;
/** Steer errors that are a clear refusal (the gateway answered no): the row is sent normally after the turn. Any
 *  other error (disconnected, bot_offline, timeout, internal) leaves it unknown: Hermes may have taken it. A runtime
 *  that has no steer at all (`not_yet`, the connected one) refuses as clearly, so a Cmd+Enter there waits instead. */
export const STEER_REFUSED = new Set(["gateway_error", "bad_request", "not_yet"]);
/** How much of a turn's thinking text is kept (the start; the rest is dropped, never shown cut mid-word). */
export const THINKING_MAX = 20_000;

/** A plan as the agent sent it: rows with text, an unknown status read as pending. */
export function parsePlan(items: unknown): PlanItem[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { text, status } = x as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || !text.trim()) return [];
    const st = status === "in_progress" || status === "completed" ? status : "pending";
    return [{ text, status: st }];
  });
}

export function liveLabel(t: Turn): { verb: string; code?: string } {
  const status = t.status || WORKING;
  const last = t.steps[t.steps.length - 1];
  if (last && last.detail && status === activityText(last.name, last.detail)) {
    return { verb: activityText(last.name, ""), code: last.detail };
  }
  return { verb: status };
}

/** Whether a running turn has something for its activity line to say: a tool or skill ran, or the bot sent a
 *  status of its own. Before that (only thinking) the chat shows the typing bubble instead of the line. */
/** The part of the answer being written that can be shown already: its whole lines, after the latest tool call,
 *  never a line still being typed and never an open code block (it shows once its closing fence came). Shown in
 *  pieces of whole lines, so the answer grows a line or paragraph at a time instead of word by word. */
export function answerSoFar(t: Turn): string {
  const text = hideSplitBlocks(t.streaming.slice(t.cut ?? 0).replace(/^\s+/, ""));
  const end = text.lastIndexOf("\n");
  if (end < 0) return "";
  const lines = text.slice(0, end).split("\n");
  let keep = lines.length;
  let open = -1;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) open = open < 0 ? i : -1;
  });
  if (open >= 0) keep = open;
  return lines.slice(0, keep).join("\n").trimEnd();
}

export function turnHasActivity(t: Turn): boolean {
  return t.steps.length > 0 || t.skills.length > 0 || !!(t.status && t.status !== THINKING && t.status !== WORKING) || !!t.plan?.length || !!t.thinking;
}
