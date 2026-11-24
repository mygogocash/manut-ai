// Mission Control on the connected runtime: the shop's jobs, its activity log and its team's state, read from what the
// runtime already reads of a shop (shop.ts). A job is a task: the member whose run has it now (`memberOf`), where its
// runs and the exact actions it asked for say it stands, and what its runs reported (their model, tokens and cost). This
// is how apps/api's own jobs list reads a shop's jobs (workers.ts `jobOf`), so the console and the app say the same.
//
// Nothing here is a number or a claim of its own. A time the API did not keep is no time (a trace step's `-1` milliseconds
// is the page's dash), a cost no run reported is no cost, a customer the API names only by a LINE id is not listed as a
// recipient, and an activity log with no fixed span says none (`keptMonths: null`). Words come from the dictionaries.
//
// The team's state is `GET /v1/routines`' team, which apps/api's Pause everyone changes: it holds the team's routines and
// nothing else (`holds: "routines"`), so the jobs running now go on running, and the page says so.
import { t } from "../../i18n";
import type { ActivityEvent, ActivityKind, Job, JobRow, JobStage, JobStep, TeamState, TraceStep } from "../mission";
import { isAsk } from "./approvals";
import type { ShopAction, ShopAttempt, ShopSnapshot, ShopTask } from "./shop";
import { actionText, attemptLive, memberName, memberOf, taskRunning, titleOf } from "./view";

const sec = (ms: number) => ms / 1000;

/** An action's states that are settled one way or another, and whether it went out. */
const WENT_OUT = new Set(["confirmed"]);
const ON_ITS_WAY = new Set(["approved", "dispatching"]);
const DID_NOT = new Set(["failed", "unknown"]);
const DROPPED = new Set(["rejected", "expired"]);

/** The tasks whose request still waits for the owner, from the open asks of the read. */
const waitingTasks = (s: ShopSnapshot) => new Set(s.approvals.filter(isAsk).map((a) => a.taskId));

/** How a task's actions settled, as a stage, or null while none settled (or it asked for none). One that went out is
 *  `sent`, one on its way `approved`, one that failed `failed`, and a task whose every action was declined or ran out of
 *  time sent nothing: `cancelled`. */
function actionStage(task: ShopTask): JobStage | null {
  const states = task.actions.map((a) => a.state);
  if (states.some((x) => WENT_OUT.has(x))) return "sent";
  if (states.some((x) => ON_ITS_WAY.has(x))) return "approved";
  if (states.some((x) => DID_NOT.has(x))) return "failed";
  if (states.length > 0 && states.every((x) => DROPPED.has(x))) return "cancelled";
  return null;
}

/** How the newest run left its job (workers.ts `endingOf`). A run done with a draft drafted; done with none, it checked
 *  and found nothing to write. A run that passed the job on is still working while the member it went to takes it up. A
 *  finished run with no outcome recorded is never read as a success. */
function attemptStage(a: ShopAttempt, task: ShopTask, nowMs: number): JobStage {
  if (a.status === "active") return attemptLive(a, nowMs) ? "working" : "failed";
  switch (a.outcome) {
    case "done":
      return a.handedTo ? "working" : task.draft ? "drafted" : "checked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "awaiting_owner":
      return "proposed";
    default:
      return "failed";
  }
}

/** Where a task stands as a job. Waiting for the owner comes first, as everywhere; then a member's run; then its actions;
 *  then the task's own state. A run that stopped to ask, whose request is no longer waiting, stands where its actions
 *  settled, or `cancelled` when none did (the request expired or was withdrawn). */
export function stageOf(task: ShopTask, waiting: boolean, nowMs: number): JobStage {
  if (waiting) return "proposed";
  const run = memberOf(task) === task.attempts.at(-1)?.executor ? task.attempts.at(-1) : undefined;
  if (run) {
    const stage = attemptStage(run, task, nowMs);
    return stage === "proposed" ? (actionStage(task) ?? "cancelled") : stage;
  }
  if (task.state === "paused") return "paused";
  if (task.state === "failed") return "failed";
  if (task.state === "cancelled") return "cancelled";
  const settled = actionStage(task);
  if (settled) return settled;
  return task.state === "completed" ? "checked" : "working";
}

/** The steps a task took, oldest first, each when the API says it happened: each member's run starting, each action asked
 *  for, approved and sent. The last step is always where the job stands, at the latest moment the read knows of it. */
