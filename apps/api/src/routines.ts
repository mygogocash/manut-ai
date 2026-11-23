/// The team's routines from the Worker's side (docs/pilot-api.md, "Routines" and "Shop templates"): the routes that
/// read and change them, and the runner the clocks call. The records and the one-run-per-instant claim are
/// routine-store.ts's, in the shop's TenantObject; building a routine and its clock is routine-setup.ts's; the clocks
/// are the shop's schedule object (schedule-object.ts).
///
/// Routes. An operator's, under the admin gate's exact `ADMIN_METHODS` entries (index.ts), name the shop in the query
/// or the body, and a change needs an existing pilot shop, as the console's other writes do. The shop's own session
/// reads and changes its own routines and pauses its own team; a helper's session is refused, because the team's
/// routines are the owner's. Making, pausing, resuming or removing a routine needs neither a switch nor consent:
/// nothing runs then. Each run reads both again.
///
/// A run, start to end (`runRoutineOccurrence`):
///
/// 1. The switches (`officeRoutines`, `officeCloud`) and the owner's consent, unless the run is already too late.
/// 2. The claim in the shop's object, which writes the run down as skipped or missed with why, or hands the run over.
/// 3. The worker's job through the job flow (workers.ts, `runWorker`): Ton's summary of yesterday's sales, Pim's post
///    about the routine, or Nam's reply to the newest customer message waiting since the routine last ran. Each is a
///    draft on the job's task for the owner to read. The runner never asks for an external write and never sends,
///    posts or pays, whatever the routine's kind: a routine that would reply, send, pay or delete always asks first,
///    and what asking needs is the approvals' (approval-core), after the owner has read the draft.
/// 4. How the job ended, written on the run with its audit entry.

