import { adminFetch, trustedTaskPut } from "./authenticated-fixtures";
import { env } from "cloudflare:test";
import type { ApprovalRecord, Standing } from "@manut/approval-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import type { AuditEntry } from "../src/audit-log";
import { beginDispatchAction } from "../src/broker-actions";
import { bangkokMonth } from "../src/model-price";
import {
  cancelAttempt,
  decideRequest,
  dispatchApproved,
  endSilentAttempts,
  startAttempt,
  workerPort,
  type Job,
  type JobFlags,
} from "../src/job-flow";
import type { ActionProposalJSON, AttemptJSON, TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";
import { FUTURE_EVENT, STAND_IN_MODEL, StandInWorker, type Script } from "./stand-in-worker";

// The Phase 2 gate, as a test: the whole job flow end to end with a stand-in worker, in real workerd against the
// real objects (docs/phase-0-spikes.md, section 3). The control plane gives the worker one attempt; the worker reports
// agent events, calls a model only through the gateway (the stand-in provider, metered against the shop's cap), and
// stops before its one external write to ask for it; the owner decides once through approval-core; the broker sends
// it once with the vault's credential to a provider whose fetch is a stub; and the attempt ends.
//
// The global fetch answers 599 for the whole file, so nothing here can reach a network: the provider is only ever
// reached through the stub each test hands the broker.

const bindings = env as unknown as Env;
/// The gateway's stand-in provider, as `MODEL_PROVIDER=stand-in` sets it for local runs.
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const VAULT_TOKEN = "linear-vault-token-for-the-gate";
const PROJECT = "ws/shop-issues";
const SCRIPT: Script = {
  issue: { projectId: PROJECT, title: "Late parcel for order SP-2291", description: "Customer still waiting." },
};
const GOAL = "File an issue for the late parcel on order SP-2291.";
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// Linear's GraphQL answer to an issue create, counted, with every call kept so a test can read what was sent.
function linearStub() {
  const calls: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body ?? "null")) });
    return Response.json({ data: { issueCreate: { success: true, issue: { id: "lin-7", identifier: "SHOP-7",
      title: SCRIPT.issue.title, url: "https://linear.app/shop/issue/SHOP-7" } } } });
  };
  return { calls, fetchImpl };
}

type Shop = { tenant: string; taskId: string; connectionId: string };

/// A shop with consent given, one draft task whose objective is the goal, indexed for export and deletion, and a
/// Linear connection in its vault whose grant covers the project and allows actions.
async function shop(options: { consent?: boolean } = {}): Promise<Shop> {
  const tenant = fresh("job:shop");
  const taskId = fresh("job-task");
  if (options.consent !== false) {
    expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
  }
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Late parcel", objective: GOAL, state: "draft",
    location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, tenant)).status).toBe(200);
  const stored = await adminFetch("https://api.manut.test/v1/admin/connections", { method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tenant, provider: "linear", accountId: "workspace-shop", scopes: ["write"],
      refreshToken: VAULT_TOKEN, resourceIds: [PROJECT], allowsActions: true }) });
  expect(stored.status).toBe(200);
  return { tenant, taskId, connectionId: ((await stored.json()) as { id: string }).id };
}

