import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import {
  decodeRecord,
  decodeStanding,
  encodeRecord,
  encodeStanding,
  type ApprovalRecord,
  type Standing,
} from "@manut/approval-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import type { ActionProposalJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";
import { adminFetch, tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { sourceWorker } from "./source-worker";

// Approvals for a session (docs/pilot-api.md, "Approvals for a session"): `GET /v1/approvals` lists the signed-in
// tenant's approval-core records, open or recent, each with where it stands, as approval-core's wire JSON, through the
// real Worker and objects. Reading only. One tenant never sees another's, whatever its own index holds.
//
// The global fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const BOT = `U${"3".repeat(32)}`;
const CUSTOMER = `U${"4".repeat(32)}`;
const PROJECT = "ws/approvals-route";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Listed = { taskId: string; record: Record<string, unknown> & { request: Record<string, unknown> };
  standing: Record<string, unknown> };

/// A signed-in tenant of its own, with cloud-work consent given.
async function session(): Promise<{ tenant: string; headers: { authorization: string } }> {
  const tenant = `approvals:${crypto.randomUUID()}`;
  return { tenant, headers: await tenantSession(tenant) };
}

/// A draft task the tenant owns, in its index as `POST /v1/tasks` leaves one.
async function ownTask(tenant: string): Promise<string> {
  const taskId = `approvals-task-${crypto.randomUUID()}`;
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Replies", objective: "Answer customers", state: "draft",
    location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, tenant)).status)
    .toBe(200);
  return taskId;
}

function task(taskId: string) {
  return bindings.TASK.get(bindings.TASK.idFromName(taskId));
}

async function proposeOn(tenant: string, taskId: string, body: Record<string, unknown>): Promise<ActionProposalJSON> {
  const response = await task(taskId).fetch(new Request("https://task/actions", { method: "POST",
    headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify({
      connectionId: "conn-approvals", providerAccountId: "acct-approvals", grantRevision: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...body }) }));
  expect(response.status).toBe(200);
  return (await response.json()) as ActionProposalJSON;
}

/// A LINE reply proposed on the task, which opens its approval-core request.
function proposeReply(tenant: string, taskId: string, text: string) {
  return proposeOn(tenant, taskId, { operationType: "line.message.push", targetResourceId: BOT, resourceScope: [BOT],
    payload: { text }, recipients: [CUSTOMER] });
}

/// A plain proposal a session's propose route makes for anything but a reply: no approval-core request decides it.
function proposePlainIssue(tenant: string, taskId: string) {
  return proposeOn(tenant, taskId, { operationType: "linear.issue.create", targetResourceId: PROJECT,
    resourceScope: [PROJECT], payload: { title: "Not an approval-core request" } });
}

/// A worker's attempt on the task, through the job flow, which asks for one write to the shop's tracker.
async function workerAsks(tenant: string, taskId: string): Promise<{ port: WorkerPort; requestId: string }> {
  const connected = await adminFetch("https://api.manut.test/v1/admin/connections", { method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tenant, provider: "linear", accountId: "workspace-approvals", scopes: ["write"],
      refreshToken: "linear-vault-token-approvals", resourceIds: [PROJECT], allowsActions: true }) });
  expect(connected.status).toBe(200);
  const started = await startAttempt(flowEnv, { tenant, taskId, executorId: "stand-in" }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  const port = workerPort(flowEnv, started.job, { flags: on });
  const asked = await port.ask({ operationType: "linear.issue.create", targetResourceId: PROJECT,
    payload: { title: "Late parcel" } });
  if (!asked.ok) throw new Error(`not_asked_${asked.error}`);
  return { port, requestId: asked.value.requestId };
}

