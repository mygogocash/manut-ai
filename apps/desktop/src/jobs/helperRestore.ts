// A lead lane's helper rounds across a restart (item 102j-2; `docs/several-agents.md`, rule R11). Rounds live in memory
// (items 102e and 102h), so the resume snapshot keeps each lead's open rounds as plain data, and after a restart they come
// back as rounds that are all back: nothing lands and nothing goes to the lead until the person presses Land what they did or
// Report to Kit on the card the lead's chat then shows (helperLanding.ts's `restore`).
//
// What a helper was doing when the app closed decides what it reports:
// - one back with its report keeps its report and, when its landing was settled, its landing;
// - one still out (its turn running, or its agent starting) failed: the app closed while it worked, and its last answer before
//   that, read from its own saved chat, is its words, so the lead reads what it got to;
// - one still waiting to start failed too: it never started, and has nothing to land.
// Each is counted "failed" rather than "stopped by the person" (it was not the person) or "could not run" (that means its agent
// or setup failed), so the lead reads that its part may be undone and is its to do or send out again.
//
// Pure: the sessions store saves what `saveRounds` returns with the lead's session and hands `restoreRounds` what was read
// back by `parseSavedRounds`.
import { isObj } from "../lib/guards";
import type { HelperRow } from "./helperAsks";
import { REPORT_MAX } from "./helperReports";
import { MAX_ROUNDS, type Ended, type FailureKind, type HelperReport, type Landing, type LandedFile, type Rounds } from "./rules";

/** One helper of a saved round. No `ended`: it was still out when the app closed; `waited`: it was still waiting to start. */
export interface SavedHelper {
  readonly index: number;
  readonly title: string;
  readonly ended?: Ended;
  readonly words?: string;
  readonly failure?: FailureKind;
  readonly budgetSpent?: boolean;
  readonly steps?: number;
  /** its landing when it was settled; none while it was "pending" */
  readonly landing?: Landing | null;
  readonly waited?: boolean;
}

export interface SavedRound {
  readonly id: string;
  readonly helpers: readonly SavedHelper[];
  readonly dropped: { readonly breaker: number; readonly person: number };
}

/** A lead's rounds as the resume snapshot keeps them. */
export interface SavedRounds {
  readonly roundsThisMessage: number;
  readonly rounds: readonly SavedRound[];
}

/** The most rounds, helpers in a round, characters of a title and files of a landing kept; the report's own cap for words. */
const MAX_SAVED_ROUNDS = 8;
const MAX_HELPERS = 12;
const MAX_TITLE = 200;
const MAX_FILES = 200;
const MAX_PATH = 1_000;

const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** What the snapshot keeps of a lead's rounds, or null when it has none open. `titleOf` names a helper that is still out, whose
 *  title is not in the rounds (its session's name, which is its card row's title). */
export function saveRounds(r: Rounds<HelperRow>, titleOf: (round: string, index: number) => string): SavedRounds | null {
  if (!r.rounds.length) return null;
  const rounds = r.rounds.slice(-MAX_SAVED_ROUNDS).map((x): SavedRound => {
    const back = x.reports.map((h): SavedHelper => ({
      index: h.index,
      title: cut(h.title, MAX_TITLE),
      ended: h.ended,
      words: cut(h.words, REPORT_MAX),
      ...(h.failure ? { failure: h.failure } : {}),
      ...(h.budgetSpent ? { budgetSpent: true } : {}),
      ...(h.steps ? { steps: h.steps } : {}),
      ...(h.landing !== "pending" ? { landing: h.landing } : {}),
    }));
    const out = x.out.map((index): SavedHelper => ({ index, title: cut(titleOf(x.id, index), MAX_TITLE) }));
    const waiting = r.waiting.filter((w) => w.round === x.id).map((w): SavedHelper => ({ index: w.index, title: cut(w.brief.title, MAX_TITLE), waited: true }));
    const helpers = [...back, ...out, ...waiting].sort((a, b) => a.index - b.index).slice(0, MAX_HELPERS);
    return { id: x.id, helpers, dropped: x.dropped };
  });
  return { roundsThisMessage: r.roundsThisMessage, rounds };
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const count = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);

function parseLanding(v: unknown): Landing | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !Array.isArray(v.files) || !Array.isArray(v.conflicts)) return undefined;
  const files: LandedFile[] = [];
  for (const f of v.files.slice(0, MAX_FILES)) {
    if (!isObj(f)) return undefined;
    const path = str(f.path, MAX_PATH);
    const added = count(f.added, 1e9);
    const removed = count(f.removed, 1e9);
    if (!path || added === undefined || removed === undefined) return undefined;
    files.push({ path, added, removed });
  }
  const conflicts = v.conflicts.slice(0, MAX_FILES).filter((c): c is string => typeof c === "string" && c.length > 0 && c.length <= MAX_PATH);
  const patchPath = str(v.patchPath, MAX_PATH);
  const error = str(v.error, 2_000);
  const refusal = str(v.refusal, 500);
  return { files, conflicts, ...(patchPath ? { patchPath } : {}), ...(error ? { error } : {}), ...(refusal ? { refusal } : {}) };
}

