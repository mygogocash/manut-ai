// How a read of a shop (shop.ts) shows through the app's protocol (src/lib/protocol.ts), so the existing screens show
// it without a screen of their own:
//
// - The team of a shop the person owns is Buddy, who leads, and the members the shop has on (`GET /v1/routines`' team,
//   in the roster's order: Nam, Pim, Ton). A member works while a job of theirs runs, and Pause everyone holds every
//   member but Buddy. The signed-in tenant and a shop the person helps at show Buddy alone, standing for the team.
// - Each task is one of Buddy's threads (History and Recent list them). Opening one shows Buddy's notes: what the
//   task is for, each action it asked for and how that settled, the draft a member wrote for the owner, and where the
//   task stands now. A task's member is the one whose run has it now (`memberOf`), as apps/api's jobs list reads it.
// - Each approval-core request still waiting is an ask in Buddy's chat, naming the exact action, so it reaches Needs
//   you and Home. Its id carries the revision shown (approvals.ts), and the runtime answers it through the decide route
//   (host.ts). One this build cannot answer is asked all the same, with no answer offered: update the app.
// - Inbound attention items are notes in Buddy's chat. They say what changed and where, never what it says.
// - Each schedule is an automation of Buddy's, and each of the team's routines an automation of its member's.
//
// Words a person reads come from the dictionaries. A state, an action or an event kind this app does not know is shown
// as the API wrote it rather than hidden.
import { isUnknown, mayDecide } from "@manut/approval-core";
import { t, type Key } from "../../i18n";
import type { Automation, Bot, EventOf, Msg, Routine } from "../../lib/protocol";
import type { ThreadOpenResult, ThreadRow } from "../../threads/types";
import { answerable, askId, choicesOf, detailOf, isAsk, shopAskId, type ShopApproval } from "./approvals";
import { ROSTER_ORDER, type Attention, type ShopAction, type ShopAttempt, type ShopPart, type ShopSchedule, type ShopSnapshot, type ShopTask, type TeamRoutine } from "./shop";

/** Buddy's profile name: the lead, whom the connected runtime always lists, and who stands for the team where the app
 *  is not told who else is on it. */
export const TEAM = "buddy";

/** States in which someone on the team is working on the task (not waiting on the owner, a service or its turn). */
const WORKING = new Set(["running", "verifying", "recovering"]);

/** The members the API's team can have, by the name each goes by and what each does, in the onboarding's own words
 *  (`@manut/member-grants`' roster past Buddy; apps/api workers.ts). A member this build does not know is listed by the
 *  API's own name for it, with no words. */
const MEMBERS: Readonly<Record<string, { name: string; role: Key }>> = {
  nam: { name: "Nam", role: "onb.team.sales" },
  pim: { name: "Pim", role: "onb.team.content" },
  ton: { name: "Ton", role: "onb.team.books" },
};

/** The name a member goes by. */
export const memberName = (bot: string): string => (bot === TEAM ? "Buddy" : (MEMBERS[bot]?.name ?? bot));

/** The member a task is: the one whose run has it now, the newest claimed (a job passed on is the member it went to, once
 *  they took it up), when that is one of the team; else Buddy, who leads the rest. */
export function memberOf(task: ShopTask): string {
  const executor = task.attempts.at(-1)?.executor ?? "";
  return (ROSTER_ORDER as readonly string[]).includes(executor) ? executor : TEAM;
}

/** Whether a run can still act at `nowMs`: the API's own reading (workers.ts `endingOf`), where an attempt still marked
 *  active whose deadline or report-by time has passed can no longer act, and the sweep will end it. */
export function attemptLive(a: ShopAttempt, nowMs: number): boolean {
  return a.status === "active" && (a.deadline === null || a.deadline > nowMs) && (a.leaseUntil === null || a.leaseUntil > nowMs);
}

/** Whether someone on the team is working on the task as of the read: its state says so, or its newest run can still act
 *  (a member's job keeps its task a draft while its run works). */
export function taskRunning(task: ShopTask, nowMs: number): boolean {
  const last = task.attempts.at(-1);
  return WORKING.has(task.state) || (!!last && attemptLive(last, nowMs));
}

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

export const titleOf = (task: ShopTask) => task.title || t("rt.untitled");

/** Whether `bot` is working as of the read: a task of theirs is. With no team to tell them apart, Buddy stands for every
 *  task. */
const working = (snapshot: ShopSnapshot, bot: string) =>
  snapshot.tasks.some((task) => (!snapshot.team || memberOf(task) === bot) && taskRunning(task, snapshot.readAt));

/** The tasks with a request still waiting for an answer. */
const asking = (snapshot: ShopSnapshot) => new Set(snapshot.approvals.filter(isAsk).map((a) => a.taskId));

/** The team: Buddy, online once the shop has been read and working while a task of his is; then, for a shop the person
 *  owns, each member the shop has on, in the roster's order, working while a job of theirs runs and held while Pause
 *  everyone is on. Buddy is never held: the lead keeps answering, so the owner can ask why. */
