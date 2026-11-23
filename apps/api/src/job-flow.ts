/// The control plane's side of the worker adapter contract (docs/phase-0-spikes.md, section 3): how one of Buddy's
/// team members, running as a worker, is given one attempt at a task and does all of its work through the control
/// plane.
///
/// - `startAttempt` gives the worker its job: the tenant, the task, one attempt and its fencing token (TaskObject's
///   claim), the goal (the task's objective), what is left of the shop's model cap, and a deadline.
/// - `workerPort` is everything the worker may do, bound to that one attempt. It reports agent events into the task's
///   own event log; calls a model only through the gateway, metered against the shop's cap; stops before an external
///   write to ask for the exact action; reads how its request settled; asks for a one-time grant for an outpost to
///   type a site sign-in, or reports one broken (sign-in-vault.ts); and finishes. The port holds the environment and
///   the worker holds only the port, so a worker never holds a credential: the port has no method that returns one.
/// - `decideRequest` is a person's decision on a worker's request, through approval-core in the task object, and on
///   approval the broker's one dispatch with the vault's credentials (`dispatchApproved`).
/// - `endSilentAttempts` and `cancelAttempt` end attempts on the control plane's own account.
///
/// Every step keeps the guarantees the session routes keep: the kill switches and the owner's consent are read again
/// before work continues, a decision passes approval-core's rules once, and the begin gate dispatches at most once.
/// Each step is also written to the shop's audit log (audit-log.ts): best effort, after the step, because the step's
/// own record lives in the task object.

import type { ApprovalKind, ApprovalRecord, ApprovalRequest, DecideResult, Role, Standing } from "@manut/approval-core";
import { APPROVAL_LINK_TTL_MS } from "./approval-link";
import { appendAudit, type AuditActor, type AuditOutcome } from "./audit-log";
import { beginDispatchAction, finishDispatchAction, type FetchImpl } from "./broker-actions";
import { callModel, type ModelGatewayEnv } from "./model-gateway";
import type { UsageState } from "./model-meter";
import { bangkokMonth, effectiveCap, floorSatang, gatewaySettings, MILLISATANG_PER_SATANG } from "./model-price";
import type { ChatRequest, ChatUsage, ModelProvider } from "./model-provider";
import { issueSignInGrant, reportSignInBroken, type AttemptRef, type SignInGrant } from "./sign-in-vault";
import {
  JOB_REQUEST_OPTIONS,
  type ActionProposalJSON,
  type AttemptJSON,
  type DraftJSON,
  type TaskDocJSON,
} from "./task-object";
import { credStub, tenantCall, type TenantDataEnv } from "./tenant-data";

export type JobFlowEnv = TenantDataEnv & ModelGatewayEnv;

/// The kill switches the job flow reads (index.ts `featureFlags`), passed in as the pilot's routes get them.
export type JobFlags = () => Promise<{ officeCloud: boolean; officeExternalWrites: boolean }>;

export type JobOptions = {
  flags: JobFlags;
  /// The provider's fetch, for the broker's one dispatch. Tests hand in a stub; production uses the global fetch.
  fetchImpl?: FetchImpl;
  /// The model provider the gateway calls, for tests that read what a worker sent: still through the gateway, so the
  /// call is priced, held against the shop's cap and settled like any other. Production leaves it unset and the
  /// gateway takes the provider from the environment.
  provider?: ModelProvider;
};

/// What a worker is given: one attempt at one task.
export type Job = {
  tenant: string;
  taskId: string;
  attemptId: string;
  /// Fences every later step: only the holder of this attempt can report, ask or finish in it.
  fence: string;
  /// The task's objective.
  goal: string;
  /// The most the attempt can spend on models, in satang: what is left of the shop's monthly cap when the attempt
  /// starts. The gateway holds every call against the shop's cap, so the attempt can never spend more, and may get
  /// less if other work for the shop spends first. There is no separate cap per attempt.
  capSatang: number;
  /// When the attempt stops being allowed to act, whatever it is doing.
  deadline: string;
};

/// A refusal before anything was done: the switches, consent, or an object that could not be read.
export type Refused = { ok: false; status: number; error: string; feature?: string };

/// What the port answers a worker. `ended` says the attempt no longer runs, so the worker should stop for good.
export type PortAnswer<T> = { ok: true; value: T } | { ok: false; error: string; ended?: true };