function stepsOf(task: ShopTask, stage: JobStage, lastMs: number): JobStep[] {
  const steps: { stage: JobStage; ms: number }[] = [];
  for (const a of task.attempts) if (a.claimedAt !== null) steps.push({ stage: "working", ms: a.claimedAt });
  for (const a of task.actions) {
    if (a.proposedAt !== null) steps.push({ stage: "proposed", ms: a.proposedAt });
    if (a.approvedAt !== null) steps.push({ stage: "approved", ms: a.approvedAt });
    if (WENT_OUT.has(a.state) && (a.dispatchedAt ?? a.approvedAt) !== null) steps.push({ stage: "sent", ms: (a.dispatchedAt ?? a.approvedAt) as number });
  }
  steps.sort((x, y) => x.ms - y.ms);
  const last = steps.at(-1);
  if (!last || last.stage !== stage) steps.push({ stage, ms: Math.max(lastMs, last?.ms ?? lastMs) });
  return steps.map((s) => ({ stage: s.stage, at: sec(s.ms) }));
}

/** The latest moment the read knows of a task: its document, its runs, its actions and its draft. */
function lastMsOf(task: ShopTask, readAt: number): number {
  const times = [
    task.updatedAt,
    task.createdAt,
    task.draft?.at ?? null,
    ...task.attempts.flatMap((a) => [a.claimedAt, a.finishedAt]),
    ...task.actions.flatMap((a) => [a.proposedAt, a.approvedAt, a.dispatchedAt]),
  ].filter((x): x is number => x !== null);
  return times.length ? Math.max(...times) : readAt;
}

function jobRowOf(task: ShopTask, s: ShopSnapshot, waiting: Set<string>): JobRow & { steps: JobStep[] } {
  const stage = stageOf(task, waiting.has(task.id), s.readAt);
  const steps = stepsOf(task, stage, lastMsOf(task, s.readAt));
  return { id: task.id, title: titleOf(task), bot: memberOf(task), stage, at: steps.at(-1)?.at ?? sec(s.readAt), steps };
}

/** Every task as a job, newest moved first (`jobs.list`). */
export function jobRows(s: ShopSnapshot): JobRow[] {
  const waiting = waitingTasks(s);
  return s.tasks
    .map((task) => jobRowOf(task, s, waiting))
    .map(({ id, title, bot, stage, at }) => ({ id, title, bot, stage, at }))
    .sort((a, b) => b.at - a.at);
}

/** One run as a step of the trace, for the developers' view: the model it called, how it ended in the API's own codes
 *  (and whom it passed the job to), how long it ran, and what its spend reports said it used and cost. */
function traceStep(a: ShopAttempt, nowMs: number): TraceStep {
  const live = attemptLive(a, nowMs);
  const end = a.finishedAt ?? (live ? nowMs : null);
  const ended = a.handedTo ? `→ ${a.handedTo}` : [a.outcome || a.status, a.reason].filter(Boolean).join(": ");
  return {
    tool: [a.executor, a.model].filter(Boolean).join(" · ") || a.id,
    found: ended,
    // the page writes a dash for a time it is not told (job.ts `stepTime`), never a guess
    ms: a.claimedAt !== null && end !== null && end >= a.claimedAt ? end - a.claimedAt : -1,
    costSatang: a.costSatang,
    tokens: a.tokens,
    result: live ? "running" : a.outcome === "done" ? "pass" : a.outcome === "failed" || a.status === "active" ? "fail" : null,
  };
}

/** One job, whole (`jobs.get`), or null when the read holds no such task. The goal is the task's own; what happened is the
 *  draft a member wrote, when one did. The cost is what the runs reported, in whole satang; how long it took counts each
 *  run from its claim to its end, and is null while one still runs or a time is missing. */
export function jobOf(s: ShopSnapshot, id: string): Job | null {
  const task = s.tasks.find((x) => x.id === id);
  if (!task) return null;
  const row = jobRowOf(task, s, waitingTasks(s));
  const live = task.attempts.some((a) => attemptLive(a, s.readAt));
  const spans = task.attempts.map((a) => (a.claimedAt !== null && a.finishedAt !== null && a.finishedAt >= a.claimedAt ? a.finishedAt - a.claimedAt : null));
  return {
    ...row,
    goal: task.objective || titleOf(task),
    again: null,
    summary: task.draft?.text ?? "",
    recipients: [],
    costSatang: task.attempts.reduce((n, a) => n + (a.costSatang ?? 0), 0),
    tookSeconds: live || !spans.length || spans.includes(null) ? null : Math.round(spans.reduce<number>((n, x) => n + (x ?? 0), 0) / 1000),
    trace: task.attempts.map((a) => traceStep(a, s.readAt)),
  };
}

// ---- the activity log ---------------------------------------------------------------------------------------------

/** An approval-core kind as the log's kind (approval-core's six; apps/api's requests carry them). */
const KIND_OF_REQUEST: Readonly<Record<string, ActivityKind>> = {
  message: "msg",
  reply: "msg",
  money: "money",
  payment_confirmation: "money",
  public_post: "post",
  command: "code",
};
/** What a member's draft is, as the log's kind: a reply is a message, a post a post, the sales summary money. */
const KIND_OF_JOB: Readonly<Record<string, ActivityKind>> = { reply: "msg", post: "post", daily_summary: "money" };