export function team(snapshot: ShopSnapshot | null): Bot[] {
  const bot = (name: string): Bot => ({
    name,
    display_name: memberName(name),
    is_default: name === TEAM,
    description: name === TEAM || !MEMBERS[name] ? "" : t(MEMBERS[name].role),
    status: snapshot ? "online" : "offline",
    running: snapshot ? working(snapshot, name) : false,
    model: "",
    provider: "",
    avatar_rev: null,
    ...(name !== TEAM && snapshot?.team?.paused ? { paused: true } : {}),
  });
  return [bot(TEAM), ...(snapshot?.team?.members.filter((m) => m !== TEAM) ?? []).map(bot)];
}

/** Whether the team lists `bot`: Buddy always, a member while the viewed shop has them on. */
export const onTeam = (snapshot: ShopSnapshot | null, bot: unknown): boolean => typeof bot === "string" && team(snapshot).some((b) => b.name === bot);

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
        running: taskRunning(task, snapshot.readAt),
        needs: needs.has(task.id),
        message_count: 2 + task.actions.length,
        preview: task.objective,
      };
    })
    .sort((a, b) => b.last - a.last);
}

/** A task as Buddy's notes, oldest first: what it is for, each action it asked for and how that settled, the draft a
 *  member wrote on it for the owner to read (the newest; it says nothing was sent, since nothing on this path sends), and
 *  where it stands now. Nothing here runs, so the thread never shows a turn in progress. */
export function taskOpen(task: ShopTask, readAt = Date.now()): ThreadOpenResult {
  const last = lastOf(task, readAt);
  const first = task.createdAt ?? last;
  const actions = [...task.actions].sort((a, b) => (a.proposedAt ?? last) - (b.proposedAt ?? last));
  const draft = task.draft;
  const messages: Msg[] = [
    { id: `${task.id}:task`, role: "assistant", text: t("rt.task", { title: titleOf(task), objective: task.objective }).trim(), ts: sec(first) },
    ...actions.map((a): Msg => ({
      id: `${task.id}:${a.id}`,
      role: "assistant",
      text: t("rt.taskAction", { action: actionText(a), state: actionStateText(a.state) }),
      ts: sec(a.proposedAt ?? last),
    })),
    ...(draft ? [{ id: `${task.id}:draft`, role: "assistant" as const, text: t("rt.taskDraft", { who: memberName(draft.member || memberOf(task)), text: draft.text }), ts: sec(draft.at ?? last) }] : []),
    { id: `${task.id}:now`, role: "assistant", text: t("rt.taskNow", { state: stateText(task.state) }), ts: sec(last) },
  ];
  return { thread: task.id, session_id: task.id, title: titleOf(task), cwd: "", messages, running: false, model: "", provider: "", reasoning: "" };
}

/** A browser write's operation (the API's `BROWSER_SUBMIT`, apps/api/src/browser-writes.ts). */
const BROWSER_SUBMIT = "browser.submit";

/** A browser write's own sentence, as its request carries it (`detail.text`), or null for any other request. The control
 *  plane writes it: the site, the page, the form and every value exactly as the outpost will type it, each value quoted as
 *  JSON. It is shown as it came, in every language, since no dictionary may change a selector or a value. */
function submitSentence(a: ShopApproval): string | null {
  const detail = detailOf(a.record.request);
  return detail.operationType === BROWSER_SUBMIT && detail.text !== undefined && detail.text.trim() !== "" ? detail.text : null;
}

/** Whether an ask must be read whole before it is approved: a browser write, whose sentence every surface shows with
 *  nothing cut or scrolled away (the card, Home, Needs you), and which a notification approves only shown whole. */
const wholeOf = (a: ShopApproval) => (submitSentence(a) === null ? {} : { whole: true });

/** The exact action a request asks for, in words: a browser write's sentence, or a reply's own words, as its request
 *  carries them; else the action of its task it decides, which carries a worker's words; else what the request names, as
 *  the API wrote it. */
export function askText(a: ShopApproval, task: ShopTask | undefined): string {
  const request = a.record.request;
  const detail = detailOf(request);
  const sentence = submitSentence(a);
  if (sentence !== null) return sentence;
  if (detail.operationType === "line.message.push" && detail.text !== undefined) return t("rt.op.linePush", { text: detail.text });
  const action = task?.actions.find((x) => x.id === (detail.actionId ?? request.id));
  if (action) return actionText(action);
  const op = detail.operationType || (isUnknown(request.kind) ? request.kind.raw : request.kind);
  return detail.targetResourceId ? t("rt.op.other", { op, target: detail.targetResourceId }) : op;
}

const byAsked = (a: ShopApproval, b: ShopApproval) =>
  a.record.request.createdAt - b.record.request.createdAt || (a.record.request.id < b.record.request.id ? -1 : a.record.request.id > b.record.request.id ? 1 : 0);

