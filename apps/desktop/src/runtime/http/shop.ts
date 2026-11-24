// One read of a shop from apps/api, for the connected runtime: its tasks with their exact actions, what waits for the
// owner, its schedules, and its inbound attention items. docs/runtime-adapter.md maps each to the screens.
//
// - Tasks come from the task list, `GET /v1/tasks`, newest first, a page at a time (`readTaskList`): the newest
//   `LISTED_TASKS` of them, each with its document, its exact actions, its runs, its newest draft and the entries of its
//   log the screens read. Before the list the runtime read every task with its whole log from `GET /v1/tenant/export` once
//   a minute, which grew without bound; it reads the export no more. The screens keep the tasks oldest first, as the
//   export listed them, so every list they sort shows ties as it did.
// - What waits for the owner comes from `GET /v1/approvals?state=open`: approval-core's own records, read with its own
//   decoders (approvals.ts). These, and nothing in the task list, are the asks: every one of them is decided through
//   approval-core, and an action no request decides is not the owner's to answer here.
// - Schedules come from `GET /v1/schedules`, attention items from `GET /v1/inbound/attention`. With the API's inbound
//   flag off, attention answers 403 `feature_disabled`, which reads as "no feed", not as a failure.
//
// A shop the person owns (docs/several-shops.md) is read with its own owner session: its tasks, its schedules and its
// attention items on those same routes, which the API answers an owner session on as the export carried them (the
// attention items whatever the inbound flag), and its team with its routines from `GET /v1/routines` (`decodeWork`). The
// team's routines run on clocks in the same schedule object, so a schedule that is one of those clocks (it names its
// `routineId`) is left out of the schedules: the routine says it.
//
// Decoding never throws. A record keeps the API's whole object in `raw`, so a field this app does not know yet is
// still there for a later slice; a state, an operation or an event kind it does not know is kept as written; and an
// entry it cannot read at all (no id) goes to `unreadable` instead of vanishing.
import type { ShopRow } from "../../lib/protocol";
import { decodeApprovals, type ShopApproval } from "./approvals";
import type { ApiSession, Answer } from "./session";

/** One member's run of a task (an attempt, apps/api task-object.ts), as the task's export keeps it. */
export interface ShopAttempt {
  id: string;
  /** who ran it, as the API names its executor: a member of the team (`nam`, `pim`, `ton`) for a worker's job */
  executor: string;
  /** `active` while it may still act, `done` once it ended whatever the outcome, as the API wrote it */
  status: string;
  /** how it ended: `done`, `failed`, `cancelled`, `awaiting_owner`, or "" when the API kept none */
  outcome: string;
  /** why it failed or was cancelled, as the API's code, or "" */
  reason: string;
  /** ms: when the task's log noted its claim, or null when the log no longer holds it */
  claimedAt: number | null;
  /** ms: when it ended, or null while it runs and for a record from before the API kept it */
  finishedAt: number | null;
  /** ms: the most it may run to, and when it must report again by; an active attempt past either can no longer act */
  deadline: number | null;
  leaseUntil: number | null;
  /** the member it passed its job to, by the newest handoff note it reported, or null */
  handedTo: string | null;
  /** what its model calls cost in whole satang, added over its spend reports; null when none said a cost */
  costSatang: number | null;
  /** the tokens its spend reports counted, or null when none did */
  tokens: number | null;
  /** the model its last spend report named, or "" */
  model: string;
}

/** What a member wrote on a task for the owner to read (a worker's draft): the newest, when there are several. */
export interface ShopDraft {
  member: string;
  /** what it is for, as the API's code: `reply`, `post`, `daily_summary`, or another kept as written */
  job: string;
  text: string;
  /** ms */
  at: number | null;
}

/** The shop's team as `GET /v1/routines` says it: whether Pause everyone holds it, since when, and who is on. */
export interface ShopTeam {
  paused: boolean;
  /** ms, when everyone was paused; null while nobody is */
  since: number | null;
  /** the members on, in the roster's order (`nam`, `pim`, `ton`), then any this build does not know, as written */
  members: string[];
}

