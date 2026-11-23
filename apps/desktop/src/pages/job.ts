// The job view's rules, kept apart from the page so they can be tested without one: how money, times and stages are
// written, how the timeline and the trace read, and what Copy trace puts on the clipboard. The page is the design
// canvas's Job.dc.html ("A job, two depths"). Money here is integer satang and is never turned into a float.
import { dayLabel, elapsed, hhmm, sameDay } from "../app/time";
import { t, type Key } from "../i18n";
import type { Job, JobStage, JobStep, RecipientStatus, TraceResult, TraceStep } from "../runtime/mission";

/** Digits in groups of three, as the canvas writes "1,964". */
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "฿1.20", "฿0.38", "฿1,290": the baht sign first, satang only when there are some (@manut/format's rule). Anything that
 *  is not a whole, safe, non-negative number of satang is a dash: a page never guesses an amount. */
export function satangText(satang: number): string {
  if (!Number.isSafeInteger(satang) || satang < 0) return "—";
  const rest = satang % 100;
  return `฿${groupDigits(Math.floor(satang / 100))}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** How long one step took: tenths of a second under ten seconds, whole seconds under a minute, then minutes and hours. */
export function stepTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return t("job.t.s", { n: (tenths / 10).toFixed(1) });
  if (ms < 60_000) return t("job.t.s", { n: Math.round(ms / 1000) });
  if (ms < 3_600_000) return t("job.t.min", { n: Math.round(ms / 60_000) });
  return t("job.t.h", { n: (ms / 3_600_000).toFixed(1) });
}

/** "Took 40 seconds": seconds under a minute, then the app's own "2m 5s" and "1h 5m". */
export function tookText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? t(s === 1 ? "job.second" : "job.seconds", { n: s }) : elapsed(s * 1000);
}

/** A stage as a row's tag says it, in the canvas's colour: amber waits on the owner, blue works, green is done, red failed. */
const TAG: Record<JobStage, { word: Key; cls: string }> = {
  proposed: { word: "thread.st.needs", cls: "tag warn" },
  approved: { word: "job.step.approved", cls: "tag" },
  working: { word: "thread.st.running", cls: "tag run" },
  paused: { word: "job.step.paused", cls: "tag" },
  sent: { word: "job.step.sent", cls: "tag ok" },
  checked: { word: "job.step.checked", cls: "tag ok" },
  failed: { word: "job.step.failed", cls: "tag err" },
  cancelled: { word: "job.step.cancelled", cls: "tag" },
  partly: { word: "job.step.partly", cls: "tag warn" },
};

export const stageTag = (stage: JobStage): { word: Key; cls: string } => TAG[stage];

/** A stage as the timeline says it, before its time: a proposal is "Proposed" here and "Needs you" in a row's tag. */
const STEP_WORD: Record<JobStage, Key> = { ...Object.fromEntries(Object.entries(TAG).map(([k, v]) => [k, v.word])), proposed: "job.step.proposed" } as Record<JobStage, Key>;

export interface TimelineChip {
  stage: JobStage;
  text: string;
  cls: string;
}

/** The timeline's chips, each with the time it happened ("Sent 09:14"), only the last coloured for where the job stands. A
 *  job that is still working has no end to its step, so its chip says no time. `day` names the day the job began when it
 *  was not today, because a time alone would not say which. */
export function timeline(steps: readonly JobStep[], nowMs: number): { day: string | null; chips: TimelineChip[] } {
  const last = steps.length - 1;
  const chips = steps.map((s, i) => ({
    stage: s.stage,
    text: s.stage === "working" ? t(STEP_WORD.working) : `${t(STEP_WORD[s.stage])} ${hhmm(new Date(s.at * 1000))}`,
    cls: i === last ? TAG[s.stage].cls : "tag",
  }));
  const first = steps[0];
  return { day: first && !sameDay(first.at, nowMs / 1000) ? dayLabel(first.at, nowMs) : null, chips };
}

const RECIPIENT: Record<RecipientStatus, { word: Key; cls: string }> = {
  waiting: { word: "job.to.waiting", cls: "tag" },
  delivered: { word: "job.to.delivered", cls: "tag" },
  read: { word: "job.to.read", cls: "tag ok" },
  failed: { word: "job.to.failed", cls: "tag err" },
};

export const recipientTag = (status: RecipientStatus): { word: Key; cls: string } => RECIPIENT[status];

/** The first letter of the given name, past Khun, for the small round face beside a customer. */
export function initialOf(name: string): string {
  const given = name.trim().replace(/^(khun\s+|คุณ\s*)/i, "");
  return Array.from(given)[0]?.toUpperCase() ?? "?";
}

const RESULT: Record<TraceResult, Key> = { pass: "job.result.pass", fail: "job.result.fail", running: "job.result.running" };
export const resultWord = (r: TraceResult): Key => RESULT[r];

export interface TraceRowView {
  tool: string;
  found: string;
  time: string;
  /** the step's cost, or null when it cost nothing */
  cost: string | null;
  result: TraceResult | null;
}

export function traceRows(trace: readonly TraceStep[]): TraceRowView[] {
  return trace.map((s) => ({ tool: s.tool, found: s.found, time: stepTime(s.ms), cost: s.costSatang === null ? null : satangText(s.costSatang), result: s.result }));
}

/** What the rows add up to: the tokens (null when no step used any) and the cost in satang. */
export function traceTotal(trace: readonly TraceStep[]): { tokens: number | null; costSatang: number } {
  const used = trace.filter((s): s is TraceStep & { tokens: number } => s.tokens !== null);
  return { tokens: used.length ? used.reduce((n, s) => n + s.tokens, 0) : null, costSatang: trace.reduce((n, s) => n + (s.costSatang ?? 0), 0) };
}

export const tokensText = (n: number): string => t("job.tokens", { n: groupDigits(n) });

/** The trace as plain text for the clipboard: the job's title, a line per step and the total. Only what the page shows of
 *  the steps: no customer's name or words. */
export function traceText(job: Pick<Job, "title" | "trace">): string {
  const total = traceTotal(job.trace);
  return [
    job.title,
    ...traceRows(job.trace).map((r) => [r.tool, r.found, r.time, r.cost, r.result && t(RESULT[r.result])].filter((x): x is string => !!x).join(" · ")),
    [t("job.total"), total.tokens === null ? null : tokensText(total.tokens), satangText(total.costSatang)].filter((x): x is string => !!x).join(" · "),
  ].join("\n");
}
