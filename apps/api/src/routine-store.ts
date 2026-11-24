/// The team's routines and setup for one shop, kept in that shop's TenantObject (`t:${tenant}`) beside its other
/// records, so tenant export reads them and tenant deletion wipes them. The Worker's side (the routes, the runner and
/// the clocks) is routines.ts; the rules of a routine are `@manut/routine-rules`'.
///
/// One record per shop, `routines:${tenant}`, holds the setup: whether the team is paused and which members are on,
/// the routines in the order they were made, and the questions a shop template gave Buddy to ask the owner in the first
/// week. They share one record because applying a template writes all three, and one write is all or nothing. Each
/// run of a routine is a record of its own, `routine-run:${tenant}:${routineId}:${instant}`, so the history of a busy
/// routine never grows the setup; the newest 30 of each routine are kept.
///
/// One run per intended instant. A clock (the schedule object, schedule-object.ts) claims a run here before anything
/// starts, and the claim is keyed by the routine and the instant it was meant for, never by the clock's own revision or
/// the time the alarm arrived. The claim reads the routine, the team and the earlier runs and writes the run in one
/// synchronous transaction, so two alarms for the same instant, or a clock saved again, can never both start a job.
/// The claim also decides what a run that will not start says: `skipped` while the routine or the team is paused or the
/// member is not on the team, or when a switch or the owner's consent refused it, and `missed` when its alarm came past
/// the grace. Each such run is written down with its audit entry in the same transaction.
///
/// What is never stored in the log. Every audit entry names a routine, a template, a question or a fact by its id; a
/// routine's name, a question and an answer stay in their records (audit-log.ts). An answer's words are not even kept
/// here: they are the owner's fact in what the team knows (memory-store.ts), and a question keeps only that fact's id,
/// so the owner's Forget removes the words everywhere.
///
/// Only the Worker reaches these paths, and writes also need its `x-routines` header, the same defence in depth as
/// `x-memory` and `x-pilot`.

import { checkRoutine, type ActionKind, type Trigger } from "@manut/routine-rules";
import type { Fact } from "@manut/shop-memory";
import { actorOr, auditPutSync, type AuditActor, type AuditRecord } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { rememberWithin } from "./memory-store";
import type { WorkerMember } from "./workers";

const MAX_BODY_BYTES = 64 * 1024;
/// The most routines a shop keeps. Far above what a small shop schedules, and it keeps the one record small.
export const MAX_ROUTINES = 50;
/// Runs kept per routine. The list shows the newest; the audit log keeps every run's outcome for longer.
const RUNS_KEPT = 30;
const MEMBERS: readonly WorkerMember[] = ["nam", "pim", "ton"];
/// Ids this backend mints for routines (`rt-` and a sortable id): no colon, so one routine's run keys never share a
/// prefix with another's.
export const ROUTINE_ID = /^rt-[0-9a-z-]{1,64}$/;
/// A template's id or a question's: lower-case letters and digits, as the shop-templates package and this file make them.
const SHORT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
/// A run's reason: a code, never words.
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SYSTEM: AuditActor = { kind: "system" };

export type StoredRoutine = {
  id: string;
  name: string;
  action: ActionKind;
  timeZone: string;
  trigger: Trigger;
  asksFirst: boolean;
  /// The worker whose job each run starts (routines.ts, `jobFor`).
  member: WorkerMember;
  /// Off: its runs are skipped and say so. A template's routines start this way.
  paused: boolean;
  createdAt: string;
  /// The shop template it came from, when it did.
  template?: string;
};

export type Team = {
  paused: boolean;
  /// When everyone was paused; null while nobody is.
  since: string | null;
  /// The members a shop template turned on; null for a shop with no template, where every worker is on.
  members: WorkerMember[] | null;
};

export type Question = {
  id: string;
  text: string;
  /// The owner's fact the answer became, once answered. The answer's words live only in that fact.
  factId?: string;
  answeredAt?: string;
};

export type RoutineState = { team: Team; routines: StoredRoutine[]; questions: Question[] };

export type RunStatus = "running" | "done" | "failed" | "skipped" | "missed";

export type RoutineRun = {
  routineId: string;
  /// The instant the run was meant for.
  instant: string;
  /// `running` from the claim until the job ends; then how it ended.
  status: RunStatus;
  /// Why, as a code: `routine_paused`, `team_paused`, `member_off`, `consent_required`, `nothing_to_answer`, or the
  /// job's own reason for failing.
  reason?: string;
  member: WorkerMember;
  /// The job's task, for a run that started one.
  taskId?: string;
  /// When the run was last written.
  at: string;
};