/** One of the team's routines as `GET /v1/routines` says it, the timing in the API's words (`@manut/routine-rules`). */
export interface TeamRoutine {
  id: string;
  name: string;
  /** `brief`, `draft`, `reply`, `send`, `pay`, `delete`, or another kept as written */
  action: string;
  /** whose job each run starts */
  member: string;
  when: string;
  timeZone: string;
  /** null when the API did not say */
  asksFirst: boolean | null;
  paused: boolean;
  /** ms of its next run; null while it, the team or its member is off, or while it waits on an event */
  next: number | null;
  /** the trigger as the API sent it: a member's Schedule tab says a daily, weekly or monthly one in the app's language */
  trigger: unknown;
}

/** What an owner's session reads of a shop beyond what waits there (docs/several-shops.md): its tasks from the task list,
 *  its schedules and attention items, and its team and routines. */
export interface ShopWork {
  tasks: ShopTask[];
  schedules: ShopSchedule[];
  attention: Attention[];
  team: ShopTeam;
  routines: TeamRoutine[];
}

/** The members of the team in the order the app lists them (`@manut/member-grants`' roster, past Buddy, who leads). */
export const ROSTER_ORDER = ["nam", "pim", "ton"] as const;

export interface ShopAction {
  id: string;
  taskId: string;
  /** what would happen: `line.message.push`, `linear.issue.create`, or a kind this app does not know yet */
  operationType: string;
  targetResourceId: string;
  recipients: string[];
  payload: Record<string, unknown>;
  /** `proposed` waits for the owner; the others say how it settled */
  state: string;
  proposedAt: number | null;
  expiresAt: number | null;
  /** ms, when it was approved, and who approved it as the API names them (`owner-link`, `owner-session`, an owner account's
   *  `owner-…` id or a helper's id); null and "" before it was */
  approvedAt: number | null;
  approvedBy: string;
  /** ms, when it was handed to its provider to send, or null */
  dispatchedAt: number | null;
  raw: unknown;
}

export interface ShopTask {
  id: string;
  title: string;
  objective: string;
  /** the API's state name (`running`, `waitingForAuthorization`, …), kept as written */
  state: string;
  /** ms; when the task's log says it was created, if the log still holds that entry */
  createdAt: number | null;
  updatedAt: number | null;
  actions: ShopAction[];
  /** each member's run of it, in the order they were claimed; none for a task no member ran */
  attempts: ShopAttempt[];
  /** the newest draft a member wrote on it, or null */
  draft: ShopDraft | null;
  raw: unknown;
}

export interface ShopSchedule {
  id: string;
  name: string;
  prompt: string;
  hour: number | null;
  minute: number | null;
  /** 1 is Sunday and 7 is Saturday, as the API counts */
  weekdays: number[];
  timeZone: string;
  enabled: boolean;
  revision: number | null;
  /** ms of its next run, or null when it has none */
  nextFire: number | null;
  createdAt: number | null;
  raw: unknown;
}

export interface Attention {
  id: string;
  connectionId: string;
  /** `linear.issue.update` and the like: the item says something changed and where, never what it says */
  eventType: string;
  issueId: string;
  receivedAt: number | null;
  raw: unknown;
}

/** One of the person's shops in a read (docs/several-shops.md): who it is, the role the person acts as there (the one its
 *  session holds, which is what the API decides with), and what waits there, read with that shop's own session. */
export interface ShopPart {
  shop: ShopRow;
  approvals: ShopApproval[];
  /** what the person's owner session reads there beyond the asks; absent for a shop they help at, which shows its asks
   *  only (what a helper sees is the owner's call) */
  work?: ShopWork;
}