/// An external write a worker wants to make: what, where, and with what. Which connection carries it, under which
/// grant revision, and until when the owner may answer are the control plane's to set.
export type ProposedAction = { operationType: string; targetResourceId: string; payload: Record<string, unknown> };

export type AskAnswer = { requestId: string; kind: ApprovalKind; revision: number; expiresAt: string };

/// What a worker wrote for the owner to read, as it hands it to `draft`. The task object keeps it with the attempt
/// that wrote it and the time (task-object.ts, `DraftJSON`).
export type NewDraft = Omit<DraftJSON, "attemptId" | "at">;

/// How a request a worker asked stands: approval-core's standing, which way it was decided once it was, and where
/// the action stands with the broker.
export type RequestOutcome = {
  standing: Standing["state"];
  reason: string;
  approved?: boolean;
  action: ActionProposalJSON["state"];
  providerOperationId?: string;
};

export interface WorkerPort {
  readonly job: Job;
  report(events: readonly unknown[]): Promise<PortAnswer<{ stored: number }>>;
  heartbeat(): Promise<PortAnswer<{ leaseUntil: number }>>;
  callModel(request: ChatRequest): Promise<PortAnswer<{ text: string; stopReason: string; usage: ChatUsage;
    costSatang: number }>>;
  ask(action: ProposedAction): Promise<PortAnswer<AskAnswer>>;
  outcome(requestId: string): Promise<PortAnswer<RequestOutcome>>;
  draft(draft: NewDraft): Promise<PortAnswer<DraftJSON>>;
  waitForOwner(): Promise<PortAnswer<{ outcome: "awaiting_owner" }>>;
  finish(outcome: "done" | "failed", reason?: string): Promise<PortAnswer<{ outcome: "done" | "failed" }>>;
  /// Browser control (docs/browser-control.md): a one-time grant for the outpost named to type one of the shop's site
  /// sign-ins in this attempt's browser step. It names the grant and never holds an account or a password.
  signIn(signInId: string, outpostId: string): Promise<PortAnswer<SignInGrant>>;
  /// The site refused a sign-in's saved password: nobody uses it until the owner types a new one.
  signInBroken(signInId: string): Promise<PortAnswer<{ signInId: string; state: "broken" }>>;
}

/// The provider each operation a worker may ask for writes to. The connection that carries it is the shop's live
/// connection to that provider whose grant covers the target. The task object sets the approval kind of each
/// operation (`REQUEST_KINDS` in task-object.ts), and LINE replies stay on the pilot's own flow.
const PROVIDER_OF: Readonly<Record<string, string>> = { "linear.issue.create": "linear" };

/// The task object's answers that mean the attempt no longer runs.
const ENDED: ReadonlySet<string> = new Set(["stale_attempt", "fence_mismatch", "lease_expired", "task_settled"]);

const enc = encodeURIComponent;