async function job(s: Shop): Promise<Job> {
  const started = await startAttempt(flowEnv, { tenant: s.tenant, taskId: s.taskId, executorId: "stand-in" }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  return started.job;
}

function task(s: Shop) {
  return bindings.TASK.get(bindings.TASK.idFromName(s.taskId));
}

async function taskExport(s: Shop) {
  const response = await task(s).fetch(new Request("https://task/export", { headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { events: TaskEventJSON[]; actions: ActionProposalJSON[]; attempts: AttemptJSON[];
    requests: ApprovalRecord[] };
}

async function request(s: Shop, requestId: string) {
  const response = await task(s).fetch(new Request(`https://task/requests/${requestId}`, {
    headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { record: ApprovalRecord; standing: Standing; action: ActionProposalJSON };
}

const owner = (s: Shop, requestId: string, optionId = "approve") =>
  ({ tenant: s.tenant, taskId: s.taskId, requestId, optionId, seenRevision: 1, decidedBy: "owner-phone-1",
    role: "owner" as const });

async function audit(s: Shop) {
  const response = await tenantCall(bindings, s.tenant, `/audit?tenant=${encodeURIComponent(s.tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
}

describe("the job flow end to end", () => {
  it("runs one attempt from the goal to one approved write, sent once with the vault's credential", async () => {
    const s = await shop();
    const linear = linearStub();
    const j = await job(s);
    expect(j).toEqual({ tenant: s.tenant, taskId: s.taskId, attemptId: expect.any(String), fence: expect.any(String),
      goal: GOAL, capSatang: 20000, deadline: expect.any(String) });
    expect(Date.parse(j.deadline) - Date.now()).toBeGreaterThan(19 * 60 * 1000);

    const worker = new StandInWorker(workerPort(flowEnv, j, { flags: on, fetchImpl: linear.fetchImpl }), SCRIPT);
    const started = await worker.start();
    expect(started).toEqual({ asked: true, requestId: expect.any(String) });
    const requestId = worker.requestId!;

    // The request is approval-core's, stamped with the attempt, naming the exact action, of the owner-only kind for a
    // write to the shop's own systems. Nothing has been sent.
    const asked = await request(s, requestId);
    expect(asked.record).toMatchObject({ status: "pending", request: { id: requestId, kind: "command", revision: 1,
      attemptId: j.attemptId, detail: { actionId: requestId, operationType: "linear.issue.create",
        payloadHash: asked.action.payloadHash } } });
    expect(asked.standing).toEqual({ state: "open", reason: "waiting" });
    expect(asked.action).toMatchObject({ state: "proposed", connectionId: s.connectionId, targetResourceId: PROJECT,
      providerAccountId: "workspace-shop", payload: { title: SCRIPT.issue.title } });
    expect(linear.calls).toHaveLength(0);

    const decided = await decideRequest(flowEnv, owner(s, requestId), { flags: on, fetchImpl: linear.fetchImpl });
    expect(decided).toEqual({ ok: true, result: { ok: true, decision: expect.objectContaining({ optionId: "approve",
      role: "owner", decidedBy: "owner-phone-1" }) }, action: "confirmed" });
    expect(linear.calls).toEqual([{ url: "https://api.linear.app/graphql", authorization: `Bearer ${VAULT_TOKEN}`,
      body: expect.objectContaining({ variables: { input: { title: SCRIPT.issue.title,
        description: SCRIPT.issue.description, projectId: PROJECT } } }) }]);

    expect(await worker.resume()).toEqual({ finished: "done", outcome: "filed" });

    // What the worker ever held: its job and the port's answers. Never the credential the broker sent with.
    expect(JSON.stringify([j, worker.heard])).not.toContain(VAULT_TOKEN);

    const exported = await taskExport(s);
    // Every agent event, in the order reported, kept exactly as it arrived, the unknown kind included.
    const reported = exported.events.filter((event) => event.kind === "agent");
    expect(reported.map((event) => event.event)).toEqual([
      { type: "turnStarted", providerTurnID: "turn-1" },
      { type: "messageCompleted", id: "draft-1", text: `Stand-in reply to: ${GOAL}` },
      { type: "spend", tokens: expect.any(Number), model: STAND_IN_MODEL },
      FUTURE_EVENT,
      { type: "messageCompleted", id: "result-1", text: "Filed the issue." },
      { type: "turnCompleted", status: "completed" },
    ]);
    expect(reported.every((event) => event.attemptId === j.attemptId)).toBe(true);
    expect(exported.attempts).toEqual([expect.objectContaining({ id: j.attemptId, status: "done", outcome: "done" })]);
    expect(exported.actions).toEqual([expect.objectContaining({ id: requestId, state: "confirmed",
      dispatch: expect.objectContaining({ providerOperationId: "lin-7" }) })]);
    expect(exported.requests).toEqual([expect.objectContaining({ status: "decided" })]);

    // The one model call was metered against the shop's cap.
    const usage = await tenantCall(bindings, s.tenant,
      `/model/usage?tenant=${encodeURIComponent(s.tenant)}&month=${bangkokMonth(Date.now())}`);
    expect(((await usage.json()) as { totals: { ok: number } }).totals.ok).toBe(1);

    const system = { kind: "system" };
    const worker1 = { kind: "worker", attemptId: j.attemptId };
    const about = { taskId: s.taskId, attemptId: j.attemptId, requestId, actionId: requestId };
    expect((await audit(s)).filter((entry) => entry.action !== "consent.given")).toEqual([
      { actor: system, action: "attempt.started", subject: { taskId: s.taskId, attemptId: j.attemptId }, outcome: "ok" },
      { actor: worker1, action: "approval.requested", subject: about, outcome: "ok" },
      { actor: { kind: "owner", id: "owner-phone-1" }, action: "approval.decided", subject: about, outcome: "approved" },
      { actor: system, action: "dispatch.started", subject: { taskId: s.taskId, actionId: requestId }, outcome: "ok" },
      { actor: system, action: "dispatch.settled", subject: { taskId: s.taskId, actionId: requestId },
        outcome: "confirmed" },
      { actor: worker1, action: "attempt.ended", subject: { taskId: s.taskId, attemptId: j.attemptId }, outcome: "done" },
    ]);
  });

  it("lets the right role decide once: a helper may not decide a command, and a second decision is refused", async () => {
    const s = await shop();
    const linear = linearStub();
    const worker = new StandInWorker(workerPort(flowEnv, await job(s), { flags: on, fetchImpl: linear.fetchImpl }), SCRIPT);
    await worker.start();
    const requestId = worker.requestId!;

    const helper = await decideRequest(flowEnv, { ...owner(s, requestId), decidedBy: "staff-2", role: "helper" },
      { flags: on, fetchImpl: linear.fetchImpl });
    expect(helper).toEqual({ ok: true, result: { ok: false, refused: "not_permitted" }, action: "proposed" });
    expect((await decideRequest(flowEnv, owner(s, requestId), { flags: on, fetchImpl: linear.fetchImpl })).ok).toBe(true);
    for (const optionId of ["approve", "decline"]) {
      const again = await decideRequest(flowEnv, owner(s, requestId, optionId), { flags: on, fetchImpl: linear.fetchImpl });
      expect(again).toEqual({ ok: true, result: { ok: false, refused: "already_decided",
        decision: expect.objectContaining({ optionId: "approve" }) }, action: "confirmed" });
    }
    expect(linear.calls).toHaveLength(1);
    const refusals = (await audit(s)).filter((entry) => entry.action === "approval.decided").map((entry) =>
      [entry.actor, entry.outcome, entry.reason]);
    expect(refusals).toEqual([
      [{ kind: "helper", id: "staff-2" }, "refused", "not_permitted"],
      [{ kind: "owner", id: "owner-phone-1" }, "approved", undefined],
      [{ kind: "owner", id: "owner-phone-1" }, "refused", "already_decided"],
      [{ kind: "owner", id: "owner-phone-1" }, "refused", "already_decided"],
    ]);
  });

  it("refuses a decision for an attempt that has ended, and sends nothing", async () => {
    const s = await shop();
    const linear = linearStub();
    const j = await job(s);
    const port = workerPort(flowEnv, j, { flags: on, fetchImpl: linear.fetchImpl });
    const worker = new StandInWorker(port, SCRIPT);
    await worker.start();
    const requestId = worker.requestId!;
    // The worker gives up before anyone answers.
    expect(await port.finish("failed", "gave_up")).toEqual({ ok: true, value: { outcome: "failed" } });

    const late = await decideRequest(flowEnv, owner(s, requestId), { flags: on, fetchImpl: linear.fetchImpl });
    expect(late).toEqual({ ok: true, result: { ok: false, refused: "superseded", reason: "attempt_ended" },
      action: "proposed" });
    expect((await request(s, requestId)).standing).toEqual({ state: "superseded", reason: "attempt_ended" });
    expect(linear.calls).toHaveLength(0);
    // The old route for deciding an action cannot decide one that belongs to an approval request.
    const bypass = await task(s).fetch(new Request(`https://task/actions/${requestId}/decision`, { method: "POST",
      headers: { "content-type": "application/json", "x-tenant": s.tenant },
      body: JSON.stringify({ approve: true, by: "anyone" }) }));
    expect(bypass.status).toBe(409);
    expect(await bypass.json()).toEqual({ error: "decide_by_request" });
    expect((await request(s, requestId)).action.state).toBe("proposed");

    const ended = (await audit(s)).filter((entry) => ["attempt.ended", "approval.superseded", "approval.decided"]
      .includes(entry.action));
    expect(ended).toEqual([
      { actor: { kind: "worker", attemptId: j.attemptId }, action: "attempt.ended",
        subject: { taskId: s.taskId, attemptId: j.attemptId }, outcome: "failed", reason: "gave_up" },
      { actor: { kind: "system" }, action: "approval.superseded",
        subject: { taskId: s.taskId, attemptId: j.attemptId, requestId, actionId: requestId }, outcome: "superseded",
        reason: "attempt_ended" },
      { actor: { kind: "owner", id: "owner-phone-1" }, action: "approval.decided",
        subject: { taskId: s.taskId, attemptId: j.attemptId, requestId, actionId: requestId }, outcome: "refused",
        reason: "attempt_ended" },
    ]);
  });

  it("ends the attempt with the reason budget when the gateway refuses past the shop's cap", async () => {
    const s = await shop();
    expect((await tenantCall(bindings, s.tenant, "/model/cap", { method: "POST",
      headers: { "content-type": "application/json", "x-model": "1" },
      body: JSON.stringify({ tenant: s.tenant, capSatang: 0, setBy: null }) })).status).toBe(200);
    const j = await job(s);
    expect(j.capSatang).toBe(0);
    const port = workerPort(flowEnv, j, { flags: on });
    const worker = new StandInWorker(port, SCRIPT);
    expect(await worker.start()).toEqual({ asked: false, stoppedBy: "budget_exceeded", ended: true });
    // The attempt is over: the worker can no longer report, ask or spend.
    expect(await port.report([{ type: "turnStarted" }])).toEqual({ ok: false, error: "stale_attempt", ended: true });
    expect((await port.ask({ operationType: "linear.issue.create", targetResourceId: PROJECT,
      payload: { title: "t" } })).ok).toBe(false);
    expect((await taskExport(s)).attempts).toEqual([expect.objectContaining({ id: j.attemptId, status: "done",
      outcome: "failed", reason: "budget" })]);
    expect((await taskExport(s)).requests).toEqual([]);
    expect((await audit(s)).filter((entry) => entry.action === "attempt.ended")).toEqual([
      { actor: { kind: "system" }, action: "attempt.ended", subject: { taskId: s.taskId, attemptId: j.attemptId },
        outcome: "failed", reason: "budget" },
    ]);
    const usage = await tenantCall(bindings, s.tenant,
      `/model/usage?tenant=${encodeURIComponent(s.tenant)}&month=${bangkokMonth(Date.now())}`);
    expect(((await usage.json()) as { totals: { refused: number; ok: number } }).totals).toMatchObject({ refused: 1, ok: 0 });
  });

  it("dispatches once when a send is retried after a crash, whenever the crash came", async () => {
    // A crash before the send began: the decision is recorded, the begin gate never reached.
    const s = await shop();
    const linear = linearStub();
    const worker = new StandInWorker(workerPort(flowEnv, await job(s), { flags: on, fetchImpl: linear.fetchImpl }), SCRIPT);
    await worker.start();
    const requestId = worker.requestId!;
    const crashed = await decideRequest(failingBegin(1), owner(s, requestId), { flags: on, fetchImpl: linear.fetchImpl });
    expect(crashed).toMatchObject({ ok: true, result: { ok: true }, action: "approved" });
    expect(linear.calls).toHaveLength(0);
    // The worker's next read of its request starts the send the owner approved, once.
    expect(await worker.resume()).toEqual({ finished: "done", outcome: "filed" });
    expect(linear.calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      expect(await dispatchApproved(flowEnv, s.tenant, s.taskId, requestId, { flags: on, fetchImpl: linear.fetchImpl }))
        .toBe("confirmed");
    }
    expect(linear.calls).toHaveLength(1);

    // A crash after the send began: nothing settled it. A retry never sends again; once the send is too old to be
    // running, it settles unknown for a person to check, still sent at most once.
    const t = await shop();
    const second = linearStub();
    const other = new StandInWorker(workerPort(flowEnv, await job(t), { flags: on, fetchImpl: second.fetchImpl }), SCRIPT);
    await other.start();
    const otherId = other.requestId!;
    expect((await decideRequest(failingBegin(1), owner(t, otherId), { flags: on, fetchImpl: second.fetchImpl })).ok)
      .toBe(true);
    const begun = await beginDispatchAction(bindings, t.taskId, otherId, { tenant: t.tenant, grantRevision: 1 });
    expect(begun.ok).toBe(true);
    expect(await dispatchApproved(flowEnv, t.tenant, t.taskId, otherId, { flags: on, fetchImpl: second.fetchImpl }))
      .toBe("dispatching");
    expect(await other.resume()).toEqual({ waiting: "dispatching" });
    const later = Date.now() + 6 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await dispatchApproved(flowEnv, t.tenant, t.taskId, otherId, { flags: on, fetchImpl: second.fetchImpl }))
      .toBe("unknown");
    expect(second.calls).toHaveLength(0);
  });

  it("ends a worker that stops reporting and supersedes what it asked", async () => {
    const s = await shop();
    const linear = linearStub();
    const j = await job(s);
    const worker = new StandInWorker(workerPort(flowEnv, j, { flags: on, fetchImpl: linear.fetchImpl }), SCRIPT);
    await worker.start();
    const requestId = worker.requestId!;
    // Six minutes of silence: the five-minute lease lapsed with nothing reported.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);
    // Already before the sweep, the attempt is no longer running, so its request cannot be decided.
    expect((await decideRequest(flowEnv, owner(s, requestId), { flags: on, fetchImpl: linear.fetchImpl })))
      .toEqual({ ok: true, result: { ok: false, refused: "superseded", reason: "attempt_ended" }, action: "proposed" });
    expect(await endSilentAttempts(flowEnv, s.tenant, s.taskId)).toEqual({ ended: [j.attemptId] });
    expect(await endSilentAttempts(flowEnv, s.tenant, s.taskId)).toEqual({ ended: [] });
    expect((await request(s, requestId)).standing).toEqual({ state: "superseded", reason: "attempt_ended" });
    expect((await taskExport(s)).attempts).toEqual([expect.objectContaining({ id: j.attemptId, status: "done",
      outcome: "failed", reason: "silent" })]);
    // The worker coming back finds its attempt gone.
    expect(await worker.resume()).toEqual({ stoppedBy: "stale_attempt" });
    expect(linear.calls).toHaveLength(0);
    expect((await audit(s)).filter((entry) => ["attempt.ended", "approval.superseded"].includes(entry.action)))
      .toEqual([
        { actor: { kind: "system" }, action: "attempt.ended", subject: { taskId: s.taskId, attemptId: j.attemptId },
          outcome: "failed", reason: "silent" },
        { actor: { kind: "system" }, action: "approval.superseded",
          subject: { taskId: s.taskId, attemptId: j.attemptId, requestId, actionId: requestId }, outcome: "superseded",
          reason: "attempt_ended" },
      ]);
  });

  it("ends an attempt the control plane cancels, and the worker can do nothing more", async () => {
    const s = await shop();
    const j = await job(s);
    const port = workerPort(flowEnv, j, { flags: on });
    expect(await cancelAttempt(flowEnv, s.tenant, s.taskId, j.attemptId, { kind: "operator", email: "ops@manut.test" }))
      .toEqual({ ok: true, attempt: expect.objectContaining({ outcome: "cancelled" }), superseded: [] });
    expect(await port.heartbeat()).toEqual({ ok: false, error: "stale_attempt", ended: true });
    expect((await audit(s)).filter((entry) => entry.action === "attempt.ended")).toEqual([
      { actor: { kind: "operator", email: "ops@manut.test" }, action: "attempt.ended",
        subject: { taskId: s.taskId, attemptId: j.attemptId }, outcome: "cancelled" },
    ]);
  });
});

describe("the job flow's gates", () => {
  it("keeps the backend's kill switches and the owner's consent", async () => {
    const s = await shop();
    const off: JobFlags = async () => ({ officeCloud: false, officeExternalWrites: true });
    expect(await startAttempt(flowEnv, { tenant: s.tenant, taskId: s.taskId, executorId: "stand-in" }, { flags: off }))
      .toEqual({ ok: false, status: 403, error: "feature_disabled", feature: "officeCloud" });
    const quiet = await shop({ consent: false });
    expect(await startAttempt(flowEnv, { tenant: quiet.tenant, taskId: quiet.taskId, executorId: "stand-in" },
      { flags: on })).toEqual({ ok: false, status: 403, error: "consent_required" });

    const linear = linearStub();
    const j = await job(s);
    const worker = new StandInWorker(workerPort(flowEnv, j, { flags: on, fetchImpl: linear.fetchImpl }), SCRIPT);
    await worker.start();
    const noWrites: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: false });
    expect(await decideRequest(flowEnv, owner(s, worker.requestId!), { flags: noWrites, fetchImpl: linear.fetchImpl }))
      .toEqual({ ok: false, status: 403, error: "feature_disabled", feature: "officeExternalWrites" });
    // Withdrawing consent stops continuing work: the worker's next report is refused, and approving sends nothing.
    expect((await tenantCall(bindings, s.tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: s.tenant, cloudWork: false }) })).status).toBe(200);
    expect(await workerPort(flowEnv, j, { flags: on }).report([{ type: "turnStarted" }]))
      .toEqual({ ok: false, error: "consent_required" });
    expect(await decideRequest(flowEnv, owner(s, worker.requestId!), { flags: on, fetchImpl: linear.fetchImpl }))
      .toEqual({ ok: false, status: 403, error: "consent_required" });
    expect(linear.calls).toHaveLength(0);
  });

  it("asks only through a live grant that covers the target, chosen by the control plane", async () => {
    const s = await shop();
    const port = workerPort(flowEnv, await job(s), { flags: on });
    expect(await port.ask({ operationType: "linear.issue.create", targetResourceId: "ws/someone-else",
      payload: { title: "t" } })).toEqual({ ok: false, error: "no_grant" });
    expect(await port.ask({ operationType: "line.message.push", targetResourceId: PROJECT,
      payload: { text: "hi" } })).toEqual({ ok: false, error: "unsupported_operation" });
    expect((await taskExport(s)).requests).toEqual([]);
  });

  it("keeps only events it can store whole, and refuses a report that is not events", async () => {
    const s = await shop();
    const port = workerPort(flowEnv, await job(s), { flags: on });
    for (const events of [[], [{ id: "no-type" }], ["turnStarted"], [{ type: 7 }],
      [{ type: "messageCompleted", id: "m", text: "x".repeat(9 * 1024) }]]) {
      expect(await port.report(events)).toEqual({ ok: false, error: "invalid_request" });
    }
    expect((await taskExport(s)).events.filter((event) => event.kind === "agent")).toEqual([]);
  });
});

/// The Worker's environment with the task object's begin gate unreachable the next `times` times, as when the process
/// dispatching crashed between recording the decision and starting the send.
function failingBegin(times: number): Env & { MODEL_PROVIDER: string } {
  let left = times;
  const namespace = bindings.TASK;
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.method === "POST" && new URL(request.url).pathname.endsWith("/begin") && left > 0) {
            left--;
            throw new Error("fixture_crash_before_begin");
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...flowEnv, TASK: wrapped };
}