export interface ShopSnapshot {
  tasks: ShopTask[];
  /** approval-core's requests still waiting for an answer, as the API listed them */
  approvals: ShopApproval[];
  schedules: ShopSchedule[];
  attention: Attention[];
  /** the API's inbound flag is off, so it keeps no attention items */
  attentionOff: boolean;
  /** entries the API sent that this app could not read, kept as they came */
  unreadable: unknown[];
  /** ms, when this read finished */
  readAt: number;
  /** Several shops: every shop the person is in, the ones they own first, each with what waits there. Absent when they are
   *  in none: the read is then the signed-in tenant's own, as it was before shops. */
  shops?: ShopPart[];
  /** The shop being viewed, one of `shops`: `approvals` are its own, and so are the tasks, schedules and attention items
   *  when the person owns it (its `work`). A shop they help at shows its asks only, so those are empty. */
  viewing?: string;
  /** The viewed shop's team and routines, when the person owns it; absent for the signed-in tenant and a helper's shop,
   *  whose team the app shows as Buddy alone. */
  team?: ShopTeam;
  routines?: TeamRoutine[];
}

export type ReadFailure = "signed_out" | "offline" | "unavailable";
export type ShopRead = { ok: true; snapshot: ShopSnapshot } | { ok: false; failure: ReadFailure };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const id = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ms = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const int = (v: unknown, lo: number, hi: number): number | null => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);

function decodeAction(v: unknown, taskId: string, unreadable: unknown[]): ShopAction | null {
  const actionId = isObj(v) ? id(v.id) : null;
  if (!isObj(v) || !actionId) {
    unreadable.push(v);
    return null;
  }
  return {
    id: actionId,
    taskId,
    operationType: str(v.operationType),
    targetResourceId: str(v.targetResourceId),
    recipients: list(v.recipients).filter((r): r is string => typeof r === "string"),
    payload: isObj(v.payload) ? v.payload : {},
    state: str(v.state),
    proposedAt: ms(v.proposedAt),
    expiresAt: ms(v.expiresAt),
    approvedAt: isObj(v.approval) ? ms(v.approval.at) : null,
    approvedBy: isObj(v.approval) ? str(v.approval.by) : "",
    dispatchedAt: isObj(v.dispatch) ? ms(v.dispatch.at) : null,
    raw: v,
  };
}

/** Epoch seconds as ms, as an attempt's times are kept; null for anything else. */
const secMs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v * 1000 : null);
/** Whole satang, never a float: anything else is no cost at all. */
const satang = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** A task's attempts, in the order the task's log noted their claims (an attempt is kept by a random id, so its claim is
 *  the only order there is), each with what it reported: the newest handoff note it wrote and its spend reports. This is
 *  how apps/api's own jobs list reads a job (workers.ts `jobOf`). An attempt with no id is kept in `unreadable`. */
function decodeAttempts(v: Obj, events: unknown[], unreadable: unknown[]): ShopAttempt[] {
  const claims = new Map<string, { seq: number; at: number | null }>();
  for (const e of events) {
    const claimed = isObj(e) ? /^attempt:claim:(.+)$/.exec(str(e.via))?.[1] : undefined;
    if (isObj(e) && claimed) claims.set(claimed, { seq: typeof e.seq === "number" ? e.seq : Number.MAX_SAFE_INTEGER, at: ms(e.at) });
  }
  const reports = (attemptId: string) => events.filter((e): e is Obj => isObj(e) && e.kind === "agent" && e.attemptId === attemptId && isObj(e.event));
  const attempts: (ShopAttempt & { seq: number })[] = [];
  for (const a of list(v.attempts)) {
    const attemptId = isObj(a) ? id(a.id) : null;
    if (!isObj(a) || !attemptId) {
      unreadable.push(a);
      continue;
    }
    let handedTo: string | null = null;
    let costSatang: number | null = null;
    let tokens: number | null = null;
    let model = "";
    for (const r of reports(attemptId)) {
      const event = r.event as Obj;
      if (event.type === "handoffNote" && id(event.to)) handedTo = event.to as string;
      if (event.type !== "spend") continue;
      const cost = satang(event.costSatang);
      if (cost !== null) costSatang = (costSatang ?? 0) + cost;
      const used = satang(event.tokens);
      if (used !== null) tokens = (tokens ?? 0) + used;
      if (id(event.model)) model = event.model as string;
    }
    const claim = claims.get(attemptId);
    attempts.push({
      id: attemptId,
      executor: str(a.executorId),
      status: str(a.status),
      outcome: str(a.outcome),
      reason: str(a.reason),
      claimedAt: claim?.at ?? null,
      finishedAt: secMs(a.finishedAt),
      deadline: secMs(a.deadline),
      leaseUntil: secMs(a.leaseUntil),
      handedTo,
      costSatang,
      tokens,
      model,
      seq: claim?.seq ?? Number.MAX_SAFE_INTEGER,
    });
  }
  return attempts.sort((x, y) => x.seq - y.seq || (x.deadline ?? 0) - (y.deadline ?? 0)).map(({ seq: _seq, ...attempt }) => attempt);
}