function parseHelper(v: unknown): SavedHelper | null {
  if (!isObj(v)) return null;
  const index = count(v.index, 99);
  const title = str(v.title, MAX_TITLE);
  if (index === undefined || title === undefined) return null;
  if (v.waited === true) return { index, title, waited: true };
  if (v.ended === undefined) return { index, title };
  if (v.ended !== "done" && v.ended !== "failed" && v.ended !== "stopped") return null;
  const words = str(v.words, REPORT_MAX) ?? "";
  const landing = v.landing === undefined ? undefined : parseLanding(v.landing);
  // a landing that cannot be read is left "pending": Land what they did asks the shell again, which refuses a second landing
  return {
    index,
    title,
    ended: v.ended,
    words,
    ...(v.failure === "infra" || v.failure === "agent" ? { failure: v.failure } : {}),
    ...(v.budgetSpent === true ? { budgetSpent: true } : {}),
    ...(count(v.steps, 10_000) ? { steps: count(v.steps, 10_000)! } : {}),
    ...(landing !== undefined ? { landing } : {}),
  };
}

/** A lead's saved rounds read back, each part checked; a round that cannot be read is left out, and null when none can. */
export function parseSavedRounds(v: unknown): SavedRounds | null {
  if (!isObj(v) || !Array.isArray(v.rounds)) return null;
  const rounds: SavedRound[] = [];
  for (const x of v.rounds.slice(0, MAX_SAVED_ROUNDS)) {
    if (!isObj(x) || !Array.isArray(x.helpers) || !isObj(x.dropped)) continue;
    const id = str(x.id, 200);
    const breaker = count(x.dropped.breaker, 99);
    const person = count(x.dropped.person, 99);
    if (!id || breaker === undefined || person === undefined) continue;
    const helpers = x.helpers.slice(0, MAX_HELPERS).map(parseHelper).filter((h): h is SavedHelper => !!h);
    // a helper that cannot be read, or two in one place, and the round is not what was saved
    if (helpers.length !== Math.min(x.helpers.length, MAX_HELPERS) || new Set(helpers.map((h) => h.index)).size !== helpers.length) continue;
    rounds.push({ id, helpers, dropped: { breaker, person } });
  }
  if (!rounds.length) return null;
  return { roundsThisMessage: Math.min(count(v.roundsThisMessage, 99) ?? MAX_ROUNDS, MAX_ROUNDS), rounds };
}

/** What a helper that was still out when the app closed reports: that, and its last answer before it. */
export const closedWords = (last: string): string =>
  last.trim() ? `The app closed while it worked, so it did not finish its report. Its last answer before that:\n\n${last.trim()}` : "The app closed while it worked, before it answered anything.";
export const NEVER_STARTED = "It never started: the app closed first.";

/** The rounds a restart puts back for a lead: every round back, nothing out or waiting, so nothing starts; a helper's landing
 *  that was not settled is "pending" until Land what they did or Report to Kit. `lastAnswer` reads a helper's last answer from its
 *  saved chat. */
export function restoreRounds(saved: SavedRounds, lastAnswer: (round: string, index: number) => string): Rounds<HelperRow> {
  return {
    rounds: saved.rounds.map((x) => ({
      id: x.id,
      out: [],
      back: true,
      dropped: x.dropped,
      reports: x.helpers.map((h): HelperReport => {
        if (h.waited) return { round: x.id, index: h.index, title: h.title, ended: "failed", words: NEVER_STARTED, landing: null };
        if (!h.ended) return { round: x.id, index: h.index, title: h.title, ended: "failed", words: closedWords(cut(lastAnswer(x.id, h.index), REPORT_MAX)), landing: "pending" };
        return {
          round: x.id,
          index: h.index,
          title: h.title,
          ended: h.ended,
          words: h.words ?? "",
          ...(h.failure ? { failure: h.failure } : {}),
          ...(h.budgetSpent ? { budgetSpent: true } : {}),
          ...(h.steps ? { steps: h.steps } : {}),
          landing: h.landing === undefined ? "pending" : h.landing,
        };
      }),
    })),
    waiting: [],
    infraInARow: 0,
    breakerTripped: false,
    roundsThisMessage: saved.roundsThisMessage,
  };
}