/** One shop's requests still waiting, as asks that name the shop (docs/several-shops.md, "One Needs you across the
 *  shops"). What each offers is the person's role there, as approval-core's `mayDecide` says: a request they may decide
 *  offers yes once and no; one they may not (a helper, and money, a public post, a payment or a command) offers none, and
 *  a helper may pass it on to the owner with a note instead, once. A shop session reads no tasks, so an ask says the
 *  exact action from its request alone. */
function shopAsks(part: ShopPart): EventOf<"approval.request">[] {
  const { shop } = part;
  return part.approvals.filter(isAsk).map((a) => {
    const request = answerable(a);
    const decides = !!request && mayDecide(shop.role, request.kind);
    const kind = a.record.request.kind;
    return {
      event: "approval.request",
      bot: TEAM,
      request_id: shopAskId(shop.id, a),
      title: "",
      command: askText(a, undefined),
      ...wholeOf(a),
      choices: decides ? choicesOf(a) : [],
      ...(request ? {} : { outdated: true }),
      kind: isUnknown(kind) ? kind.raw : kind,
      shop: { id: shop.id, name: shop.name, owner: shop.owner, role: shop.role },
      asked_at: sec(a.record.request.createdAt),
      ...(request && !decides && shop.role === "helper" && !a.passedOn ? { pass_on: true } : {}),
      ...(a.passedOn ? { passed_on: { name: a.passedOn.name, note: a.passedOn.note, ...(a.passedOn.at === null ? {} : { at: sec(a.passedOn.at) }) } } : {}),
    };
  });
}

/** Every request still waiting for an answer, oldest first, as the ask Needs you and Home show. The only answers are yes
 *  once and no: an exact action is approved for itself, never for a session or for always. One this build cannot answer
 *  offers neither and is marked `outdated`. With several shops, every shop's asks, each naming its shop. */
export function pendingAsks(snapshot: ShopSnapshot): EventOf<"approval.request">[] {
  if (snapshot.shops) {
    const asks = snapshot.shops.flatMap(shopAsks);
    return asks.sort((a, b) => (a.asked_at ?? 0) - (b.asked_at ?? 0) || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0));
  }
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
        ...wholeOf(a),
        choices,
        ...(choices.length ? {} : { outdated: true }),
        // a kind this build does not know is the text the API sent, and a notification offers no Approve for it
        kind: isUnknown(a.record.request.kind) ? a.record.request.kind.raw : a.record.request.kind,
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

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A team routine's timing as cron when the Schedule tab can say that shape in the app's language (every day, weekdays,
 *  one day a week, one day a month), else the API's own words for it ("On the last day of the month at 18:00"), which the
 *  tab shows as written. `@manut/routine-rules` counts Sunday as 0, as cron does. */
export function routineSchedule(r: TeamRoutine): string {
  const trigger = r.trigger as { kind?: unknown; at?: unknown; weekdays?: unknown; day?: unknown } | null;
  const time = typeof trigger?.at === "string" ? TIME.exec(trigger.at) : null;
  if (!trigger || !time) return r.when;
  const [h, m] = [Number(time[1]), Number(time[2])];
  if (trigger.kind === "daily") return `${m} ${h} * * *`;
  if (trigger.kind === "monthly" && Number.isInteger(trigger.day)) return `${m} ${h} ${trigger.day as number} * *`;
  if (trigger.kind === "weekly" && Array.isArray(trigger.weekdays)) {
    const days = [...new Set(trigger.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (days.length === 7) return `${m} ${h} * * *`;
    if (days.join(",") === "1,2,3,4,5") return `${m} ${h} * * 1-5`;
    if (days.length === 1) return `${m} ${h} * * ${days[0]}`;
  }
  return r.when;
}

function teamRoutineOf(r: TeamRoutine): Routine {
  return { id: r.id, name: r.name || t("rt.untitled"), schedule: routineSchedule(r), next_run_at: r.next === null ? null : sec(r.next), last_run_at: null, last_status: null, enabled: !r.paused };
}

/** A member's Schedule tab: Buddy's are the shop's schedules, and each member's are the team's routines that start their
 *  jobs. */
export function routineRows(snapshot: ShopSnapshot, bot: string = TEAM): Routine[] {
  if (bot === TEAM) return snapshot.schedules.map(routineOf);
  return (snapshot.routines ?? []).filter((r) => r.member === bot).map(teamRoutineOf);
}

const automation = (row: Routine, bot: string, prompt: string, createdAt: number | null): Automation => ({
  ...row,
  bot,
  paused: !row.enabled,
  prompt,
  script: null,
  deliver: "",
  origin: null,
  created_at: createdAt === null ? null : sec(createdAt),
  last_error: null,
  repeat: { times: null, completed: 0 },
});

/** The Automations page: every schedule, as Buddy's, and every routine of the team, as its member's; paused when it is
 *  switched off. A routine has no prompt of its own: its name says what it does. */
export function automationRows(snapshot: ShopSnapshot): Automation[] {
  return [
    ...snapshot.schedules.map((s) => automation(routineOf(s), TEAM, s.prompt, s.createdAt)),
    ...(snapshot.routines ?? []).map((r) => automation(teamRoutineOf(r), r.member, "", null)),
  ];
}