/** The newest draft a member wrote on the task, or null. A draft with no words is none. */
function decodeDraft(v: Obj): ShopDraft | null {
  const drafts = list(v.drafts)
    .filter((d): d is Obj => isObj(d) && typeof d.text === "string" && d.text.trim() !== "")
    .map((d) => ({ member: str(d.member), job: str(d.job), text: d.text as string, at: ms(d.at) }));
  return drafts.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).at(-1) ?? null;
}

/** One task as the task list gives it (`{ task, events, actions, attempts, drafts, … }`: the shape of an export entry, with
 *  the entries of the log the screens read and its newest draft), as a task. */
function decodeTask(v: unknown, unreadable: unknown[]): ShopTask | null {
  const doc = isObj(v) && isObj(v.task) ? v.task : null;
  const taskId = doc ? id(doc.id) : null;
  if (!isObj(v) || !doc || !taskId) {
    unreadable.push(v);
    return null;
  }
  const events = list(v.events);
  const created = events.find((e) => isObj(e) && e.kind === "created");
  return {
    id: taskId,
    title: str(doc.title),
    objective: str(doc.objective),
    state: str(doc.state),
    createdAt: isObj(created) ? ms(created.at) : null,
    updatedAt: ms(doc.updatedAt),
    actions: list(v.actions)
      .map((a) => decodeAction(a, taskId, unreadable))
      .filter((a): a is ShopAction => !!a),
    attempts: decodeAttempts(v, events, unreadable),
    draft: decodeDraft(v),
    raw: v,
  };
}

/** The members on, in the roster's order, then any this build does not know, as the API wrote them. */
function membersOf(v: unknown): string[] {
  const named = [...new Set(list(v).filter((m): m is string => typeof m === "string" && m.length > 0))];
  return [...ROSTER_ORDER.filter((m) => named.includes(m)), ...named.filter((m) => !(ROSTER_ORDER as readonly string[]).includes(m))];
}

/** `GET /v1/routines`' team, or null when the answer has none this build can read: a team it cannot read is never shown
 *  as one that is at work. */
export function decodeTeam(json: unknown): ShopTeam | null {
  const team = isObj(json) && isObj(json.team) ? json.team : null;
  if (!team || typeof team.paused !== "boolean") return null;
  return { paused: team.paused, since: team.paused ? ms(team.since) : null, members: membersOf(team.members) };
}

/** `GET /v1/routines`' routines, in the order the API listed them (the order they were made). One with no id is kept in
 *  `unreadable`. */
export function decodeTeamRoutines(json: unknown, unreadable: unknown[]): TeamRoutine[] {
  const routines: TeamRoutine[] = [];
  for (const v of list(isObj(json) ? json.routines : null)) {
    const routineId = isObj(v) ? id(v.id) : null;
    if (!isObj(v) || !routineId) {
      unreadable.push(v);
      continue;
    }
    routines.push({
      id: routineId,
      name: str(v.name),
      action: str(v.action),
      member: str(v.member),
      when: str(v.when),
      timeZone: str(v.timeZone),
      asksFirst: typeof v.asksFirst === "boolean" ? v.asksFirst : null,
      paused: v.paused === true,
      next: ms(v.next),
      trigger: isObj(v.trigger) ? v.trigger : null,
    });
  }
  return routines;
}