/// What the claim answers the clock: the routine is gone (the clock can drop it), the instant was already claimed, the
/// run was written down as skipped or missed, or the caller holds the run and starts its job. `since` is the instant
/// of the routine's last finished run, the line below which a reply routine leaves customers' messages alone.
export type ClaimAnswer =
  | { outcome: "gone" }
  | { outcome: "recorded"; run: RoutineRun }
  | { outcome: "settled"; run: RoutineRun }
  | { outcome: "claimed"; run: RoutineRun; routine: StoredRoutine; since: string | null };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const iso = (ms: number) => new Date(ms).toISOString();
const enc = encodeURIComponent;
const keys = {
  state: (tenant: string) => `routines:${enc(tenant)}`,
  allRuns: (tenant: string) => `routine-run:${enc(tenant)}:`,
  runs: (tenant: string, routineId: string) => `routine-run:${enc(tenant)}:${routineId}:`,
  /// Whole seconds, base 36 and fixed width, so a routine's runs list in the order of their instants.
  run: (tenant: string, routineId: string, instantMs: number) =>
    `routine-run:${enc(tenant)}:${routineId}:${Math.floor(instantMs / 1000).toString(36).padStart(9, "0")}`,
};

export function emptyState(): RoutineState {
  return { team: { paused: false, since: null, members: null }, routines: [], questions: [] };
}

function readState(kv: SyncKvStorage, tenant: string): RoutineState {
  return kv.get<RoutineState>(keys.state(tenant)) ?? emptyState();
}

/// The key a shop's routines, team and questions are kept under, for pilot-store.ts to put in the same write as a new
/// shop's own record.
export const routineStateKey = keys.state;

/// A shop template's setup as the Worker sends it: the template's id, the members it turns on, its routines as built, and
/// its first-week questions.
export type TemplateSetup = { template: string; members: WorkerMember[]; routines: StoredRoutine[]; questions: Question[] };

/// The setup `body` names, or null when it is not one. Checked again here rather than trusted, by the template route and by
/// the write that makes a shop with its setup (pilot-store.ts), so both refuse the same things.
export function templateSetupOf(body: Record<string, unknown>): TemplateSetup | null {
  const { template, members, routines, questions } = body;
  if (typeof template !== "string" || !SHORT_ID.test(template)) return null;
  if (!Array.isArray(members) || !members.every(isMember) || new Set(members).size !== members.length) return null;
  if (!Array.isArray(routines) || !routines.every(isStoredRoutine)) return null;
  if (!Array.isArray(questions) || questions.length > 10 || !questions.every((question) => isRecord(question) &&
    typeof question.id === "string" && SHORT_ID.test(question.id) && typeof question.text === "string" &&
    question.text.trim().length > 0 && question.text.length <= 500 && Object.keys(question).length === 2)) {
    return null;
  }
  return { template, members: [...members], routines: [...routines],
    questions: questions.map((question) => ({ id: question.id as string, text: question.text as string })) };
}

/// What a new shop starts with when it is made from a template: the setup and nothing else. Null when the setup holds more
/// routines than a shop keeps.
export function newShopState(setup: TemplateSetup): RoutineState | null {
  if (setup.routines.length > MAX_ROUTINES) return null;
  return { team: { ...emptyState().team, members: [...setup.members] }, routines: [...setup.routines],
    questions: setup.questions };
}

/// Whether a member is on: every worker is on until a shop template says which are.
export function memberOn(team: Team, member: WorkerMember): boolean {
  return team.members === null || team.members.includes(member);
}

function isMember(value: unknown): value is WorkerMember {
  return typeof value === "string" && (MEMBERS as readonly string[]).includes(value);
}

/// A routine as the Worker built it, checked again here rather than trusted: routine-rules' own check (the asks-first
/// rule included), a member, and only the fields a stored routine has.
function isStoredRoutine(value: unknown): value is StoredRoutine {
  if (!isRecord(value)) return false;
  const allowed = ["id", "name", "action", "timeZone", "trigger", "asksFirst", "member", "paused", "createdAt", "template"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  return typeof value.id === "string" && ROUTINE_ID.test(value.id) && checkRoutine(value) === null &&
    isMember(value.member) && typeof value.paused === "boolean" && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.template === undefined || (typeof value.template === "string" && SHORT_ID.test(value.template)));
}

