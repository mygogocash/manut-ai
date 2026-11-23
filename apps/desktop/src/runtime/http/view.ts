// How a read of a shop (shop.ts) shows through the app's protocol (src/lib/protocol.ts), so the existing screens show
// it without a screen of their own:
//
// - The team is Buddy alone. The API has no team members yet; Buddy stands for the shop's whole team, as the product
//   does, and works while any task is being worked on.
// - Each task is one of Buddy's threads (History and Recent list them). Opening one shows Buddy's notes: what the
//   task is for, each action it asked for and how that settled, and where the task stands now.
// - Each approval-core request still waiting is an ask in Buddy's chat, naming the exact action, so it reaches Needs
//   you and Home. Its id carries the revision shown (approvals.ts), and the runtime answers it through the decide route
//   (host.ts). One this build cannot answer is asked all the same, with no answer offered: update the app.
// - Inbound attention items are notes in Buddy's chat. They say what changed and where, never what it says.
// - Each schedule is an automation of Buddy's.
//
// Words a person reads come from the dictionaries. A state, an action or an event kind this app does not know is shown
// as the API wrote it rather than hidden.
import { isUnknown } from "@manut/approval-core";
import { t, type Key } from "../../i18n";
import type { Automation, Bot, EventOf, Msg, Routine } from "../../lib/protocol";
import type { ThreadOpenResult, ThreadRow } from "../../threads/types";
import { askId, choicesOf, detailOf, isAsk, type ShopApproval } from "./approvals";
import type { Attention, ShopAction, ShopSchedule, ShopSnapshot, ShopTask } from "./shop";

/** Buddy's profile name: the one member the connected runtime lists. */
export const TEAM = "buddy";

/** States in which someone on the team is working on the task (not waiting on the owner, a service or its turn). */
const WORKING = new Set(["running", "verifying", "recovering"]);

const TASK_STATES = new Set([
  "draft",
  "queued",
  "running",
  "verifying",
  "waitingForInput",
  "waitingForAuthorization",
  "waitingForProvider",
  "paused",
  "recovering",
  "failed",
  "completed",
  "cancelled",
]);
const ACTION_STATES = new Set(["proposed", "approved", "rejected", "expired", "dispatching", "confirmed", "failed", "unknown"]);

const sec = (ms: number) => ms / 1000;

/** A task's state in words; one this app does not know stays as the API wrote it. */
export function stateText(state: string): string {
  return TASK_STATES.has(state) ? t(`rt.state.${state}` as Key) : state;
}

/** How an action settled, in words; an unknown state stays as written. */
export function actionStateText(state: string): string {
  return ACTION_STATES.has(state) ? t(`rt.act.${state}` as Key) : state;
}

/** The exact action, as the owner approves it: what goes where, with the words that would be sent. */
export function actionText(a: ShopAction): string {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (a.operationType === "line.message.push") return t("rt.op.linePush", { text: text(a.payload.text) });
  if (a.operationType === "linear.issue.create") return t("rt.op.linearIssue", { title: text(a.payload.title) });
  return t("rt.op.other", { op: a.operationType, target: a.targetResourceId });
}

function attentionText(item: Attention): string {
  const kind = /^linear\.issue\.(create|update|remove)$/.exec(item.eventType)?.[1];
  return kind ? t(`rt.att.${kind}` as Key, { issue: item.issueId }) : t("rt.att.other", { event: item.eventType, issue: item.issueId });
}

const titleOf = (task: ShopTask) => task.title || t("rt.untitled");
const working = (snapshot: ShopSnapshot) => snapshot.tasks.some((task) => WORKING.has(task.state));

/** The tasks with a request still waiting for an answer. */
const asking = (snapshot: ShopSnapshot) => new Set(snapshot.approvals.filter(isAsk).map((a) => a.taskId));

/** The team: Buddy, online once the shop has been read, working while any task is. */
export function team(snapshot: ShopSnapshot | null): Bot[] {
  return [
    {
      name: TEAM,
      display_name: "Buddy",
      is_default: true,
      description: "",
      status: snapshot ? "online" : "offline",
      running: snapshot ? working(snapshot) : false,
      model: "",
      provider: "",
      avatar_rev: null,
    },
  ];
}

/** When a task was last touched: its document, or the newest of its actions when one is newer. */
function lastOf(task: ShopTask, fallback: number): number {
  return Math.max(task.updatedAt ?? 0, task.createdAt ?? 0, ...task.actions.map((a) => a.proposedAt ?? 0)) || fallback;
}

/** Every task as one of Buddy's threads, newest activity first; `needs` marks one with a request waiting for an answer. */
export function threadRows(snapshot: ShopSnapshot): ThreadRow[] {
  const needs = asking(snapshot);
  return snapshot.tasks
    .map((task) => {
      const last = lastOf(task, snapshot.readAt);
      return {
        thread: task.id,
        title: titleOf(task),
        cwd: "",
        started_at: sec(task.createdAt ?? last),
        last: sec(last),
        running: WORKING.has(task.state),
        needs: needs.has(task.id),
        message_count: 2 + task.actions.length,
        preview: task.objective,
      };
    })
    .sort((a, b) => b.last - a.last);
}