function taskCall(
  env: Pick<TenantDataEnv, "TASK">,
  tenant: string,
  taskId: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; control?: boolean } = {},
): Promise<Response> {
  const headers = new Headers({ "x-tenant": tenant });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.control) headers.set("x-control", "1");
  return env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(`https://task${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }));
}

async function errorOf(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : fallback;
}

/// A refusal from the task object, as the port tells it to the worker.
async function portRefusal(response: Response): Promise<{ ok: false; error: string; ended?: true }> {
  const error = await errorOf(response, "unavailable");
  return ENDED.has(error) ? { ok: false, error, ended: true } : { ok: false, error };
}

async function consented(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<boolean> {
  const response = await tenantCall(env, tenant, `/consent?tenant=${enc(tenant)}`).catch(() => null);
  if (!response?.ok) return false;
  const record = (await response.json().catch(() => null)) as { cloudWork?: unknown } | null;
  return record?.cloudWork === true;
}

/// Whether work for the shop may go on now: the switches and the owner's consent, read again at every step as the
/// session routes read them (index.ts, `consentGate`). Withdrawing consent stops new and continuing work; a worker
/// refused here stops reporting, and its lease lapses. `writes` adds the external-writes switch. Exported for the
/// workers' runner (workers.ts), which reads it before it creates anything for a job.
export async function workGate(env: Pick<TenantDataEnv, "TENANT">, tenant: string, flags: JobFlags, writes: boolean):
  Promise<Refused | null> {
  const current = await flags();
  if (!current.officeCloud) return { ok: false, status: 403, error: "feature_disabled", feature: "officeCloud" };
  if (writes && !current.officeExternalWrites) {
    return { ok: false, status: 403, error: "feature_disabled", feature: "officeExternalWrites" };
  }
  if (!(await consented(env, tenant))) return { ok: false, status: 403, error: "consent_required" };
  return null;
}

/// What is left of the shop's model cap this Bangkok month, rounded down and never below nothing, the way the
/// operator's usage page rounds it (model-gateway.ts). Null when the meter or its settings cannot be read.
async function remainingSatang(env: JobFlowEnv, tenant: string, nowMs: number): Promise<number | null> {
  const settings = gatewaySettings(env);
  if (!settings.ok) return null;
  const response = await tenantCall(env, tenant, `/model/usage?tenant=${enc(tenant)}&month=${bangkokMonth(nowMs)}`)
    .catch(() => null);
  if (!response?.ok) return null;
  const state = (await response.json()) as UsageState;
  const cap = effectiveCap(state.capOverride, settings.settings.defaultCapSatang);
  const held = state.holds.reduce((sum, hold) => sum + hold.worstMillisatang, 0);
  const left = cap.capSatang * MILLISATANG_PER_SATANG - state.totals.spentMillisatang - held;
  return left > 0 ? floorSatang(left) : 0;
}

/// Gives a worker one attempt at a task. Refused while the switches or consent forbid work; nothing is claimed
/// unless the task and the meter can both be read, so no attempt starts that could not be told its cap. The log names
/// `startedBy` as the one who started it: an operator through the console, or Manut AI's system (the default).
export async function startAttempt(
  env: JobFlowEnv,
  input: { tenant: string; taskId: string; executorId: string; maxActiveSeconds?: number; startedBy?: AuditActor },
  options: JobOptions,
): Promise<{ ok: true; job: Job } | Refused> {
  const { tenant, taskId } = input;
  const refused = await workGate(env, tenant, options.flags, false);
  if (refused) return refused;
  const read = await taskCall(env, tenant, taskId, "/");
  if (read.status === 404) return { ok: false, status: 404, error: "not_found" };
  if (!read.ok) return { ok: false, status: 503, error: "task_unavailable" };
  const doc = (await read.json()) as TaskDocJSON;
  const capSatang = await remainingSatang(env, tenant, Date.now());
  if (capSatang === null) return { ok: false, status: 503, error: "meter_unavailable" };
  const claimed = await taskCall(env, tenant, taskId, "/attempts", { method: "POST", body: {
    executorId: input.executorId,
    inputRevision: `rev:${doc.rev}`,
    ...(input.maxActiveSeconds !== undefined ? { maxActiveSeconds: input.maxActiveSeconds } : {}),
  } });
  if (!claimed.ok) return { ok: false, status: claimed.status, error: await errorOf(claimed, "attempt_unavailable") };
  const attempt = (await claimed.json()) as AttemptJSON;
  await appendAudit(env, tenant, { actor: input.startedBy ?? { kind: "system" }, action: "attempt.started",
    subject: { taskId, attemptId: attempt.id }, outcome: "ok" });
  return { ok: true, job: {
    tenant,
    taskId,
    attemptId: attempt.id,
    fence: String(attempt.fence),
    goal: doc.objective,
    capSatang,
    deadline: new Date(attempt.deadline * 1000).toISOString(),
  } };
}

/// Writes an attempt's end to the shop's log, and each request it left waiting, which its end superseded.
async function recordEnded(
  env: JobFlowEnv,
  tenant: string,
  taskId: string,
  ended: { attempt: AttemptJSON; superseded: string[] },
  actor: AuditActor,
): Promise<void> {
  const { attempt } = ended;
  const outcome: AuditOutcome = attempt.outcome ?? "failed";
  await appendAudit(env, tenant, { actor, action: "attempt.ended", subject: { taskId, attemptId: attempt.id }, outcome,
    ...(attempt.reason ? { reason: attempt.reason } : {}) });
  for (const requestId of ended.superseded) {
    await appendAudit(env, tenant, { actor: { kind: "system" }, action: "approval.superseded",
      subject: { taskId, attemptId: attempt.id, requestId, actionId: requestId }, outcome: "superseded",
      reason: "attempt_ended" });
  }
}

type Ended = { ok: true; attempt: AttemptJSON; superseded: string[] } | { ok: false; response: Response };

/// Ends an attempt through the task object and records it. With the fence, only while that worker still holds it.
async function endAndRecord(
  env: JobFlowEnv,
  tenant: string,
  taskId: string,
  attemptId: string,
  end: { fence?: string; outcome: "done" | "failed" | "cancelled" | "awaiting_owner"; reason?: string },
  actor: AuditActor,
): Promise<Ended> {
  const response = await taskCall(env, tenant, taskId, `/attempts/${enc(attemptId)}/end`, { method: "POST", body: end,
    control: true });
  if (!response.ok) return { ok: false, response };
  const ended = (await response.json()) as { attempt: AttemptJSON; superseded: string[] };
  await recordEnded(env, tenant, taskId, ended, actor);
  return { ok: true, ...ended };
}

async function readAction(env: JobFlowEnv, tenant: string, taskId: string, actionId: string):
  Promise<ActionProposalJSON | null> {
  // The task object's read settles a send orphaned for more than five minutes as unknown, never by sending again.
  const response = await taskCall(env, tenant, taskId, `/actions/${enc(actionId)}`).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json()) as ActionProposalJSON;
}

type StoredRequest = { record: ApprovalRecord; standing: Standing; action: ActionProposalJSON };

/// The live grant for a worker's write: the shop's connection to `provider` that allows actions and whose granted
/// resources include `target`. The vault lists only connections not revoked, with their grant and never a secret.
/// Undefined when the vault cannot be read.
async function liveGrant(env: JobFlowEnv, tenant: string, provider: string, target: string):
  Promise<{ id: string; accountId: string; grantRevision: number } | null | undefined> {
  const response = await credStub(env, tenant).fetch(new Request(`https://cred/connections?tenant=${enc(tenant)}`,
    { headers: { "x-tenant": tenant } })).catch(() => null);
  if (!response?.ok) return undefined;
  const { connections } = (await response.json()) as { connections?: Record<string, unknown>[] };
  for (const connection of connections ?? []) {
    const { id, accountId, grantRevision, resourceIds } = connection;
    if (connection.provider === provider && connection.allowsActions === true && typeof id === "string" &&
        typeof accountId === "string" && typeof grantRevision === "number" && Number.isInteger(grantRevision) &&
        Array.isArray(resourceIds) && resourceIds.includes(target)) {
      return { id, accountId, grantRevision };
    }
  }
  return null;
}