/// The audit entry for a change, by the actor the Worker named (the system when it named none). An actor the log
/// cannot keep raises the shop's miss count instead, in the same write, and the change stands (audit-log.ts).
function audit(kv: SyncKvStorage, tenant: string, actor: AuditActor | undefined, record: Omit<AuditRecord, "actor">): void {
  auditPutSync(kv, tenant, actor ? { ...record, actor } : null, record.action);
}

/// `/routines` and `/routines/*` on a TenantObject. Reads need only the tenant; writes need the Worker's `x-routines`
/// header as well. Every write runs in one synchronous transaction with its audit entries.
export async function routineTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    const kv = storage.kv;
    if (route === "GET /routines") {
      const state = readState(kv, tenant);
      const lastRuns = state.routines.flatMap((routine) =>
        [...kv.list<RoutineRun>({ prefix: keys.runs(tenant, routine.id), reverse: true, limit: 1 })].map(([, run]) => run));
      return json({ ...state, lastRuns });
    }
    if (route === "GET /routines/runs") {
      const routineId = url.searchParams.get("routineId") ?? "";
      if (!ROUTINE_ID.test(routineId)) return json({ error: "invalid_request" }, 400);
      return json({ runs: [...kv.list<RoutineRun>({ prefix: keys.runs(tenant, routineId), reverse: true })].map(([, run]) => run) });
    }
    if (route === "GET /routines/export") {
      return json({ ...readState(kv, tenant), runs: [...kv.list<RoutineRun>({ prefix: keys.allRuns(tenant) })].map(([, run]) => run) });
    }
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-routines") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const tenant = body.tenant;
  const write = WRITES[route];
  if (!write) return json({ error: "not_found" }, 404);
  const actor = actorOr(body.actor, SYSTEM);
  const answer = storage.transactionSync(() => write(storage.kv, tenant, body, actor));
  return json(answer.body, answer.status);
}

type Answer = { status: number; body: unknown };
type Write = (kv: SyncKvStorage, tenant: string, body: Record<string, unknown>, actor: AuditActor | undefined) => Answer;

const ok = (body: unknown): Answer => ({ status: 200, body });
const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

/// A routine as a change answers it: with the team and its latest run, which its view needs.
function changed(kv: SyncKvStorage, tenant: string, state: RoutineState, routine: StoredRoutine): Answer {
  const [latest] = [...kv.list<RoutineRun>({ prefix: keys.runs(tenant, routine.id), reverse: true, limit: 1 })];
  return ok({ routine, team: state.team, lastRun: latest ? latest[1] : null });
}

/// A change to one routine: the routine named by `routineId`, changed by `change`, which answers the new routine, or
/// the same object when nothing changed (then nothing is written and nothing is logged).
function changeRoutine(action: "routine.paused" | "routine.resumed", change: (routine: StoredRoutine) => StoredRoutine): Write {
  return (kv, tenant, body, actor) => {
    if (typeof body.routineId !== "string" || !ROUTINE_ID.test(body.routineId)) return refuse(400, "invalid_request");
    const state = readState(kv, tenant);
    const index = state.routines.findIndex((routine) => routine.id === body.routineId);
    const before = state.routines[index];
    if (!before) return refuse(404, "not_found");
    const after = change(before);
    if (after === before) return changed(kv, tenant, state, before);
    state.routines[index] = after;
    kv.put(keys.state(tenant), state);
    audit(kv, tenant, actor, { action, subject: { routineId: after.id }, outcome: "ok" });
    return changed(kv, tenant, state, after);
  };
}

/// Deletes a routine's runs beyond the newest `RUNS_KEPT`, oldest first.
function pruneRuns(kv: SyncKvStorage, tenant: string, routineId: string): void {
  const all = [...kv.list({ prefix: keys.runs(tenant, routineId) })].map(([key]) => key);
  for (const key of all.slice(0, Math.max(0, all.length - RUNS_KEPT))) kv.delete(key);
}

