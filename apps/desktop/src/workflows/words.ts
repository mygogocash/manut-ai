// What Settings › Workflows says (item 77b), kept apart from the page so each sentence can be tested: when a workflow runs, when it
// runs next, why a file is not a workflow, and one line for each run in the history. The times are a workflow's own, in its zone,
// which is named whenever it is not this computer's (`lib/zone.ts`), as a routine's are.
import { lang, listText, locale, t, type Key } from "../i18n";
import { computerZone, withZone } from "../lib/zone";
import { nextLine } from "../pages/routines";
import type { Standing } from "./allow";
import type { Workflow, WorkflowWhy } from "./file";
import type { RunRec } from "./history";
import type { RunRefusal } from "./runner";
import { nextAt, zoneOf } from "./schedule";

/** A weekday's name in the page's language, 0 being Sunday. 4 January 1970 was a Sunday. */
const dayName = (d: number): string =>
  new Intl.DateTimeFormat(lang() === "en" ? "en-GB" : locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(1970, 0, 4 + d)));

/** When the workflow runs by itself, with its zone when that is not this computer's; how it runs when it has no time. */
export function whenWords(wf: Workflow, nowMs: number): string {
  const s = wf.schedule;
  if (!s) return t("wf.manual");
  const words =
    s.kind === "daily"
      ? t("wf.when.daily", { at: s.at })
      : s.kind === "weekly"
        ? [...new Set(s.weekdays)].length === 7
          ? t("wf.when.daily", { at: s.at })
          : t("wf.when.weekly", { days: listText([...new Set(s.weekdays)].sort((a, b) => a - b).map(dayName)), at: s.at })
        : s.day === "last"
          ? t("wf.when.last", { at: s.at })
          : t("wf.when.monthly", { day: s.day, at: s.at });
  return withZone(words, zoneOf(wf), nowMs);
}

/** "Next: Monday 02:00", as a routine's next run is said; null without a schedule. */
export function nextWords(wf: Workflow, nowMs: number): string | null {
  const at = nextAt(wf, nowMs);
  return at === null ? null : nextLine({ next: Math.floor(at / 1000), enabled: true, timeZone: zoneOf(wf) }, nowMs);
}

/** Why a file is not a workflow, in words (`detail`: the field, the step's number or the other file). */
export const fileWhyWords = (why: WorkflowWhy, detail?: string): string => t(`wf.file.${why}` as Key, { detail: detail ?? "" });

/** Why a workflow cannot run yet (item 91): never allowed, or its file changed since it was. */
export const standingWords = (s: Exclude<Standing, "allowed">): string => t(`wf.stand.${s}` as Key);

/** Why a run did not start: Run now's own reasons, else the reason its skipped run keeps. */
export const refusedWords = (r: RunRefusal): string => (r === "off" || r === "running" || r === "unreadable" ? t(`wf.refused.${r}` as Key) : t(`wf.why.${r}` as Key));

/** "Done", "Failed", "Skipped", ... */
export const stateWords = (r: Pick<RunRec, "state">): string => t(`wf.state.${r.state}` as Key);

/** Why a run ended as it did, or was skipped; empty for one that is done or still going. */
export const whyWords = (r: Pick<RunRec, "why">): string => (r.why ? t(`wf.why.${r.why}` as Key) : "");

/** When a run started, or was due: the date and the 24-hour time, on this computer's clock. */
export const atWords = (ms: number): string =>
  new Intl.DateTimeFormat(lang() === "en" ? "en-GB" : locale(), { timeZone: computerZone() ?? undefined, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** One run of the history: "25 Nov, 02:00 · Done · step 3 of 3", "... · Skipped · The app was not open." */
export function runLine(r: RunRec): string {
  const parts = [atWords(r.at), stateWords(r)];
  if (r.state !== "skipped") parts.push(t("wf.reached", { step: r.reached, steps: r.steps }));
  const why = whyWords(r);
  if (why) parts.push(why);
  return parts.join(" · ");
}