/** A schedule that is one of the team's routine clocks: the API's routine setup writes `routineId` on it. */
const isRoutineClock = (v: unknown) => isObj(v) && id(v.routineId) !== null;

/** What an owner's session read of a shop beyond its asks: its tasks from the task list (`readTaskList`), its schedules
 *  (`GET /v1/schedules`, `{ schedules }`) and attention items (`GET /v1/inbound/attention`, `{ items }`), and the team and
 *  routines of `GET /v1/routines`. Null when the routines' answer holds no team this build can read. A routine's clock is
 *  left out of the schedules, since the routine itself is listed. */
export function decodeWork(read: { tasks: readonly unknown[]; schedules: unknown; attention: unknown; routines: unknown }, unreadable: unknown[]): ShopWork | null {
  const team = decodeTeam(read.routines);
  if (!team) return null;
  return {
    tasks: decodeTasks(read.tasks, unreadable),
    schedules: list(isObj(read.schedules) ? read.schedules.schedules : null)
      .filter((v) => !isRoutineClock(v))
      .map((v) => decodeSchedule(v, unreadable))
      .filter((x): x is ShopSchedule => !!x),
    attention: list(isObj(read.attention) ? read.attention.items : null)
      .map((v) => decodeAttention(v, unreadable))
      .filter((x): x is Attention => !!x),
    team,
    routines: decodeTeamRoutines(read.routines, unreadable),
  };
}

/** The task list's entries, newest first as it gives them, as tasks oldest first: the order the export listed them in, so
 *  every screen that sorts them shows ties as it did. */
function decodeTasks(entries: readonly unknown[], unreadable: unknown[]): ShopTask[] {
  return [...entries]
    .reverse()
    .map((v) => decodeTask(v, unreadable))
    .filter((x): x is ShopTask => !!x);
}

/** The task list's path, and how many tasks a page of it holds: the most the API gives in one (apps/api task-list.ts). */
export const TASK_LIST = "/v1/tasks";
export const TASK_PAGE = 25;
/** The tasks the screens show: the newest this many of the shop's, read as two pages of the list each time the shop is
 *  read. A shop with more shows its newest; reading older ones when a screen asks for them is a later slice
 *  (docs/runtime-adapter.md, "Next slices"). Two pages keep a read's calls to the API, and the API's to the tasks, the same
 *  however many tasks the shop has kept. */
export const LISTED_TASKS = 50;

/** What reading the task list came to: its entries, newest first, or the first answer that was not a page. */
export type TaskListRead<A> = { kind: "ok"; tasks: unknown[] } | Exclude<A, { kind: "ok" }>;

/** Reads the newest `LISTED_TASKS` of the tenant's tasks from the task list, a page at a time with the cursor each page
 *  gives (the list stays stable while tasks are made, so no task is read twice or skipped), with `read`, which carries the
 *  session the tenant is read with. Any page that is not one ends the read with its answer: half a list is never shown as
 *  the whole one. */