/** A task as Buddy's notes, oldest first: what it is for, each action it asked for and how that settled, and where it
 *  stands now. Nothing here runs, so the thread never shows a turn in progress. */
export function taskOpen(task: ShopTask, readAt = Date.now()): ThreadOpenResult {
  const last = lastOf(task, readAt);
  const first = task.createdAt ?? last;
  const actions = [...task.actions].sort((a, b) => (a.proposedAt ?? last) - (b.proposedAt ?? last));
  const messages: Msg[] = [
    { id: `${task.id}:task`, role: "assistant", text: t("rt.task", { title: titleOf(task), objective: task.objective }).trim(), ts: sec(first) },
    ...actions.map((a): Msg => ({
      id: `${task.id}:${a.id}`,
      role: "assistant",
      text: t("rt.taskAction", { action: actionText(a), state: actionStateText(a.state) }),
      ts: sec(a.proposedAt ?? last),
    })),
    { id: `${task.id}:now`, role: "assistant", text: t("rt.taskNow", { state: stateText(task.state) }), ts: sec(last) },
  ];
  return { thread: task.id, session_id: task.id, title: titleOf(task), cwd: "", messages, running: false, model: "", provider: "", reasoning: "" };
}

/** The exact action a request asks for, in words: a reply's own words, as its request carries them; else the action of
 *  its task it decides, which carries a worker's words; else what the request names, as the API wrote it. */
export function askText(a: ShopApproval, task: ShopTask | undefined): string {
  const request = a.record.request;
  const detail = detailOf(request);
  if (detail.operationType === "line.message.push" && detail.text !== undefined) return t("rt.op.linePush", { text: detail.text });
  const action = task?.actions.find((x) => x.id === (detail.actionId ?? request.id));
  if (action) return actionText(action);
  const op = detail.operationType || (isUnknown(request.kind) ? request.kind.raw : request.kind);
  return detail.targetResourceId ? t("rt.op.other", { op, target: detail.targetResourceId }) : op;
}

const byAsked = (a: ShopApproval, b: ShopApproval) =>
  a.record.request.createdAt - b.record.request.createdAt || (a.record.request.id < b.record.request.id ? -1 : a.record.request.id > b.record.request.id ? 1 : 0);

/** Every request still waiting for an answer, oldest first, as the ask Needs you and Home show. The only answers are yes
 *  once and no: an exact action is approved for itself, never for a session or for always. One this build cannot answer
 *  offers neither and is marked `outdated`. */
export function pendingAsks(snapshot: ShopSnapshot): EventOf<"approval.request">[] {
  return snapshot.approvals
    .filter(isAsk)
    .sort(byAsked)
    .map((a) => {
      const task = snapshot.tasks.find((x) => x.id === a.taskId);
      const choices = choicesOf(a);
      return {
        event: "approval.request",
        bot: TEAM,
        request_id: askId(a),
        title: task ? titleOf(task) : "",
        command: askText(a, task),
        choices,
        ...(choices.length ? {} : { outdated: true }),
      };
    });
}

/** The inbound attention items as notes in Buddy's chat, oldest first. */
export function attentionRows(snapshot: ShopSnapshot): Msg[] {
  return snapshot.attention
    .map((item): Msg => ({ id: `attention:${item.id}`, role: "assistant", text: attentionText(item), ts: sec(item.receivedAt ?? snapshot.readAt) }))
    .sort((a, b) => a.ts - b.ts);
}

/** A schedule's days and time as cron (`30 8 * * 1-5`), the shape the Automations page puts into words. The API counts
 *  Sunday as 1 and cron as 0. "" when the schedule has no usable time. The time is in the schedule's own time zone;
 *  the next run, given apart in seconds, is exact. */
export function cronOf(s: ShopSchedule): string {
  if (s.hour === null || s.minute === null || s.weekdays.length === 0) return "";
  const days = [...new Set(s.weekdays.map((d) => d - 1))].sort((a, b) => a - b);
  const dow = days.length === 7 ? "*" : days.join(",") === "1,2,3,4,5" ? "1-5" : days.join(",");
  return `${s.minute} ${s.hour} * * ${dow}`;
}

function routineOf(s: ShopSchedule): Routine {
  return { id: s.id, name: s.name, schedule: cronOf(s), next_run_at: s.nextFire === null ? null : sec(s.nextFire), last_run_at: null, last_status: null, enabled: s.enabled };
}

/** A member's Schedule tab: every schedule is Buddy's. */
export function routineRows(snapshot: ShopSnapshot): Routine[] {
  return snapshot.schedules.map(routineOf);
}

/** The Automations page: every schedule, paused when it is switched off. */
export function automationRows(snapshot: ShopSnapshot): Automation[] {
  return snapshot.schedules.map((s) => ({
    ...routineOf(s),
    bot: TEAM,
    paused: !s.enabled,
    prompt: s.prompt,
    script: null,
    deliver: "",
    origin: null,
    created_at: s.createdAt === null ? null : sec(s.createdAt),
    last_error: null,
    repeat: { times: null, completed: 0 },
  }));
}