const WRITES: Readonly<Record<string, Write>> = {
  /// `{ routine }`: a routine the Worker built through routine-rules' `createRoutine`.
  "POST /routines/create": (kv, tenant, body, actor) => {
    if (!isStoredRoutine(body.routine)) return refuse(400, "invalid_request");
    const routine = body.routine;
    const state = readState(kv, tenant);
    if (state.routines.some((existing) => existing.id === routine.id)) return refuse(409, "already_exists");
    if (state.routines.length >= MAX_ROUTINES) return refuse(409, "full");
    state.routines.push(routine);
    kv.put(keys.state(tenant), state);
    audit(kv, tenant, actor, { action: "routine.created", subject: { routineId: routine.id }, outcome: "ok" });
    return changed(kv, tenant, state, routine);
  },

  "POST /routines/pause": changeRoutine("routine.paused", (routine) => routine.paused ? routine : { ...routine, paused: true }),
  "POST /routines/resume": changeRoutine("routine.resumed", (routine) => routine.paused ? { ...routine, paused: false } : routine),

  /// `{ routineId }`: the routine and its runs go. The audit log keeps how each run ended.
  "POST /routines/remove": (kv, tenant, body, actor) => {
    if (typeof body.routineId !== "string" || !ROUTINE_ID.test(body.routineId)) return refuse(400, "invalid_request");
    const routineId = body.routineId;
    const state = readState(kv, tenant);
    if (!state.routines.some((routine) => routine.id === routineId)) return refuse(404, "not_found");
    state.routines = state.routines.filter((routine) => routine.id !== routineId);
    kv.put(keys.state(tenant), state);
    for (const [key] of [...kv.list({ prefix: keys.runs(tenant, routineId) })]) kv.delete(key);
    audit(kv, tenant, actor, { action: "routine.removed", subject: { routineId }, outcome: "ok" });
    return ok({ removed: routineId });
  },

  /// `{ paused, nowMs }`: Pause everyone, or resume. Pausing a paused team changes nothing, and keeps when it began.
  "POST /routines/team": (kv, tenant, body, actor) => {
    if (typeof body.paused !== "boolean" || !isTime(body.nowMs)) return refuse(400, "invalid_request");
    const state = readState(kv, tenant);
    if (state.team.paused === body.paused) return ok({ team: state.team });
    state.team = { ...state.team, paused: body.paused, since: body.paused ? iso(body.nowMs) : null };
    kv.put(keys.state(tenant), state);
    audit(kv, tenant, actor, { action: body.paused ? "team.paused" : "team.resumed", subject: {}, outcome: "ok" });
    return ok({ team: state.team });
  },

  /// `{ template, members, routines, questions }`: a shop template's setup, once per shop. The members it turns on,
  /// its routines (each paused) and its first-week questions, in one write with one entry for the template and one
  /// for each routine. A new shop's setup does not come this way: it is in the write that makes the shop (pilot-store.ts).
  "POST /routines/template": (kv, tenant, body, actor) => {
    const setup = templateSetupOf(body);
    if (!setup) return refuse(400, "invalid_request");
    const state = readState(kv, tenant);
    if (state.questions.length > 0 || state.routines.some((routine) => routine.template !== undefined)) {
      return refuse(409, "template_applied");
    }
    if (state.routines.length + setup.routines.length > MAX_ROUTINES) return refuse(409, "full");
    const next: RoutineState = {
      team: { ...state.team, members: [...setup.members] },
      routines: [...state.routines, ...setup.routines],
      questions: setup.questions,
    };
    kv.put(keys.state(tenant), next);
    audit(kv, tenant, actor, { action: "template.applied", subject: { templateId: setup.template }, outcome: "ok" });
    for (const routine of setup.routines) {
      audit(kv, tenant, actor, { action: "routine.created", subject: { routineId: routine.id }, outcome: "ok" });
    }
    return ok(next);
  },

  /// `{ routineId, instant, late, gate, nowMs }`: a clock's claim on the run meant for `instant`. `gate` is the code
  /// of the switch or consent that refused the run, or null. See the module note for what each answer means.
  "POST /routines/claim": (kv, tenant, body) => {
    const { routineId, instant, late, gate, nowMs } = body;
    if (typeof routineId !== "string" || !ROUTINE_ID.test(routineId) || !isTime(instant) || typeof late !== "boolean" ||
        !(gate === null || (typeof gate === "string" && CODE.test(gate))) || !isTime(nowMs)) {
      return refuse(400, "invalid_request");
    }
    const state = readState(kv, tenant);
    const routine = state.routines.find((candidate) => candidate.id === routineId);
    if (!routine) return ok({ outcome: "gone" } satisfies ClaimAnswer);
    const key = keys.run(tenant, routineId, instant);
    const existing = kv.get<RoutineRun>(key);
    if (existing) return ok({ outcome: "recorded", run: existing } satisfies ClaimAnswer);
    // Why the run will not start, in the order a person would ask: was it on, was everyone on, is its member on the
    // team, did it come in time, and did the switches and the owner allow it.
    const held = routine.paused ? "routine_paused" : state.team.paused ? "team_paused" :
      !memberOn(state.team, routine.member) ? "member_off" : null;
    const status: RunStatus = held ? "skipped" : late ? "missed" : gate ? "skipped" : "running";
    const reason = held ?? (late ? null : gate);
    const run: RoutineRun = { routineId, instant: iso(instant), status, ...(reason ? { reason } : {}),
      member: routine.member, at: iso(nowMs) };
    // The last finished run before this one, read before this one is written.
    const previous = [...kv.list<RoutineRun>({ prefix: keys.runs(tenant, routineId), reverse: true })]
      .map(([, earlier]) => earlier).find((earlier) => earlier.status === "done" && Date.parse(earlier.instant) < instant);
    kv.put(key, run);
    pruneRuns(kv, tenant, routineId);
    if (status === "running") {
      return ok({ outcome: "claimed", run, routine, since: previous?.instant ?? null } satisfies ClaimAnswer);
    }
    auditPutSync(kv, tenant, { actor: SYSTEM, action: "routine.ran", subject: { routineId },
      outcome: status === "missed" ? "missed" : "skipped", ...(reason ? { reason } : {}) }, "routine.ran");
    return ok({ outcome: "settled", run } satisfies ClaimAnswer);
  },

  /// `{ routineId, instant, status, reason?, taskId?, nowMs }`: how a claimed run's job ended. A run that already
  /// ended is answered as it is, so a retried finish changes nothing.
  "POST /routines/finish": (kv, tenant, body) => {
    const { routineId, instant, status, reason, taskId, nowMs } = body;
    if (typeof routineId !== "string" || !ROUTINE_ID.test(routineId) || !isTime(instant) || !isTime(nowMs) ||
        !(status === "done" || status === "failed" || status === "skipped") ||
        !(reason === undefined || (typeof reason === "string" && CODE.test(reason))) ||
        !(taskId === undefined || (typeof taskId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(taskId)))) {
      return refuse(400, "invalid_request");
    }
    const key = keys.run(tenant, routineId, instant);
    const run = kv.get<RoutineRun>(key);
    if (!run) return refuse(404, "not_found");
    if (run.status !== "running") return ok({ run });
    const ended: RoutineRun = { ...run, status, ...(reason ? { reason } : {}), ...(taskId ? { taskId } : {}), at: iso(nowMs) };
    kv.put(key, ended);
    auditPutSync(kv, tenant, { actor: SYSTEM, action: "routine.ran", subject: { routineId, ...(taskId ? { taskId } : {}) },
      outcome: status, ...(reason ? { reason } : {}) }, "routine.ran");
    return ok({ run: ended });
  },

  /// `{ questionId, text, nowMs }`: the owner's answer to a first-week question, relayed by an operator. It becomes the
  /// owner's own fact through memory's `remember`, and the question keeps the fact's id, in one transaction.
  "POST /routines/answer": (kv, tenant, body, actor) => {
    const { questionId, text, nowMs } = body;
    if (typeof questionId !== "string" || !SHORT_ID.test(questionId) || !isTime(nowMs)) return refuse(400, "invalid_request");
    const state = readState(kv, tenant);
    const question = state.questions.find((candidate) => candidate.id === questionId);
    if (!question) return refuse(404, "not_found");
    if (question.factId !== undefined) return refuse(409, "already_answered");
    if (!actor) return refuse(400, "invalid_request");
    const remembered = rememberWithin(kv, tenant, text, nowMs, actor);
    if (!remembered.ok) return refuse(remembered.status, remembered.error);
    const fact: Fact = remembered.fact;
    question.factId = fact.id;
    question.answeredAt = iso(nowMs);
    kv.put(keys.state(tenant), state);
    audit(kv, tenant, actor, { action: "question.answered", subject: { questionId, factId: fact.id }, outcome: "ok" });
    return ok({ question, fact });
  },
};

/// Part of the TenantObject's tenant wipe: the setup and every run.
export async function wipeRoutineTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const doomed = [keys.state(tenant), ...(await storage.list({ prefix: keys.allRuns(tenant) })).keys()];
  for (let i = 0; i < doomed.length; i += 128) await storage.delete(doomed.slice(i, i + 128));
}