/// Everything a worker may do, bound to the attempt it was given. See the module note.
export function workerPort(env: JobFlowEnv, job: Job, options: JobOptions): WorkerPort {
  const attemptPath = `/attempts/${enc(job.attemptId)}`;
  const worker: AuditActor = { kind: "worker", attemptId: job.attemptId };

  const gate = async (writes = false): Promise<{ ok: false; error: string } | null> => {
    const refused = await workGate(env, job.tenant, options.flags, writes);
    return refused ? { ok: false, error: refused.error } : null;
  };

  /// The attempt's heartbeat: the task object checks the fence, the lease, the deadline and the task, and extends
  /// the lease. Every step that is not a report starts with it, so a worker whose attempt ended learns so first. It
  /// answers the attempt as the task object holds it, whose executor is the member the control plane started it for.
  const beat = async (): Promise<PortAnswer<AttemptJSON>> => {
    const response = await taskCall(env, job.tenant, job.taskId, `${attemptPath}/heartbeat`, { method: "POST",
      body: { fence: job.fence } });
    if (!response.ok) return portRefusal(response);
    return { ok: true, value: (await response.json()) as AttemptJSON };
  };
  const heartbeat = async (): Promise<PortAnswer<{ leaseUntil: number }>> => {
    const live = await beat();
    return live.ok ? { ok: true, value: { leaseUntil: live.value.leaseUntil } } : live;
  };
  /// Where a browser control step happens, after the switches, consent and the heartbeat: the member comes from the
  /// task object's record of the attempt, never from the worker's word.
  const signInStep = async (): Promise<PortAnswer<AttemptRef>> => {
    const refused = await gate();
    if (refused) return refused;
    const live = await beat();
    if (!live.ok) return live;
    return { ok: true, value: { tenant: job.tenant, taskId: job.taskId, attemptId: job.attemptId,
      member: live.value.executorId } };
  };

  return {
    job,

    async report(events) {
      const refused = await gate();
      if (refused) return refused;
      const response = await taskCall(env, job.tenant, job.taskId, `${attemptPath}/events`, { method: "POST",
        body: { fence: job.fence, events } });
      if (!response.ok) return portRefusal(response);
      return { ok: true, value: { stored: ((await response.json()) as { stored: number }).stored } };
    },

    async heartbeat() {
      return (await gate()) ?? heartbeat();
    },

    /// One model call through the gateway, held against the shop's cap. A refusal at the cap ends the attempt with
    /// the reason `budget`: the control plane ends it, not the worker, so a worker that ignores the refusal still
    /// cannot go on.
    async callModel(request) {
      const refused = await gate();
      if (refused) return refused;
      const live = await heartbeat();
      if (!live.ok) return live;
      const result = await callModel(env, job.tenant, request, options.provider ? { provider: options.provider } : {});
      if (result.ok) {
        return { ok: true, value: { text: result.text, stopReason: result.stopReason, usage: result.usage,
          costSatang: result.costSatang } };
      }
      if (result.status === 402) {
        await endAndRecord(env, job.tenant, job.taskId, job.attemptId, { fence: job.fence, outcome: "failed",
          reason: "budget" }, { kind: "system" });
        return { ok: false, error: "budget_exceeded", ended: true };
      }
      return { ok: false, error: result.error };
    },

    /// Stops before an external write and proposes it. The control plane picks the connection whose live grant
    /// covers the target and stamps its grant revision, so the worker names only what to do; the task object then
    /// stores the exact action and opens its approval request, stamped with this attempt, in one step.
    async ask(proposed) {
      const refused = await gate(true);
      if (refused) return refused;
      const provider = PROVIDER_OF[proposed.operationType];
      if (!provider) return { ok: false, error: "unsupported_operation" };
      const grant = await liveGrant(env, job.tenant, provider, proposed.targetResourceId);
      if (grant === undefined) return { ok: false, error: "vault_unavailable" };
      if (grant === null) return { ok: false, error: "no_grant" };
      const response = await taskCall(env, job.tenant, job.taskId, `${attemptPath}/ask`, { method: "POST", body: {
        fence: job.fence,
        action: {
          connectionId: grant.id,
          providerAccountId: grant.accountId,
          operationType: proposed.operationType,
          targetResourceId: proposed.targetResourceId,
          resourceScope: [proposed.targetResourceId],
          payload: proposed.payload,
          grantRevision: grant.grantRevision,
          expiresAt: new Date(Date.now() + APPROVAL_LINK_TTL_MS).toISOString(),
        },
      } });
      if (!response.ok) return portRefusal(response);
      const { request } = (await response.json()) as { request: ApprovalRequest };
      await appendAudit(env, job.tenant, { actor: worker, action: "approval.requested",
        subject: { taskId: job.taskId, attemptId: job.attemptId, requestId: request.id, actionId: request.id },
        outcome: "ok" });
      return { ok: true, value: { requestId: request.id, kind: request.kind, revision: request.revision,
        expiresAt: new Date(request.expiresAt ?? 0).toISOString() } };
    },

    /// How the worker's request settled. An approval whose send never began (the dispatching process stopped after
    /// the decision was recorded) would otherwise wait for ever, so this read starts the send the person approved,
    /// as a read of the pilot's link does; the begin gate is one-use, so however many reads arrive, it sends once.
    async outcome(requestId) {
      const refused = await gate();
      if (refused) return refused;
      const live = await heartbeat();
      if (!live.ok) return live;
      const read = await taskCall(env, job.tenant, job.taskId, `/requests/${enc(requestId)}`);
      if (!read.ok) return portRefusal(read);
      const stored = (await read.json()) as StoredRequest;
      if (stored.action.state === "approved") await dispatchApproved(env, job.tenant, job.taskId, requestId, options);
      const action = (await readAction(env, job.tenant, job.taskId, requestId)) ?? stored.action;
      return { ok: true, value: outcomeOf(stored, action) };
    },

    /// Keeps what the worker wrote on the task for the owner to read, one draft per attempt. A draft sends nothing and
    /// asks nothing: anything that would leave the app still needs `ask` and the owner's decision.
    async draft(draft) {
      const refused = await gate();
      if (refused) return refused;
      const response = await taskCall(env, job.tenant, job.taskId, `${attemptPath}/draft`, { method: "POST",
        body: { fence: job.fence, draft } });
      if (!response.ok) return portRefusal(response);
      return { ok: true, value: (await response.json()) as DraftJSON };
    },

    /// Stops the worker until the owner answers what it asked. The attempt ends as `awaiting_owner`, so neither its
    /// lease nor its 20-minute deadline can cut the question off: the request stays open until its own expiry, and
    /// an owner who answers in an hour or a day is still heard. The worker can do nothing more in this attempt; the
    /// control plane gives it a new one to read the outcome and carry on. Refused (`nothing_waiting`) while nothing the
    /// attempt asked waits for a decision.
    async waitForOwner() {
      const ended = await endAndRecord(env, job.tenant, job.taskId, job.attemptId,
        { fence: job.fence, outcome: "awaiting_owner" }, worker);
      if (!ended.ok) return portRefusal(ended.response);
      return { ok: true, value: { outcome: "awaiting_owner" } };
    },

    async finish(outcome, reason) {
      const ended = await endAndRecord(env, job.tenant, job.taskId, job.attemptId,
        { fence: job.fence, outcome, ...(reason !== undefined ? { reason } : {}) }, worker);
      if (!ended.ok) return portRefusal(ended.response);
      return { ok: true, value: { outcome } };
    },

    /// The vault issues the grant (sign-in-vault.ts) if the member is named on a working sign-in and the outpost is
    /// online; only that outpost can redeem it, once, within a minute, with its own credential.
    async signIn(signInId, outpostId) {
      const step = await signInStep();
      return step.ok ? issueSignInGrant(env, step.value, signInId, outpostId) : step;
    },

    async signInBroken(signInId) {
      const step = await signInStep();
      return step.ok ? reportSignInBroken(env, step.value, signInId) : step;
    },
  };
}