async function decide(tenant: string, taskId: string, requestId: string, optionId = "approve") {
  const response = await task(taskId).fetch(new Request(`https://task/requests/${requestId}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ optionId, seenRevision: 1, decidedBy: "owner-phone-1", role: "owner" }) }));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
}

async function storedRequest(tenant: string, taskId: string, requestId: string) {
  const response = await task(taskId).fetch(new Request(`https://task/requests/${requestId}`,
    { headers: { "x-tenant": tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { record: ApprovalRecord; standing: Standing };
}

async function list(headers: Record<string, string>, query: string, target?: Env) {
  const url = `https://api.manut.test/v1/approvals${query ? `?${query}` : ""}`;
  let response: Response;
  if (target) {
    const request = new Request(url, { headers });
    request.headers.set("cf-connecting-ip", "2001:db8::51");
    const context = createExecutionContext();
    response = await worker.fetch(request, target, context);
    await waitOnExecutionContext(context);
  } else {
    response = await sourceWorker.fetch(url, { headers });
  }
  return { status: response.status, body: (await response.json()) as { state?: string; approvals: Listed[];
    error?: string } };
}

const ids = (approvals: Listed[]) => approvals.map((item) => item.record.request.id);

describe("GET /v1/approvals", () => {
  it("lists the session's open approvals as approval-core wire records, each kind from its operation", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const reply = await proposeReply(tenant, taskId, "ได้ค่ะ");
    await proposePlainIssue(tenant, taskId);
    const { requestId } = await workerAsks(tenant, taskId);

    const listed = await list(headers, "state=open");
    expect(listed.status).toBe(200);
    expect(listed.body.state).toBe("open");
    expect(ids(listed.body.approvals).sort()).toEqual([reply.id, requestId].sort());
    for (const item of listed.body.approvals) {
      expect(item.taskId).toBe(taskId);
      // approval-core's wire JSON: its decoders read each one back exactly.
      expect(encodeRecord(decodeRecord(item.record))).toEqual(item.record);
      expect(encodeStanding(decodeStanding(item.standing))).toEqual(item.standing);
      expect(item.standing).toEqual({ state: "open", reason: "waiting" });
    }
    const byId = new Map(listed.body.approvals.map((item) => [item.record.request.id, item]));
    expect(byId.get(reply.id)!.record).toEqual(
      encodeRecord(decodeRecord((await storedRequest(tenant, taskId, reply.id)).record)));
    expect(byId.get(reply.id)!.record).toMatchObject({ status: "pending", request: { kind: "reply", revision: 1,
      detail: { operationType: "line.message.push", recipient: CUSTOMER, text: "ได้ค่ะ" } } });
    expect(byId.get(requestId)!.record).toMatchObject({ status: "pending", request: { kind: "command",
      attemptId: expect.any(String), detail: { operationType: "linear.issue.create" } } });
    // Nothing has left open yet.
    expect((await list(headers, "state=recent")).body).toEqual({ state: "recent", approvals: [] });
  });

  it("moves each approval to recent once it is decided, expires or is superseded, saying which", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const decided = await proposeReply(tenant, taskId, "ส่งแล้วค่ะ");
    const lapsing = await proposeOn(tenant, taskId, { operationType: "line.message.push", targetResourceId: BOT,
      resourceScope: [BOT], payload: { text: "ยังมีค่ะ" }, recipients: [CUSTOMER],
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const open = await proposeReply(tenant, taskId, "รอสักครู่ค่ะ");
    const { port, requestId } = await workerAsks(tenant, taskId);
    await decide(tenant, taskId, decided.id);
    // The worker gives up before anyone answers its request.
    expect((await port.finish("failed", "gave_up")).ok).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(lapsing.expiresAt) + 1000);

    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([open.id]);
    const recent = (await list(headers, "state=recent")).body.approvals;
    const standing = new Map(recent.map((item) => [item.record.request.id, item.standing]));
    expect([...standing.keys()].sort()).toEqual([decided.id, lapsing.id, requestId].sort());
    expect(standing.get(decided.id)).toEqual({ state: "decided", reason: "decided", decision: { requestId: decided.id,
      optionId: "approve", seenRevision: 1, decidedBy: "owner-phone-1", role: "owner", decidedAt: expect.any(Number) } });
    expect(standing.get(lapsing.id)).toEqual({ state: "expired", reason: "expired",
      expiredAt: Date.parse(lapsing.expiresAt) });
    expect(standing.get(requestId)).toEqual({ state: "superseded", reason: "attempt_ended" });
    expect(recent.find((item) => item.record.request.id === decided.id)!.record.status).toBe("decided");
  });

  it("lists recent approvals newest asked first, then by id, as many as the limit asks", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const made: { id: string; createdAt: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const reply = await proposeReply(tenant, taskId, `reply ${i}`);
      await decide(tenant, taskId, reply.id, "decline");
      made.push({ id: reply.id, createdAt: (await storedRequest(tenant, taskId, reply.id)).record.request.createdAt });
    }
    // The clock in workerd moves only with I/O, so two requests may share a millisecond; the id then orders them.
    const expected = [...made].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).map((m) => m.id);
    expect(ids((await list(headers, "state=recent")).body.approvals)).toEqual(expected);
    expect(ids((await list(headers, "state=recent&limit=2")).body.approvals)).toEqual(expected.slice(0, 2));
  });

  it("lists a reply stored before replies had requests as the request it would have opened", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const reply = await proposeReply(tenant, taskId, "เปิดค่ะ");
    await runInDurableObject(task(taskId), async (_instance, state) => {
      const { requestId: _dropped, ...old } = (await state.storage.get<ActionProposalJSON>(`action:${reply.id}`))!;
      await state.storage.put(`action:${reply.id}`, old);
      await state.storage.delete(`request:${reply.id}`);
    });
    const listed = (await list(headers, "state=open")).body.approvals;
    expect(ids(listed)).toEqual([reply.id]);
    expect(listed[0]!.record).toMatchObject({ status: "pending", request: { id: reply.id, kind: "reply", revision: 1,
      createdAt: Date.parse(reply.proposedAt), expiresAt: Date.parse(reply.expiresAt) } });
  });

  it("never shows a session another tenant's approvals, whatever its own index holds", async () => {
    const a = await session();
    const b = await session();
    const aTask = await ownTask(a.tenant);
    const aReply = await proposeReply(a.tenant, aTask, "for A's customer");
    const bTask = await ownTask(b.tenant);
    const bReply = await proposeReply(b.tenant, bTask, "for B's customer");
    // A's task planted in B's own index, and an action of A's planted inside B's own task: neither is B's to read.
    expect((await tenantCall(bindings, b.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: b.tenant, taskId: aTask }) })).status).toBe(200);
    const planted = await proposeReply(a.tenant, aTask, "planted");
    const plantedRecord = (await storedRequest(a.tenant, aTask, planted.id)).record;
    await runInDurableObject(task(bTask), async (_instance, state) => {
      await state.storage.put({ [`action:${planted.id}`]: planted, [`request:${planted.id}`]: plantedRecord });
    });
    await decide(a.tenant, aTask, aReply.id);

    expect(ids((await list(b.headers, "state=open")).body.approvals)).toEqual([bReply.id]);
    expect((await list(b.headers, "state=recent")).body.approvals).toEqual([]);
    expect(ids((await list(a.headers, "state=open")).body.approvals)).toEqual([planted.id]);
    expect(ids((await list(a.headers, "state=recent")).body.approvals)).toEqual([aReply.id]);

    // Only a session reads approvals: none at all, or the operator's key, is refused.
    expect((await list({}, "state=open")).status).toBe(401);
    expect((await list({ authorization: "Bearer test-key" }, "state=open")).status).toBe(401);
  });

  it("refuses a state, a limit or a method it does not know", async () => {
    const { headers } = await session();
    for (const query of ["", "state=all", "state=OPEN"]) {
      expect(await list(headers, query)).toEqual({ status: 400, body: { error: "invalid_state" } });
    }
    for (const limit of ["0", "201", "1.5", "ten"]) {
      expect(await list(headers, `state=recent&limit=${limit}`)).toEqual({ status: 400,
        body: { error: "invalid_limit" } });
    }
    const posted = await sourceWorker.fetch("https://api.manut.test/v1/approvals?state=open",
      { method: "POST", headers });
    expect(posted.status).toBe(405);
  });

  it("answers 503 rather than a partial list when a task or the shop's approval lookup cannot be read", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    await proposeReply(tenant, taskId, "ok");
    const failing = (binding: "TASK" | "TENANT", path: string): Env => {
      const namespace = bindings[binding];
      return { ...bindings, [binding]: {
        idFromName: (name: string) => namespace.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = namespace.get(id);
          return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname === path) return Response.json({ error: "fixture" }, { status: 500 });
            return stub.fetch(request);
          } };
        },
      } as unknown as DurableObjectNamespace };
    };
    expect(await list(headers, "state=open", failing("TASK", "/requests"))).toEqual({ status: 503,
      body: { error: "approvals_unavailable" } });
    // The lookup says which tasks to read (approval-index.ts); the walk of the index while its backfill runs is
    // approval-index.test.ts's.
    for (const path of ["/approvals/open", "/approvals/settled"]) {
      for (const state of ["open", "recent"]) {
        const answer = await list(headers, `state=${state}`, failing("TENANT", path));
        expect(answer).toEqual(path === "/approvals/settled" && state === "open" ? { status: 200,
          body: { state, approvals: expect.any(Array) } } : { status: 503, body: { error: "approvals_unavailable" } });
      }
    }
  });
});