import { templates, type ShopTemplate } from "@manut/shop-templates";
import type { Fact } from "@manut/shop-memory";
import { OWNER_SESSION } from "./approvals";
import type { AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { workGate, type JobFlowEnv } from "./job-flow";
import type { ModelProvider } from "./model-provider";
import { callerOf, type PeopleEnv } from "./people";
import { operatorIdentity } from "./pilot";
import type { InboundMessage, PilotShopRecord } from "./pilot-store";
import type { ClaimAnswer, Question, RoutineRun, StoredRoutine, Team } from "./routine-store";
import { ROUTINE_ID } from "./routine-store";
import {
  buildRoutine,
  ensureClocks,
  readRoutines,
  removeClock,
  routinesView,
  routineView,
  routineWrite,
  teamView,
} from "./routine-setup";
import { authCall, tenantCall, type TenantDataEnv } from "./tenant-data";
import { runWorker, type WorkerJob } from "./workers";

export type { RoutineRun } from "./routine-store";
export type { RoutinesView, RoutineView, TeamView } from "./routine-setup";

export type RoutineEnv = TenantDataEnv & JobFlowEnv & PeopleEnv & {
  OFFICE_CLOUD?: string;
  OFFICE_ROUTINES?: string;
  OFFICE_EXTERNAL_WRITES?: string;
};

const MAX_BODY_BYTES = 16 * 1024;
/// A run's reason as the audit log takes it: a code, never words.
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const enc = encodeURIComponent;

/// The paths this file answers: the operator's and a session's.
function isRoutinesPath(path: string): boolean {
  return path === "/v1/admin/routines" || path.startsWith("/v1/admin/routines/") || path.startsWith("/v1/admin/team/") ||
    path === "/v1/admin/templates" || path === "/v1/admin/questions" || path.startsWith("/v1/admin/questions/") ||
    path === "/v1/routines" || path.startsWith("/v1/routines/") || path.startsWith("/v1/team/");
}

/// A session's routes: its own routines, and its own team.
const SESSION_ROUTES = new Set(["GET /v1/routines", "POST /v1/routines", "POST /v1/routines/pause",
  "POST /v1/routines/resume", "POST /v1/routines/remove", "POST /v1/team/pause", "POST /v1/team/resume"]);

/// Entry point from the Worker, after the ingress gates and the admin gate. Answers null for any other path.
export async function routinesRoute(request: Request, url: URL, env: RoutineEnv, ctx: ExecutionContext):
  Promise<Response | null> {
  const path = url.pathname;
  if (!isRoutinesPath(path)) return null;
  const route = `${request.method} ${path}`;
  if (path.startsWith("/v1/admin/")) return operatorRoute(route, request, url, env, ctx);
  if (!SESSION_ROUTES.has(route)) return json({ error: "not_found" }, 404);
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  const tenant = caller.shop;
  if (route === "GET /v1/routines") return listRoutines(env, tenant);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  // The shop is the session's: a body that names one is refused rather than read as another shop.
  if ("tenant" in body) return json({ error: "invalid_request" }, 400);
  return change(route, env, tenant, body, { kind: "owner", id: OWNER_SESSION });
}

async function bodyOf(request: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  return isRecord(parsed.value) ? parsed.value : json({ error: "invalid_request" }, 400);
}

/// The operator's routes. The admin gate already required both credentials and the exact method.
async function operatorRoute(route: string, request: Request, url: URL, env: RoutineEnv, ctx: ExecutionContext):
  Promise<Response> {
  if (route === "GET /v1/admin/templates") return json({ templates: templates().map(templateView) });
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
    if (route === "GET /v1/admin/routines") return listRoutines(env, tenant);
    if (route === "GET /v1/admin/questions") return listQuestions(env, tenant);
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const body = await bodyOf(request);
  if (body instanceof Response) return body;
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  const tenant = body.tenant;
  // Every change names an existing pilot shop, as the console's other writes do.
  const shop = await readShop(env, tenant);
  if (shop === undefined) return json({ error: "shop_unavailable" }, 503);
  if (shop === null) return json({ error: "shop_not_found" }, 404);
  const actor: AuditActor = { kind: "operator", email: await operatorIdentity(ctx) };
  const { tenant: _tenant, ...rest } = body;
  if (route === "POST /v1/admin/questions/answer") return answerQuestion(env, tenant, rest, actor);
  return change(route.replace("/v1/admin/", "/v1/"), env, tenant, rest, actor);
}

/// A change to the shop's routines or team, the same from an operator and from the shop's session.
async function change(route: string, env: RoutineEnv, tenant: string, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  switch (route) {
    case "POST /v1/routines":
      return createRoutine(env, tenant, body, actor);
    case "POST /v1/routines/pause":
    case "POST /v1/routines/resume":
      return pauseOrResume(env, tenant, body, actor, route.endsWith("pause") ? "/routines/pause" : "/routines/resume");
    case "POST /v1/routines/remove":
      return removeRoutine(env, tenant, body, actor);
    case "POST /v1/team/pause":
    case "POST /v1/team/resume":
      return pauseTeam(env, tenant, route.endsWith("pause"), actor);
  }
  return json({ error: "not_found" }, 404);
}

async function listRoutines(env: RoutineEnv, tenant: string): Promise<Response> {
  const state = await readRoutines(env, tenant);
  if (!state) return json({ error: "routines_unavailable" }, 503);
  return json(routinesView(tenant, state, Date.now()));
}

const NEW_ROUTINE_FIELDS = ["name", "action", "trigger", "timeZone", "asksFirst", "member"];

/// A routine, switched on. Its clock is written first (routine-setup.ts, the module note).
async function createRoutine(env: RoutineEnv, tenant: string, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  if (!Object.keys(body).every((key) => NEW_ROUTINE_FIELDS.includes(key))) return json({ error: "invalid_request" }, 400);
  const nowMs = Date.now();
  const built = buildRoutine(body, { nowMs, paused: false });
  if (!built.ok) return json({ error: built.error }, 400);
  if (!(await ensureClocks(env, tenant, [built.routine]))) return json({ error: "clock_unavailable" }, 503);
  return routineAnswer(await routineWrite(env, tenant, "/routines/create", { routine: built.routine, actor }), nowMs);
}

async function pauseOrResume(env: RoutineEnv, tenant: string, body: Record<string, unknown>, actor: AuditActor,
  path: "/routines/pause" | "/routines/resume"): Promise<Response> {
  if (typeof body.routineId !== "string" || !ROUTINE_ID.test(body.routineId)) return json({ error: "invalid_request" }, 400);
  const answer = await routineWrite(env, tenant, path, { routineId: body.routineId, actor });
  // Turning a routine on makes sure its clock is there, so a routine whose clock was lost runs again once resumed.
  if (path === "/routines/resume" && answer?.ok) {
    const { routine } = (await answer.clone().json()) as { routine: StoredRoutine };
    await ensureClocks(env, tenant, [routine]);
  }
  return routineAnswer(answer, Date.now());
}

/// A routine change's answer as the route gives it: the routine's view, or the store's refusal.
async function routineAnswer(response: Response | null, nowMs: number): Promise<Response> {
  if (!response) return json({ error: "routines_unavailable" }, 503);
  const body = (await response.json().catch(() => null)) as
    | { routine: StoredRoutine; team: Team; lastRun: RoutineRun | null; error?: undefined }
    | { error: string }
    | null;
  if (!body) return json({ error: "routines_unavailable" }, 503);
  if ("error" in body && body.error !== undefined) {
    return [400, 404, 409].includes(response.status) ? json({ error: body.error }, response.status)
      : json({ error: "routines_unavailable" }, 503);
  }
  const { routine, team, lastRun } = body as { routine: StoredRoutine; team: Team; lastRun: RoutineRun | null };
  return json({ routine: routineView(routine, team, lastRun, nowMs) });
}

/// The routine and its runs go, then its clock (routine-setup.ts, the module note).
async function removeRoutine(env: RoutineEnv, tenant: string, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  if (typeof body.routineId !== "string" || !ROUTINE_ID.test(body.routineId)) return json({ error: "invalid_request" }, 400);
  const routineId = body.routineId;
  const response = await routineWrite(env, tenant, "/routines/remove", { routineId, actor });
  if (!response) return json({ error: "routines_unavailable" }, 503);
  await response.body?.cancel();
  if (response.status === 404) return json({ error: "not_found" }, 404);
  if (!response.ok) return json({ error: "routines_unavailable" }, 503);
  await removeClock(env, tenant, routineId);
  return json({ removed: routineId });
}

/// Pause everyone, or resume: every routine's run is skipped and says so while the team is paused.
async function pauseTeam(env: RoutineEnv, tenant: string, paused: boolean, actor: AuditActor): Promise<Response> {
  const response = await routineWrite(env, tenant, "/routines/team", { paused, nowMs: Date.now(), actor });
  if (!response?.ok) {
    await response?.body?.cancel();
    return json({ error: "routines_unavailable" }, 503);
  }
  const { team } = (await response.json()) as { team: Team };
  return json({ team: teamView(team) });
}

// ---------------------------------------------------------------------------
// Shop templates and their first-week questions (the operator's)
// ---------------------------------------------------------------------------

/// A template as the console's new-shop form offers it: its own words, from `@manut/shop-templates`.
function templateView(template: ShopTemplate) {
  return {
    id: template.id,
    name: template.name,
    fits: template.fits,
    team: [...template.team],
    routines: template.routines.map((routine) => ({ when: routine.trigger, does: routine.does,
      asksFirst: routine.asksFirst })),
    questions: [...template.questions],
  };
}

type QuestionView = {
  id: string;
  text: string;
  /// The answer as the team now knows it: the owner's fact, its words read from what the team knows. `text` is null
  /// once the owner had the team forget it.
  answer: { factId: string; text: string | null; answeredAt: string } | null;
};

function questionView(question: Question, facts: readonly Fact[]): QuestionView {
  const fact = question.factId === undefined ? undefined : facts.find((candidate) => candidate.id === question.factId);
  return {
    id: question.id,
    text: question.text,
    answer: question.factId === undefined ? null
      : { factId: question.factId, text: fact?.text ?? null, answeredAt: question.answeredAt ?? "" },
  };
}

async function readFacts(env: RoutineEnv, tenant: string): Promise<Fact[] | null> {
  try {
    const response = await tenantCall(env, tenant, `/memory?tenant=${enc(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { facts } = (await response.json()) as { facts?: Fact[] };
    return Array.isArray(facts) ? facts : null;
  } catch {
    return null;
  }
}

/// `GET /v1/admin/questions?tenant=`: the template the shop was made from, and what Buddy asks its owner in the first
/// week, each with its answer as the team now knows it.
async function listQuestions(env: RoutineEnv, tenant: string): Promise<Response> {
  const [shop, state, facts] = await Promise.all([readShop(env, tenant), readRoutines(env, tenant), readFacts(env, tenant)]);
  if (shop === undefined || !state || !facts) return json({ error: "questions_unavailable" }, 503);
  return json({ tenant, template: shop?.template ?? null,
    questions: state.questions.map((question) => questionView(question, facts)) });
}

/// `POST /v1/admin/questions/answer` with `{ tenant, questionId, text }`: the owner's answer, relayed by the operator,
/// becomes the owner's own fact through memory's `remember`. The text should stand on its own ("Free delivery on orders
/// over ฿1,000"), as any fact the team is told to remember. Once only: a later change is a correction on the fact.
async function answerQuestion(env: RoutineEnv, tenant: string, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  if (!Object.keys(body).every((key) => key === "questionId" || key === "text") || typeof body.questionId !== "string") {
    return json({ error: "invalid_request" }, 400);
  }
  const response = await routineWrite(env, tenant, "/routines/answer", { questionId: body.questionId, text: body.text,
    nowMs: Date.now(), actor });
  if (!response) return json({ error: "questions_unavailable" }, 503);
  const answer = (await response.json().catch(() => null)) as { question: Question; fact: Fact } | { error: string } | null;
  if (!answer) return json({ error: "questions_unavailable" }, 503);
  if ("error" in answer) {
    return [400, 404, 409].includes(response.status) ? json({ error: answer.error }, response.status)
      : json({ error: "questions_unavailable" }, 503);
  }
  return json({ question: questionView(answer.question, [answer.fact]), fact: answer.fact });
}

// ---------------------------------------------------------------------------
// Running a routine
// ---------------------------------------------------------------------------

/// The switches a run reads: the same rule as index.ts's `featureFlags`, a dynamic record over the environment's
/// default, for the three this needs. The clocks run inside the schedule object, where index.ts is not.
export type RunFlags = { officeCloud: boolean; officeRoutines: boolean; officeExternalWrites: boolean };

async function runFlags(env: RoutineEnv): Promise<RunFlags> {
  const defaults: RunFlags = {
    officeCloud: env.OFFICE_CLOUD === "1",
    officeRoutines: env.OFFICE_ROUTINES === "1",
    officeExternalWrites: env.OFFICE_EXTERNAL_WRITES === "1",
  };
  try {
    const response = await authCall(env, "/flags");
    if (!response.ok) {
      await response.body?.cancel();
      return defaults;
    }
    const dynamic = (await response.json()) as Partial<Record<keyof RunFlags, unknown>>;
    const pick = (key: keyof RunFlags) => (typeof dynamic[key] === "boolean" ? dynamic[key] as boolean : defaults[key]);
    return { officeCloud: pick("officeCloud"), officeRoutines: pick("officeRoutines"),
      officeExternalWrites: pick("officeExternalWrites") };
  } catch {
    return defaults;
  }
}

/// One run a clock is due to make: the routine, and the instant it was meant for (never when the alarm came).
export type RoutineOccurrence = { tenant: string; routineId: string; instant: number; late: boolean };

/// How the run went: the run's own status (a duplicate answers the run already recorded), `gone` when the routine no
/// longer exists so the clock can drop it, or `unavailable` when the shop's object could not be reached, which claims
/// nothing and leaves the clock to try again.
export type OccurrenceOutcome =
  | { status: RoutineRun["status"]; reason?: string; taskId?: string }
  | { status: "gone" }
  | { status: "unavailable" };

export type RunOptions = {
  /// The model provider the gateway calls, for tests; production takes it from the environment.
  provider?: ModelProvider;
  /// The switches, for tests; production reads them as index.ts does.
  flags?: () => Promise<RunFlags>;
};

/// Runs one occurrence of a routine. See the module note for the steps.
export async function runRoutineOccurrence(env: RoutineEnv, occurrence: RoutineOccurrence, options: RunOptions = {}):
  Promise<OccurrenceOutcome> {
  const { tenant, routineId, instant, late } = occurrence;
  const flags = options.flags ?? (() => runFlags(env));
  const gate = late ? null : await gateOf(env, tenant, flags);
  const claimed = await claim(env, tenant, { routineId, instant, late, gate, nowMs: Date.now() });
  if (!claimed) return { status: "unavailable" };
  if (claimed.outcome === "gone") return { status: "gone" };
  if (claimed.outcome !== "claimed") return outcomeOf(claimed.run);
  const { routine, since } = claimed;
  const end = (ended: { status: "done" | "failed" | "skipped"; reason?: string; taskId?: string }) =>
    finish(env, tenant, routineId, instant, ended);
  const job = await jobFor(env, tenant, routine, since);
  if ("skip" in job) return end({ status: "skipped", reason: job.skip });
  if ("fail" in job) return end({ status: "failed", reason: job.fail });
  const run = await runWorker(env, { tenant, member: routine.member, job: job.job, startedBy: { kind: "system" } }, {
    flags: async () => {
      const current = await flags();
      return { officeCloud: current.officeCloud, officeExternalWrites: current.officeExternalWrites };
    },
    ...(options.provider ? { provider: options.provider } : {}),
  });
  if (!run.ok) return end({ status: "failed", reason: codeOf(run.error) });
  return end(run.outcome === "done" ? { status: "done", taskId: run.taskId }
    : { status: "failed", taskId: run.taskId, reason: codeOf(run.reason) });
}

/// Why the switches or consent refuse a run now, as a code, or null when they allow it. The job flow's own gate reads
/// `officeCloud` and consent, as it does again before the worker's every step.
async function gateOf(env: RoutineEnv, tenant: string, flags: () => Promise<RunFlags>): Promise<string | null> {
  const current = await flags();
  if (!current.officeRoutines) return "routines_off";
  const refused = await workGate(env, tenant, async () => current, false);
  if (!refused) return null;
  return refused.error === "consent_required" ? "consent_required" : "cloud_off";
}

async function claim(env: RoutineEnv, tenant: string, body: Record<string, unknown>): Promise<ClaimAnswer | null> {
  const response = await routineWrite(env, tenant, "/routines/claim", body);
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  return (await response.json().catch(() => null)) as ClaimAnswer | null;
}

/// Writes how a claimed run ended. If that write cannot be made, the run stays `running` in the shop's records, and the
/// answer still says how it ended, so the clock records it.
async function finish(env: RoutineEnv, tenant: string, routineId: string, instant: number,
  ended: { status: "done" | "failed" | "skipped"; reason?: string; taskId?: string }): Promise<OccurrenceOutcome> {
  const response = await routineWrite(env, tenant, "/routines/finish", { routineId, instant, ...ended, nowMs: Date.now() });
  const answer = response?.ok ? ((await response.json().catch(() => null)) as { run: RoutineRun } | null) : null;
  if (!answer) await response?.body?.cancel();
  return answer ? outcomeOf(answer.run) : ended;
}

function outcomeOf(run: RoutineRun): OccurrenceOutcome {
  return { status: run.status, ...(run.reason ? { reason: run.reason } : {}), ...(run.taskId ? { taskId: run.taskId } : {}) };
}

function codeOf(reason: string): string {
  return CODE.test(reason) ? reason : "failed";
}

/// The job a run starts for the routine's member: Ton's summary, Pim's post about the routine's name, or Nam's reply to
/// the newest customer message that has no reply and came in since the routine last ran. With no such message, the run
/// has nothing to do and says so.
async function jobFor(env: RoutineEnv, tenant: string, routine: StoredRoutine, since: string | null):
  Promise<{ job: WorkerJob } | { skip: string } | { fail: string }> {
  switch (routine.member) {
    case "ton":
      return { job: { kind: "daily_summary" } };
    case "pim":
      return { job: { kind: "post", topic: routine.name } };
    case "nam": {
      const message = await waitingMessage(env, tenant, since);
      if (message === undefined) return { fail: "messages_unavailable" };
      if (message === null) return { skip: "nothing_to_answer" };
      return { job: { kind: "reply", messageId: message.id } };
    }
  }
}

/// The newest customer message with no reply proposed, received after `since`; null when there is none, undefined when
/// the shop's messages cannot be read. Customers' messages age out after seven days, so older ones are never answered.
async function waitingMessage(env: RoutineEnv, tenant: string, since: string | null):
  Promise<InboundMessage | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/messages?tenant=${enc(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { messages } = (await response.json()) as { messages?: InboundMessage[] };
    const after = since === null ? -Infinity : Date.parse(since);
    return (messages ?? []).find((message) => message.replyActionId === undefined &&
      Date.parse(message.receivedAt) > after) ?? null;
  } catch {
    return undefined;
  }
}

/// The pilot shop's record, null when the tenant is not one, undefined when it cannot be read.
async function readShop(env: RoutineEnv, tenant: string): Promise<PilotShopRecord | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${enc(tenant)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return ((await response.json()) as { shop: PilotShopRecord }).shop;
  } catch {
    return undefined;
  }
}