const LINE = "line.message.push";

/** An action's kind: its request's, while the read holds the request, else what its operation is. */
function actionKind(a: ShopAction, kinds: Map<string, string>): ActivityKind {
  const kind = KIND_OF_REQUEST[kinds.get(a.id) ?? ""];
  if (kind) return kind;
  if (a.operationType.startsWith("linear.")) return "code";
  return "msg";
}

/** Who approved it, in words: the owner (the link, the shop's own session or their account), else that it was approved. */
function approvedWords(a: ShopAction): string {
  return a.approvedBy.startsWith("owner") ? t("rt.ev.youApproved") : t("rt.ev.approved");
}

/** An action as an event: one waiting for the owner, or one that went out. An action declined, expired or not yet
 *  settled made nothing happen outside, and the log is what happened. A LINE reply's words are the customer's
 *  conversation, so they are private: hidden until the owner shows them. */
function actionEvent(task: ShopTask, a: ShopAction, waiting: boolean, kinds: Map<string, string>): ActivityEvent | null {
  const line = a.operationType === LINE;
  const who = memberOf(task);
  const base = {
    id: `${task.id}:${a.id}`,
    who,
    kind: actionKind(a, kinds),
    item: titleOf(task),
    job: task.id,
    where: line ? t("rt.ev.line") : a.operationType,
    note: "",
    text: line && typeof a.payload.text === "string" ? { body: a.payload.text, private: true } : null,
  };
  const name = { who: memberName(who), action: actionText(a) };
  if (a.state === "proposed" && waiting && a.proposedAt !== null) {
    return { ...base, at: sec(a.proposedAt), title: t(line ? "rt.ev.askReply" : "rt.ev.ask", name), approval: t("rt.ev.waiting"), status: "needs_you", undo: t("rt.ev.undoAsk") };
  }
  const at = a.dispatchedAt ?? a.approvedAt;
  if (WENT_OUT.has(a.state) && at !== null) {
    const status = base.kind === "post" ? "posted" : "sent";
    return { ...base, at: sec(at), title: t(line ? "rt.ev.sentReply" : "rt.ev.did", name), approval: approvedWords(a), status, undo: line ? t("rt.ev.undoLine") : "" };
  }
  return null;
}

/** A member's draft as an event: written for the owner to read, kept in the app, sent nowhere. A reply's draft is to a
 *  customer, so its words are private like the reply's. */
function draftEvent(task: ShopTask): ActivityEvent | null {
  const draft = task.draft;
  if (!draft || draft.at === null) return null;
  const who = draft.member || memberOf(task);
  return {
    id: `${task.id}:draft`,
    at: sec(draft.at),
    who,
    kind: KIND_OF_JOB[draft.job] ?? "msg",
    title: t("rt.ev.draft", { who: memberName(who) }),
    item: titleOf(task),
    job: task.id,
    approval: t("rt.ev.inApp"),
    status: "drafted",
    where: t("rt.ev.app"),
    undo: t("rt.ev.undoDraft"),
    note: "",
    text: { body: draft.text, private: draft.job === "reply" },
  };
}

/** The activity log (`activity.list`), newest first: every draft a member wrote, every action waiting for the owner and
 *  every action that went out. */
export function activityOf(s: ShopSnapshot): ActivityEvent[] {
  const waiting = waitingTasks(s);
  const kinds = new Map(s.approvals.map((a) => [a.record.request.id, typeof a.record.request.kind === "string" ? a.record.request.kind : ""] as const));
  return s.tasks
    .flatMap((task) => [draftEvent(task), ...task.actions.map((a) => actionEvent(task, a, waiting.has(task.id), kinds))])
    .filter((e): e is ActivityEvent => !!e)
    .sort((a, b) => b.at - a.at);
}

// ---- the team ------------------------------------------------------------------------------------------------------

/** The team's state (`team.state`) for a shop the person owns, or null for a read with no team (the signed-in tenant, a
 *  shop they help at). Pause everyone holds every member the shop has on and their routines; the routines that would skip
 *  their runs are the ones switched on; the jobs running now are the ones that go on running, since the API's pause does
 *  not stop them (`holds: "routines"`). */
export function teamStateOf(s: ShopSnapshot): TeamState | null {
  if (!s.team) return null;
  return {
    paused: s.team.paused,
    since: s.team.since === null ? null : sec(s.team.since),
    members: [...s.team.members],
    routines: (s.routines ?? []).filter((r) => !r.paused).length,
    running: s.tasks.filter((task) => taskRunning(task, s.readAt)).map((task) => ({ id: task.id, title: titleOf(task), bot: memberOf(task), out: null })),
    holds: "routines",
  };
}