describe("a task's approval requests, read by name", () => {
  it("answers only the requests named that the caller may read, as the whole read has them, and at most 100 names", async () => {
    const { tenant } = await session();
    const other = await session();
    const taskId = await ownTask(tenant);
    const first = await proposeReply(tenant, taskId, "first");
    const second = await proposeReply(tenant, taskId, "second");
    await proposeReply(tenant, taskId, "not asked for");
    // An action of another tenant planted in this task is not answered to this tenant, named or not.
    const otherTask = await ownTask(other.tenant);
    const planted = await proposeReply(other.tenant, otherTask, "planted");
    const plantedRecord = (await storedRequest(other.tenant, otherTask, planted.id)).record;
    await runInDurableObject(task(taskId), async (_instance, state) => {
      await state.storage.put({ [`action:${planted.id}`]: planted, [`request:${planted.id}`]: plantedRecord });
    });
    type Read = { record: { request: { id: string } }; standing: unknown };
    const byId = (items: Read[]) => [...items].sort((a, b) => (a.record.request.id < b.record.request.id ? -1 : 1));
    const named = async (names: string[], as = tenant) => {
      const response = await task(taskId).fetch(new Request(
        `https://task/requests?${names.map((name) => `id=${encodeURIComponent(name)}`).join("&")}`,
        { headers: { "x-tenant": as } }));
      return { status: response.status, body: (await response.json()) as { requests?: Read[] } };
    };

    const answered = await named([second.id, first.id, crypto.randomUUID(), planted.id, first.id]);
    expect(answered.status).toBe(200);
    const whole = await task(taskId).fetch(new Request("https://task/requests", { headers: { "x-tenant": tenant } }));
    const every = ((await whole.json()) as { requests: Read[] }).requests;
    expect(byId(answered.body.requests!)).toEqual(byId(every.filter((item) =>
      [first.id, second.id].includes(item.record.request.id))));
    expect(answered.body.requests).toHaveLength(2);

    // Another tenant reads the task as missing, named or not; an empty name and a 101st name are refused.
    expect((await named([first.id], other.tenant)).status).toBe(404);
    expect((await named([""])).status).toBe(400);
    expect((await named(Array.from({ length: 101 }, () => crypto.randomUUID()))).status).toBe(400);
    expect(await named(Array.from({ length: 100 }, () => crypto.randomUUID()))).toEqual({ status: 200,
      body: { requests: [] } });
  });
});