function approvedIn(record: ApprovalRecord): boolean | undefined {
  if (record.status !== "decided") return undefined;
  return record.request.options.find((option) => option.id === record.decision.optionId)?.effect === "approve";
}

function outcomeOf(stored: StoredRequest, action: ActionProposalJSON): RequestOutcome {
  const approved = approvedIn(stored.record);
  return {
    standing: stored.standing.state,
    reason: stored.standing.reason,
    ...(approved !== undefined ? { approved } : {}),
    action: action.state,
    ...(action.dispatch?.providerOperationId ? { providerOperationId: action.dispatch.providerOperationId } : {}),
  };
}

export type DecisionInput = {
  tenant: string;
  taskId: string;
  requestId: string;
  optionId: string;
  seenRevision: number;
  /// Who is deciding: an account or device id. The role is the control plane's to set from who that is, never a
  /// client's word (approval-core's `Decision`).
  decidedBy: string;
  role: Role;
};

/// The code an audit entry gives a refused decision: approval-core's refusal, or for a superseded request, why.
function refusalReason(result: Exclude<DecideResult, { ok: true }>): string {
  return result.refused === "superseded" ? result.reason : result.refused;
}

/// A person's decision on a worker's request. The switches and consent are read first, as the pilot's link reads
/// them: any decision needs `officeCloud`, and approving needs `officeExternalWrites` and the owner's consent, all
/// before anything is recorded. approval-core then settles the request once in the task object (who may decide,
/// whether its attempt still runs, expiry, revision), and an approval goes straight to the broker's one dispatch.
/// Answers approval-core's result and where the action stands after it.
export async function decideRequest(
  env: JobFlowEnv,
  input: DecisionInput,
  options: JobOptions,
): Promise<{ ok: true; result: DecideResult; action: ActionProposalJSON["state"] } | Refused> {
  const { tenant, taskId, requestId } = input;
  const approving = JOB_REQUEST_OPTIONS.find((option) => option.id === input.optionId)?.effect === "approve";
  const current = await options.flags();
  if (!current.officeCloud) return { ok: false, status: 403, error: "feature_disabled", feature: "officeCloud" };
  if (approving) {
    if (!current.officeExternalWrites) {
      return { ok: false, status: 403, error: "feature_disabled", feature: "officeExternalWrites" };
    }
    if (!(await consented(env, tenant))) return { ok: false, status: 403, error: "consent_required" };
  }
  const response = await taskCall(env, tenant, taskId, `/requests/${enc(requestId)}/decision`, { method: "POST", body: {
    optionId: input.optionId,
    seenRevision: input.seenRevision,
    decidedBy: input.decidedBy,
    role: input.role,
  } });
  if (response.status === 404) return { ok: false, status: 404, error: "not_found" };
  if (!response.ok) return { ok: false, status: 503, error: await errorOf(response, "decision_unavailable") };
  const decided = (await response.json()) as { result: DecideResult; record: ApprovalRecord; action: ActionProposalJSON };
  const { result, record } = decided;
  const actor: AuditActor = input.role === "owner" ? { kind: "owner", id: input.decidedBy } :
    { kind: "helper", id: input.decidedBy };
  await appendAudit(env, tenant, {
    actor,
    action: "approval.decided",
    subject: { taskId, ...(record.request.attemptId ? { attemptId: record.request.attemptId } : {}), requestId,
      actionId: requestId },
    outcome: result.ok ? (approvedIn(record) ? "approved" : "declined") : "refused",
    ...(result.ok ? {} : { reason: refusalReason(result) }),
  });
  const action = result.ok && decided.action.state === "approved"
    ? await dispatchApproved(env, tenant, taskId, requestId, options)
    : decided.action.state;
  return { ok: true, result, action };
}

