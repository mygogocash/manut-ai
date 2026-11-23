// One read of a shop from apps/api, for the connected runtime: its tasks with their exact actions, what waits for the
// owner, its schedules, and its inbound attention items. docs/runtime-adapter.md maps each to the screens.
//
// - Tasks come from `GET /v1/tenant/export`, the only route a session can use today that lists its own tasks (each with
//   its event log and its action proposals). It is heavy, so the runtime reads it at most once a minute; a task list
//   route is the first thing the note asks the API for.
// - What waits for the owner comes from `GET /v1/approvals?state=open`: approval-core's own records, read with its own
//   decoders (approvals.ts). These, and nothing in the export, are the asks: every one of them is decided through
//   approval-core, and an action no request decides is not the owner's to answer here.
// - Schedules come from `GET /v1/schedules`, attention items from `GET /v1/inbound/attention`. With the API's inbound
//   flag off, attention answers 403 `feature_disabled`, which reads as "no feed", not as a failure.
//
// Decoding never throws. A record keeps the API's whole object in `raw`, so a field this app does not know yet is
// still there for a later slice; a state, an operation or an event kind it does not know is kept as written; and an
// entry it cannot read at all (no id) goes to `unreadable` instead of vanishing.
import { decodeApprovals, type ShopApproval } from "./approvals";
import type { ApiSession, Answer } from "./session";

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
  /** how many entries its event log holds */
  events: number;
  actions: ShopAction[];
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
    raw: v,
  };
}

/** One export entry (`{ task, events, actions, attempts, … }`) as a task. */
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
    events: events.length,
    actions: list(v.actions)
      .map((a) => decodeAction(a, taskId, unreadable))
      .filter((a): a is ShopAction => !!a),
    raw: v,
  };
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
  const [exported, asked, scheduled, attended] = await Promise.all([
    session.read("/v1/tenant/export"),
    session.read("/v1/approvals?state=open"),
    session.read("/v1/schedules"),
    session.read("/v1/inbound/attention"),
  ]);
  // A deleted tenant's export answers 404 tenant_deleted: it has no tasks.
  const tasksBody = bodyOf(exported, (status, code) => status === 404 && code === "tenant_deleted");
  // Nothing that waits for the owner is ever read as "nothing waits": the API answers 503 rather than leave one out.
  const approvalsBody = bodyOf(asked, () => false);
  const schedulesBody = bodyOf(scheduled, () => false);
  const attentionBody = bodyOf(attended, (status, code) => status === 403 && code === "feature_disabled");
  const failures = [tasksBody, approvalsBody, schedulesBody, attentionBody].filter((b): b is ReadFailure => typeof b === "string");
  for (const worst of ["signed_out", "offline", "unavailable"] as const) if (failures.includes(worst)) return { ok: false, failure: worst };
  const [t, p, s, a] = [tasksBody, approvalsBody, schedulesBody, attentionBody] as { json: unknown; allowed?: boolean }[];
  const unreadable: unknown[] = [];
  const tasks = list(isObj(t.json) ? t.json.tasks : null)
    .map((v) => decodeTask(v, unreadable))
    .filter((x): x is ShopTask => !!x);
  const schedules = list(isObj(s.json) ? s.json.schedules : null)
    .map((v) => decodeSchedule(v, unreadable))
    .filter((x): x is ShopSchedule => !!x);
  const attention = list(isObj(a.json) ? a.json.items : null)
    .map((v) => decodeAttention(v, unreadable))
    .filter((x): x is Attention => !!x);
  const approvals = decodeApprovals(p.json, unreadable);
  return { ok: true, snapshot: { tasks, approvals, schedules, attention, attentionOff: a.allowed === true, unreadable, readAt: now() } };
}