export async function readTaskList<A extends { kind: string }>(read: (path: string) => Promise<A>): Promise<TaskListRead<A>> {
  const tasks: unknown[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < LISTED_TASKS / TASK_PAGE; pages++) {
    const answer = await read(`${TASK_LIST}?limit=${TASK_PAGE}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    if (answer.kind !== "ok") return answer as Exclude<A, { kind: "ok" }>;
    const page = (answer as unknown as { json: unknown }).json;
    tasks.push(...list(isObj(page) ? page.tasks : null));
    cursor = isObj(page) && typeof page.next === "string" && page.next !== "" ? page.next : null;
    if (cursor === null) break;
  }
  return { kind: "ok", tasks };
}

function decodeSchedule(v: unknown, unreadable: unknown[]): ShopSchedule | null {
  const scheduleId = isObj(v) ? id(v.id) : null;
  if (!isObj(v) || !scheduleId) {
    unreadable.push(v);
    return null;
  }
  return {
    id: scheduleId,
    name: str(v.name),
    prompt: str(v.prompt),
    hour: int(v.hour, 0, 23),
    minute: int(v.minute, 0, 59),
    weekdays: list(v.weekdays).filter((d): d is number => int(d, 1, 7) !== null),
    timeZone: str(v.timeZone),
    enabled: v.enabled === true,
    revision: int(v.revision, 0, Number.MAX_SAFE_INTEGER),
    nextFire: ms(v.nextFire),
    createdAt: ms(v.createdAt),
    raw: v,
  };
}

function decodeAttention(v: unknown, unreadable: unknown[]): Attention | null {
  const itemId = isObj(v) ? id(v.id) : null;
  if (!isObj(v) || !itemId) {
    unreadable.push(v);
    return null;
  }
  return { id: itemId, connectionId: str(v.connectionId), eventType: str(v.eventType), issueId: str(v.issueId), receivedAt: ms(v.receivedAt), raw: v };
}

/** An answer's JSON, or the reason the read failed. `allow` names refusals that mean "nothing here", not failure. */
function bodyOf(a: Answer, allow: (status: number, code: string) => boolean): { json: unknown; allowed?: boolean } | ReadFailure {
  if (a.kind === "ok") return { json: a.json };
  if (a.kind === "refused") return allow(a.status, a.code) ? { json: null, allowed: true } : "unavailable";
  return a.kind;
}

/** Reads the shop once. Any part that fails fails the whole read, with the worst reason: signed out, then offline,
 *  then unavailable. Half a shop is never shown as the whole one. */
export async function readShop(session: ApiSession, now: () => number = Date.now): Promise<ShopRead> {
  const [listed, asked, scheduled, attended] = await Promise.all([
    readTaskList((path) => session.read(path)),
    session.read("/v1/approvals?state=open"),
    session.read("/v1/schedules"),
    session.read("/v1/inbound/attention"),
  ]);
  // A deleted tenant's list answers 404 tenant_deleted, as its export did: it has no tasks.
  const tasksBody = bodyOf(listed.kind === "ok" ? { kind: "ok", status: 200, json: { tasks: listed.tasks } } : listed, (status, code) => status === 404 && code === "tenant_deleted");
  // Nothing that waits for the owner is ever read as "nothing waits": the API answers 503 rather than leave one out.
  const approvalsBody = bodyOf(asked, () => false);
  const schedulesBody = bodyOf(scheduled, () => false);
  const attentionBody = bodyOf(attended, (status, code) => status === 403 && code === "feature_disabled");
  const failures = [tasksBody, approvalsBody, schedulesBody, attentionBody].filter((b): b is ReadFailure => typeof b === "string");
  for (const worst of ["signed_out", "offline", "unavailable"] as const) if (failures.includes(worst)) return { ok: false, failure: worst };
  const [t, p, s, a] = [tasksBody, approvalsBody, schedulesBody, attentionBody] as { json: unknown; allowed?: boolean }[];
  const unreadable: unknown[] = [];
  const tasks = decodeTasks(list(isObj(t.json) ? t.json.tasks : null), unreadable);
  const schedules = list(isObj(s.json) ? s.json.schedules : null)
    .map((v) => decodeSchedule(v, unreadable))
    .filter((x): x is ShopSchedule => !!x);
  const attention = list(isObj(a.json) ? a.json.items : null)
    .map((v) => decodeAttention(v, unreadable))
    .filter((x): x is Attention => !!x);
  const approvals = decodeApprovals(p.json, unreadable);
  return { ok: true, snapshot: { tasks, approvals, schedules, attention, attentionOff: a.allowed === true, unreadable, readAt: now() } };
}