/// Sends an approved action once, through the broker: the begin gate moves it to dispatching exactly once and hands
/// over the approved copy, and the finish half re-checks the live grant, takes the credential from the vault and
/// settles it confirmed, failed or unknown. Any other state answers as it is, so a retry after a crash, at any
/// point, never sends twice. The switches and consent are read again first; while they forbid it the action stays
/// approved for a later try.
export async function dispatchApproved(
  env: JobFlowEnv,
  tenant: string,
  taskId: string,
  actionId: string,
  options: JobOptions,
): Promise<ActionProposalJSON["state"]> {
  const current = await readAction(env, tenant, taskId, actionId);
  if (!current) return "unknown";
  if (current.state !== "approved") return current.state;
  if (await workGate(env, tenant, options.flags, true)) return current.state;
  const dispatch = { tenant, grantRevision: current.grantRevision,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  // A begin that cannot be reached leaves the action approved, and the next read or retry begins it. A finish that
  // stops part way leaves it dispatching, which the task object settles as unknown once it is too old to be running.
  const begun = await beginDispatchAction(env, taskId, actionId, dispatch).catch(() => null);
  if (begun?.ok) {
    await finishDispatchAction(env, taskId, actionId, { ...dispatch, proposal: begun.proposal }).catch(() => null);
  }
  return (await readAction(env, tenant, taskId, actionId))?.state ?? current.state;
}

/// Ends every attempt of the task that stopped reporting or ran out of time, and records each with the requests it
/// superseded. Decisions on those requests are refused from the moment the lease lapses, whether or not this has
/// run; this writes the end down. Throws when the task object cannot be reached, so a scheduler retries.
export async function endSilentAttempts(env: JobFlowEnv, tenant: string, taskId: string): Promise<{ ended: string[] }> {
  const response = await taskCall(env, tenant, taskId, "/attempts/sweep", { method: "POST", control: true });
  if (!response.ok) throw new Error(`sweep_unavailable_${response.status}`);
  const { ended } = (await response.json()) as { ended: { attempt: AttemptJSON; superseded: string[] }[] };
  for (const entry of ended) await recordEnded(env, tenant, taskId, entry, { kind: "system" });
  return { ended: ended.map((entry) => entry.attempt.id) };
}

/// Stops an attempt on behalf of `actor` (the owner, an operator, or the system), whatever its worker is doing.
export async function cancelAttempt(
  env: JobFlowEnv,
  tenant: string,
  taskId: string,
  attemptId: string,
  actor: AuditActor,
): Promise<{ ok: true; attempt: AttemptJSON; superseded: string[] } | { ok: false; error: string }> {
  const ended = await endAndRecord(env, tenant, taskId, attemptId, { outcome: "cancelled" }, actor);
  if (!ended.ok) return { ok: false, error: await errorOf(ended.response, "unavailable") };
  return { ok: true, attempt: ended.attempt, superseded: ended.superseded };
}
