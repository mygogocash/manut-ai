import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKFILL_TASKS, indexRequest, STALE_AFTER_MS } from "../src/approval-index";
import worker, { type Env } from "../src/index";
import { startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import type { ActionProposalJSON } from "../src/task-object";
import { tenantCall, tenantDelete, tenantPrune, tenantStub } from "../src/tenant-data";
import { adminFetch, tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { joinHelper, plantRequest, setupShop, shopTask } from "./people-fixtures";

// The shop's approval lookup (approval-index.ts; docs/pilot-api.md, "How the shop's approvals are found"): which task
// holds each approval-core request, which may still be open, and the settled ones newest first. Through the real Worker
// and objects, these show that `GET /v1/approvals` and the decision routes read only the tasks the lookup names, that the
// lookup is written before a request opens and cleared of what never opened, that a shop from before the lookup is
// walked until its backfill is done, and that no shop reads another's requests through it.
//
// Task-object and tenant-object calls are counted by wrapping the Worker's bindings (`recording`). The objects' own calls
// to each other go through their own bindings, which a test swaps on the instance when it needs one to fail.
//
// The global fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const BOT = `U${"7".repeat(32)}`;
const CUSTOMER = `U${"8".repeat(32)}`;
const PROJECT = "ws/approval-index";
const DECLINE = { optionId: "decline", seenRevision: 1 };

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Listed = { taskId: string; record: { status: string; request: { id: string; createdAt: number } };
  standing: { state: string; reason: string } };
type Call = { binding: "TASK" | "TENANT"; name: string; method: string; path: string; ids: string[] };

/// The Worker's bindings with TASK and TENANT wrapped so every call the Worker makes to either is recorded: which object
/// (by the name it was addressed with), the method, the path, and the request ids a `/requests?id=` read named.
function recording(): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const wrap = (binding: "TASK" | "TENANT") => {
    const namespace = bindings[binding];
    const names = new Map<string, string>();
    return {
      idFromName: (name: string) => {
        const id = namespace.idFromName(name);
        names.set(id.toString(), name);
        return id;
      },
      get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          calls.push({ binding, name: names.get(id.toString()) ?? "?", method: request.method, path: url.pathname,
            ids: url.searchParams.getAll("id").sort() });
          return stub.fetch(request);
        } };
      },
    } as unknown as DurableObjectNamespace;
  };
  return { env: { ...bindings, TASK: wrap("TASK"), TENANT: wrap("TENANT") }, calls };
}

async function viaWorker(target: Env, path: string, init: { method?: string; headers: Record<string, string>;
  body?: unknown }) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: init.method ?? "GET",
    headers: { "content-type": "application/json", "cf-connecting-ip": "2001:db8::48", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as { approvals: Listed[]; error?: string } &
    Record<string, unknown> };
}

function list(headers: Record<string, string>, query: string, target: Env = bindings) {
  return viaWorker(target, `/v1/approvals?${query}`, { headers });
}

const ids = (approvals: Listed[]) => approvals.map((item) => item.record.request.id);

/// Every call the Worker made to a task object, as `METHOD path task` in the order called. A read of named requests ends
/// with the ids it named, and a read of all of a task's requests (the walk) with `*`.
function taskReads(calls: Call[]): string[] {
  return calls.filter((call) => call.binding === "TASK")
    .map((call) => `${call.method} ${call.path.replace(/^\/requests\/[^/]+/, "/requests/:id")} ${call.name}${
      call.path === "/requests" ? `: ${call.ids.length > 0 ? call.ids.join(",") : "*"}` : ""}`);
}

/// The calls the Worker made to the shop's lookup and its index, in order.
function lookupPaths(calls: Call[]): string[] {
  return calls.filter((call) => call.binding === "TENANT" && (call.path.startsWith("/approvals/") ||
    call.path === "/index")).map((call) => `${call.method} ${call.path}`);
}

/// A signed-in tenant of its own, with cloud-work consent given.
async function session(): Promise<{ tenant: string; headers: { authorization: string } }> {
  const tenant = `approval-index:${crypto.randomUUID()}`;
  return { tenant, headers: await tenantSession(tenant) };
}

/// A draft task the tenant owns, in its index as `POST /v1/tasks` leaves one.
async function ownTask(tenant: string, name = "task"): Promise<string> {
  const taskId = `approval-index-${name}-${crypto.randomUUID()}`;
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

function replyBody(text: string, expiresAt = new Date(Date.now() + 3600_000).toISOString()) {
  return { connectionId: "conn-approval-index", providerAccountId: "acct-approval-index", grantRevision: 1, expiresAt,
    operationType: "line.message.push", targetResourceId: BOT, resourceScope: [BOT], payload: { text },
    recipients: [CUSTOMER] };
}

/// Proposes a LINE reply on the task object, as the pilot's reply flow and a session's propose route do: the raw answer.
function tryReply(tenant: string, taskId: string, text: string, expiresAt?: string) {
  return task(taskId).fetch(new Request("https://task/actions", { method: "POST",
    headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify(replyBody(text, expiresAt)) }));
}

/// A LINE reply proposed on the task, which opens its approval-core request.
async function proposeReply(tenant: string, taskId: string, text: string, expiresAt?: string):
  Promise<ActionProposalJSON> {
  const response = await tryReply(tenant, taskId, text, expiresAt);
  expect(response.status).toBe(200);
  return (await response.json()) as ActionProposalJSON;
}

/// A worker's attempt on the task, through the job flow, which asks for one write to the shop's tracker.
async function workerAsks(tenant: string, taskId: string): Promise<{ port: WorkerPort; requestId: string }> {
  const connected = await adminFetch("https://api.manut.test/v1/admin/connections", { method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: tenant, provider: "linear", accountId: "workspace-approval-index", scopes: ["write"],
      refreshToken: "linear-vault-token-approval-index", resourceIds: [PROJECT], allowsActions: true }) });
  expect(connected.status).toBe(200);
  const started = await startAttempt(flowEnv, { tenant, taskId, executorId: "stand-in" }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  const port = workerPort(flowEnv, started.job, { flags: on });
  const asked = await port.ask({ operationType: "linear.issue.create", targetResourceId: PROJECT,
    payload: { title: "Late parcel" } });
  if (!asked.ok) throw new Error(`not_asked_${asked.error}`);
  return { port, requestId: asked.value.requestId };
}

/// Decides a request in its task object directly, as the owner's link does: the lookup hears of it only from a read.
async function decideInTask(tenant: string, taskId: string, requestId: string, optionId = "decline") {
  const response = await task(taskId).fetch(new Request(`https://task/requests/${requestId}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ optionId, seenRevision: 1, decidedBy: "owner-link", role: "owner" }) }));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
}

/// Every key of the shop's lookup, as its TenantObject keeps them.
function lookupKeys(tenant: string): Promise<string[]> {
  return runInDurableObject(tenantStub(bindings, tenant), async (_instance, state) =>
    [...(await state.storage.list({ prefix: "appr" })).keys()]);
}

function lookupValue<T>(tenant: string, key: string): Promise<T | undefined> {
  return runInDurableObject(tenantStub(bindings, tenant), (_instance, state) => state.storage.get<T>(key));
}

/// The shop as it was before the lookup existed: every request in its tasks, and nothing in the lookup.
async function forgetLookup(tenant: string): Promise<void> {
  await runInDurableObject(tenantStub(bindings, tenant), async (_instance, state) => {
    await state.storage.delete([...(await state.storage.list({ prefix: "appr" })).keys()]);
  });
}

/// Runs `body` with one object's own binding swapped, as when that object's call to another fails, and puts the
/// original back.
async function withObjectBinding<T>(stub: DurableObjectStub, binding: "TASK" | "TENANT", replacement: unknown,
  body: () => Promise<T>): Promise<T> {
  let original: unknown;
  await runInDurableObject(stub, (instance) => {
    const object = instance as unknown as { env: Record<string, unknown> };
    original = object.env;
    object.env = { ...object.env, [binding]: replacement };
  });
  try {
    return await body();
  } finally {
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: unknown }).env = original;
    });
  }
}

/// A namespace that hands every call to the real one, except those `answer` takes over.
function namespaceWith(binding: "TASK" | "TENANT",
  answer: (request: Request, id: DurableObjectId, real: () => Promise<Response>) => Promise<Response> | null) {
  const namespace = bindings[binding];
  return {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return answer(request, id, () => stub.fetch(request)) ?? stub.fetch(request);
      } };
    },
  };
}

/// The requests newest asked first, then by id, as the approvals list orders them, from their records in their tasks.
async function newestFirst(tenant: string, made: { id: string; taskId: string }[]) {
  const asked = await Promise.all(made.map(async (item) => {
    const response = await task(item.taskId).fetch(new Request(`https://task/requests/${item.id}`,
      { headers: { "x-tenant": tenant } }));
    return { ...item, createdAt: ((await response.json()) as { record: { request: { createdAt: number } } })
      .record.request.createdAt };
  }));
  return asked.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
}

describe("GET /v1/approvals?state=open", () => {
  it("reads only the tasks the lookup names, and only the requests it names, as the walk answered", async () => {
    const { tenant, headers } = await session();
    const replies = await ownTask(tenant, "replies");
    const asks = await ownTask(tenant, "asks");
    const quiet = await Promise.all([1, 2, 3, 4].map((i) => ownTask(tenant, `quiet-${i}`)));
    const open = await proposeReply(tenant, replies, "open");
    const settled = await proposeReply(tenant, quiet[0]!, "settled");
    await decideInTask(tenant, quiet[0]!, settled.id);
    const { requestId: asked } = await workerAsks(tenant, asks);

    // The first read still finds the decided request's entry open, reads it, and moves it to the settled list.
    const first = recording();
    const answered = await list(headers, "state=open", first.env);
    expect(answered.status).toBe(200);
    expect(ids(answered.body.approvals).sort()).toEqual([open.id, asked].sort());
    expect(taskReads(first.calls).sort()).toEqual([`GET /requests ${replies}: ${open.id}`,
      `GET /requests ${asks}: ${asked}`, `GET /requests ${quiet[0]}: ${settled.id}`].sort());
    expect(lookupPaths(first.calls)).toEqual(["GET /approvals/open", "POST /approvals/learned"]);

    // From then on, only the two tasks with something open are read, and never the index or the quiet tasks.
    const second = recording();
    const again = await list(headers, "state=open", second.env);
    expect(again.body).toEqual(answered.body);
    expect(taskReads(second.calls).sort()).toEqual([`GET /requests ${replies}: ${open.id}`,
      `GET /requests ${asks}: ${asked}`].sort());
    expect(lookupPaths(second.calls)).toEqual(["GET /approvals/open"]);

    // The same answer as walking every task in the index, as every read did before the lookup.
    await forgetLookup(tenant);
    const walked = recording();
    expect(await list(headers, "state=open", walked.env)).toEqual(again);
    expect(taskReads(walked.calls).filter((line) => line.endsWith(": *"))).toHaveLength(6);
    expect(lookupPaths(walked.calls)).toEqual(["GET /approvals/open", "GET /index", "POST /approvals/backfill"]);
  });

  it("lists a request of a task made after the last read: the read's copy of the shop's task index is never stale", async () => {
    const { tenant, headers } = await session();
    const first = await ownTask(tenant, "first");
    const one = await proposeReply(tenant, first, "one");
    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([one.id]);
    // a task made after that read, with a request of its own: the next read lists it too
    const later = await ownTask(tenant, "later");
    const two = await proposeReply(tenant, later, "two");
    expect(ids((await list(headers, "state=open")).body.approvals).sort()).toEqual([one.id, two.id].sort());
  });

  it("keeps an entry whose request never opened until it cannot be opening, lists nothing for it, then clears it", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const open = await proposeReply(tenant, taskId, "open");
    // The task object wrote the entry and stopped before opening the request: a crash between the two writes.
    const never = crypto.randomUUID();
    expect(await indexRequest(bindings, tenant, never, taskId)).toBe(true);

    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([open.id]);
    expect(ids((await list(headers, "state=recent")).body.approvals)).toEqual([]);
    // Still within the window its request could have been opening in, so the entry stays.
    expect(await lookupValue(tenant, `appr-open:${tenant}:${never}`)).toBe(taskId);
    const decided = await viaWorker(bindings, `/v1/approvals/${never}/decision`,
      { method: "POST", headers, body: DECLINE });
    expect(decided).toEqual({ status: 404, body: { error: "not_found" } });

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALE_AFTER_MS + 1_000);
    const late = recording();
    expect(ids((await list(headers, "state=open", late.env)).body.approvals)).toEqual([open.id]);
    expect(await lookupValue(tenant, `appr:${tenant}:${never}`)).toBeUndefined();
    expect(await lookupValue(tenant, `appr-open:${tenant}:${never}`)).toBeUndefined();
    const after = recording();
    expect(ids((await list(headers, "state=open", after.env)).body.approvals)).toEqual([open.id]);
    expect(taskReads(after.calls)).toEqual([`GET /requests ${taskId}: ${open.id}`]);
  });
});

describe("a request's entry, written before it opens", () => {
  it("is written by every way a request opens: a reply, and a worker's ask", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    const reply = await proposeReply(tenant, taskId, "a reply");
    const { requestId } = await workerAsks(tenant, taskId);
    for (const id of [reply.id, requestId]) {
      expect(await lookupValue(tenant, `appr:${tenant}:${id}`)).toEqual({ taskId, at: expect.any(Number) });
      expect(await lookupValue(tenant, `appr-open:${tenant}:${id}`)).toBe(taskId);
    }
    // A proposal no request decides has no entry.
    const plain = await task(taskId).fetch(new Request("https://task/actions", { method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify({
        ...replyBody("x"), operationType: "linear.issue.create", targetResourceId: PROJECT, resourceScope: [PROJECT],
        payload: { title: "plain" }, recipients: undefined }) }));
    expect(plain.status).toBe(200);
    const plainId = ((await plain.json()) as ActionProposalJSON).id;
    expect(await lookupValue(tenant, `appr:${tenant}:${plainId}`)).toBeUndefined();
  });

  it("is not written for an ask the task object refuses anyway", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    const { port } = await workerAsks(tenant, taskId);
    const before = await lookupKeys(tenant);
    expect((await port.finish("done")).ok).toBe(true);
    // The attempt has ended, so the ask is refused, and it is refused before anything is written anywhere.
    const refused = await task(taskId).fetch(new Request(`https://task/attempts/${port.job.attemptId}/ask`, {
      method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify({
        fence: port.job.fence, action: { connectionId: "conn", providerAccountId: "acct", operationType: "linear.issue.create",
          targetResourceId: PROJECT, resourceScope: [PROJECT], payload: { title: "too late" }, grantRevision: 1,
          expiresAt: new Date(Date.now() + 3600_000).toISOString() } }) }));
    expect(refused.status).toBe(409);
    expect(await lookupKeys(tenant)).toEqual(before);
  });

  it("opens nothing for a task whose owner changed while its entry was written", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    // The operator's path (no tenant) moves the task to another tenant between the entry's write and the open.
    const moving = namespaceWith("TENANT", (request, _id, real) => new URL(request.url).pathname === "/approvals/asked"
      ? real().then(async (response) => {
        const moved = await task(taskId).fetch(new Request("https://task/", { method: "PUT", headers: {
          "content-type": "application/json", "x-task-id": taskId, "x-tenant": "" }, body: JSON.stringify({ id: taskId,
          title: "Replies", objective: "Answer customers", state: "draft", location: "cloud", funding: "cloudBYOK",
          criteria: [], updatedAt: new Date().toISOString(), tenantId: "approval-index:someone-else" }) }));
        expect(moved.status).toBe(200);
        return response;
      }) : null);
    const proposed = await withObjectBinding(task(taskId), "TENANT", moving, () => task(taskId).fetch(new Request(
      "https://task/actions", { method: "POST", headers: { "content-type": "application/json", "x-tenant": "" },
        body: JSON.stringify(replyBody("for the old owner")) })));
    expect(proposed.status).toBe(503);
    const held = await task(taskId).fetch(new Request("https://task/requests", { headers: { "x-tenant": "" } }));
    expect(((await held.json()) as { requests: unknown[] }).requests).toEqual([]);
  });

  it("opens nothing when the lookup cannot be written, or its answer is lost, or the window has passed", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const asked = (request: Request) => new URL(request.url).pathname === "/approvals/asked";
    const heldRequests = async () => {
      const response = await task(taskId).fetch(new Request("https://task/requests", { headers: { "x-tenant": tenant } }));
      return ((await response.json()) as { requests: unknown[] }).requests.length;
    };

    // The lookup cannot be written: the request is not opened, so no request is ever missing from the lookup.
    const down = namespaceWith("TENANT", (request) => asked(request)
      ? Promise.resolve(Response.json({ error: "fixture" }, { status: 500 })) : null);
    const refused = await withObjectBinding(task(taskId), "TENANT", down, () => tryReply(tenant, taskId, "refused"));
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "approvals_unavailable" });
    expect(await heldRequests()).toBe(0);
    expect(await lookupKeys(tenant)).toEqual([`appr-state:${tenant}`]);

    // The entry is written and its answer lost, as when the task object stops between the two writes: nothing opens,
    // and the entry left behind is cleared once it cannot be opening.
    const lost = namespaceWith("TENANT", (request, _id, real) => asked(request)
      ? real().then(() => { throw new Error("fixture: answer lost"); }) : null);
    expect((await withObjectBinding(task(taskId), "TENANT", lost, () => tryReply(tenant, taskId, "lost"))).status)
      .toBe(503);
    expect(await heldRequests()).toBe(0);
    const stale = (await lookupKeys(tenant)).filter((key) => key.startsWith(`appr-open:${tenant}:`));
    expect(stale).toHaveLength(1);

    // The entry is written, and the open comes more than a minute after it: refused, so no read can clear an entry
    // whose request is still to open.
    let clock: { mockRestore(): void } | undefined;
    const slow = namespaceWith("TENANT", (request, _id, real) => asked(request)
      ? real().then((response) => {
        const later = Date.now() + 61_000;
        clock = vi.spyOn(Date, "now").mockImplementation(() => later);
        return response;
      }) : null);
    const tooLate = await withObjectBinding(task(taskId), "TENANT", slow, () => tryReply(tenant, taskId, "too late"));
    clock?.mockRestore();
    expect(tooLate.status).toBe(503);
    expect(await heldRequests()).toBe(0);

    // None of them is listed, and with the lookup working again a reply opens and is listed.
    const reply = await proposeReply(tenant, taskId, "works");
    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([reply.id]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALE_AFTER_MS + 61_000);
    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([reply.id]);
    expect((await lookupKeys(tenant)).filter((key) => key.startsWith(`appr-open:${tenant}:`)))
      .toEqual([`appr-open:${tenant}:${reply.id}`]);
  });
});

describe("GET /v1/approvals?state=recent", () => {
  it("reads the open entries and the newest settled ones up to the limit, and more only for those gone", async () => {
    const { tenant, headers } = await session();
    const tasks = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => ownTask(tenant, `recent-${i}`)));
    const made: { id: string; taskId: string }[] = [];
    for (const taskId of tasks) {
      const reply = await proposeReply(tenant, taskId, `reply on ${taskId}`);
      await decideInTask(tenant, taskId, reply.id);
      made.push({ id: reply.id, taskId });
    }
    const open = await proposeReply(tenant, tasks[0]!, "still open");
    // The first read moves every decided entry to the settled list.
    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([open.id]);
    const order = await newestFirst(tenant, made);

    const bounded = recording();
    const recent = await list(headers, "state=recent&limit=2", bounded.env);
    expect(ids(recent.body.approvals)).toEqual(order.slice(0, 2).map((m) => m.id));
    expect(taskReads(bounded.calls).sort()).toEqual([`GET /requests ${tasks[0]}: ${open.id}`,
      ...order.slice(0, 2).map((m) => `GET /requests ${m.taskId}: ${m.id}`)].sort());
    expect(lookupPaths(bounded.calls)).toEqual(["GET /approvals/open", "GET /approvals/settled"]);

    // As the walk answers it, limit or none.
    await forgetLookup(tenant);
    const walked = await list(headers, "state=recent&limit=2");
    expect(walked).toEqual(recent);
    expect(ids((await list(headers, "state=recent")).body.approvals)).toEqual(order.map((m) => m.id));

    // The newest settled request has gone from its task, as the retention sweep removes old ones: the read reads one
    // more in its place, and forgets the entry.
    await runInDurableObject(task(order[0]!.taskId), async (_instance, state) => {
      await state.storage.delete([`action:${order[0]!.id}`, `request:${order[0]!.id}`]);
    });
    const refill = recording();
    expect(ids((await list(headers, "state=recent&limit=2", refill.env)).body.approvals))
      .toEqual(order.slice(1, 3).map((m) => m.id));
    expect(lookupPaths(refill.calls)).toEqual(["GET /approvals/open", "GET /approvals/settled",
      "GET /approvals/settled", "POST /approvals/learned"]);
    expect(await lookupValue(tenant, `appr:${tenant}:${order[0]!.id}`)).toBeUndefined();
    // Forgotten everywhere: the next read finds two at once again.
    const after = recording();
    expect(ids((await list(headers, "state=recent&limit=2", after.env)).body.approvals))
      .toEqual(order.slice(1, 3).map((m) => m.id));
    expect(lookupPaths(after.calls)).toEqual(["GET /approvals/open", "GET /approvals/settled"]);
  });

  it("never puts back in the open set a request a read found settled", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const reply = await proposeReply(tenant, taskId, "decided");
    await decideInTask(tenant, taskId, reply.id);
    expect(ids((await list(headers, "state=recent")).body.approvals)).toEqual([reply.id]);
    // A report from a read that looked earlier, while the request was still open, arrives late.
    const late = await tenantCall(bindings, tenant, "/approvals/learned", { method: "POST",
      headers: { "content-type": "application/json", "x-approvals": "1" }, body: JSON.stringify({ tenant,
        found: [{ requestId: reply.id, taskId, askedAt: Date.now(), open: true }], missing: [] }) });
    expect(late.status).toBe(200);
    expect(await lookupValue(tenant, `appr-open:${tenant}:${reply.id}`)).toBeUndefined();
    const read = recording();
    expect(ids((await list(headers, "state=open", read.env)).body.approvals)).toEqual([]);
    expect(taskReads(read.calls)).toEqual([]);
  });
});

describe("a task with more open requests than one read may name", () => {
  it("is read in parts of at most 100, which the task object takes (approvals-route.test.ts)", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const made: string[] = [];
    for (let i = 0; i < 101; i++) made.push((await proposeReply(tenant, taskId, `reply ${i}`)).id);
    const read = recording();
    const listed = await list(headers, "state=open", read.env);
    expect(ids(listed.body.approvals).sort()).toEqual([...made].sort());
    expect(taskReads(read.calls).map((line) => line.split(": ")[1]!.split(",").length).sort()).toEqual([1, 100]);
  });
});

describe("expiry and superseding", () => {
  it("leave the open set at the next read, show in recent as they stand, and are not read again for open", async () => {
    const { tenant, headers } = await session();
    const replies = await ownTask(tenant, "replies");
    const lapsing = await ownTask(tenant, "lapsing");
    const asks = await ownTask(tenant, "asks");
    const open = await proposeReply(tenant, replies, "open");
    const expiring = await proposeReply(tenant, lapsing, "expiring", new Date(Date.now() + 60_000).toISOString());
    const { port, requestId: superseded } = await workerAsks(tenant, asks);
    expect(ids((await list(headers, "state=open")).body.approvals).sort()).toEqual([open.id, expiring.id, superseded].sort());

    // Nothing is written anywhere when a request expires or its attempt ends without a decision.
    expect((await port.finish("failed", "gave_up")).ok).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiring.expiresAt) + 1_000);
    const read = recording();
    expect(ids((await list(headers, "state=open", read.env)).body.approvals)).toEqual([open.id]);
    expect(taskReads(read.calls).sort()).toEqual([`GET /requests ${replies}: ${open.id}`,
      `GET /requests ${lapsing}: ${expiring.id}`, `GET /requests ${asks}: ${superseded}`].sort());
    for (const id of [expiring.id, superseded]) {
      expect(await lookupValue(tenant, `appr-open:${tenant}:${id}`)).toBeUndefined();
      expect(await lookupValue(tenant, `appr:${tenant}:${id}`)).toMatchObject({ settled: true, askedAt: expect.any(Number) });
    }

    const next = recording();
    expect(ids((await list(headers, "state=open", next.env)).body.approvals)).toEqual([open.id]);
    expect(taskReads(next.calls)).toEqual([`GET /requests ${replies}: ${open.id}`]);
    const recent = new Map((await list(headers, "state=recent")).body.approvals
      .map((item) => [item.record.request.id, item.standing]));
    expect(recent.get(expiring.id)).toMatchObject({ state: "expired", reason: "expired" });
    expect(recent.get(superseded)).toEqual({ state: "superseded", reason: "attempt_ended" });
  });
});

describe("deciding and passing on", () => {
  it("find the request's task in one lookup, and read no other task", async () => {
    const shop = await setupShop();
    const owner = await tenantSession(shop.tenant);
    const helper = await joinHelper(shop, "Mint");
    const others = await Promise.all([1, 2, 3].map(() => shopTask(shop.tenant)));
    const holder = await shopTask(shop.tenant);
    for (const taskId of others) await plantRequest(shop.tenant, taskId, "money");
    const refund = await plantRequest(shop.tenant, holder, "money");
    const command = await plantRequest(shop.tenant, holder, "command");

    const passed = recording();
    const passing = await viaWorker(passed.env, `/v1/approvals/${refund}/pass-on`,
      { method: "POST", headers: helper.headers, body: { note: "A refund for you" } });
    expect(passing.status).toBe(200);
    expect(taskReads(passed.calls)).toEqual([`GET /requests/:id ${holder}`]);
    expect(lookupPaths(passed.calls)).toEqual(["GET /approvals/where"]);

    const decided = recording();
    const deciding = await viaWorker(decided.env, `/v1/approvals/${command}/decision`,
      { method: "POST", headers: owner, body: DECLINE });
    expect(deciding).toMatchObject({ status: 200, body: { result: { ok: true }, action: "rejected" } });
    expect(taskReads(decided.calls)).toEqual([`GET /requests/:id ${holder}`, `POST /requests/:id/decision ${holder}`]);
    expect(lookupPaths(decided.calls)).toEqual(["GET /approvals/where"]);

    // A request the lookup does not lead to is not the shop's, once the lookup is ready: no task is read for it.
    const missed = recording();
    const unknown = await viaWorker(missed.env, `/v1/approvals/${crypto.randomUUID()}/decision`,
      { method: "POST", headers: owner, body: DECLINE });
    expect(unknown).toEqual({ status: 404, body: { error: "not_found" } });
    expect(taskReads(missed.calls)).toEqual([]);
    expect(lookupPaths(missed.calls)).toEqual(["GET /approvals/where"]);
  });

  it("takes writes to the lookup only with the Worker's header", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    const requestId = crypto.randomUUID();
    for (const [path, body] of [["/approvals/asked", { tenant, requestId, taskId }],
      ["/approvals/learned", { tenant, found: [], missing: [{ requestId, taskId }] }],
      ["/approvals/backfill", { tenant }]] as const) {
      const response = await tenantCall(bindings, tenant, path, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(403);
    }
    expect(await lookupKeys(tenant)).toEqual([`appr-state:${tenant}`]);
  });
});

describe("a shop whose requests were opened before the lookup", () => {
  it("is walked until its backfill is done, one bounded step a read, resuming where a failed step stopped", async () => {
    const { tenant, headers } = await session();
    const tasks: string[] = [];
    for (let i = 0; i < BACKFILL_TASKS + 5; i++) tasks.push(await ownTask(tenant, `old-${i}`));
    const early = await proposeReply(tenant, tasks[1]!, "asked long ago");
    const late = await proposeReply(tenant, tasks[BACKFILL_TASKS + 2]!, "asked long ago, further on");
    const done = await proposeReply(tenant, tasks[BACKFILL_TASKS + 3]!, "decided long ago");
    await decideInTask(tenant, tasks[BACKFILL_TASKS + 3]!, done.id);
    await forgetLookup(tenant);
    const everyOpen = [early.id, late.id].sort();

    // While the lookup is not ready the index is read, and an index that cannot be read fails the answer and the
    // decision, never leaving a request out. (The step beside them is held back here, to keep its place for below.)
    const indexDown = { ...bindings, TENANT: namespaceWith("TENANT", (request) =>
      ["/index", "/approvals/backfill"].includes(new URL(request.url).pathname)
        ? Promise.resolve(Response.json({ error: "fixture" }, { status: 500 })) : null) } as unknown as Env;
    expect(await list(headers, "state=open", indexDown)).toEqual({ status: 503, body: { error: "approvals_unavailable" } });
    expect(await viaWorker(indexDown, `/v1/approvals/${done.id}/decision`, { method: "POST", headers, body: DECLINE }))
      .toEqual({ status: 503, body: { error: "approvals_unavailable" } });

    // The first read walks every task, so nothing is missing, and runs the backfill's first step beside it.
    const first = recording();
    expect(ids((await list(headers, "state=open", first.env)).body.approvals).sort()).toEqual(everyOpen);
    expect(taskReads(first.calls).filter((line) => line.endsWith(": *"))).toHaveLength(tasks.length);
    expect(lookupPaths(first.calls)).toEqual(["GET /approvals/open", "GET /index", "POST /approvals/backfill"]);
    expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ next: BACKFILL_TASKS });
    expect(await lookupValue(tenant, `appr-open:${tenant}:${early.id}`)).toBe(tasks[1]);
    expect(await lookupValue(tenant, `appr-open:${tenant}:${late.id}`)).toBeUndefined();

    // A request asked while the backfill runs has its entry from the start, and is listed like the rest.
    const meanwhile = await proposeReply(tenant, tasks[0]!, "asked during the backfill");
    const everyOpenNow = [...everyOpen, meanwhile.id].sort();

    // The next step stops at a task the shop's object cannot read, and goes no further than the tasks before it. A
    // decision meanwhile still finds a request the backfill has not reached, by walking the index.
    const failing = BACKFILL_TASKS + 2;
    const failingId = bindings.TASK.idFromName(tasks[failing]!);
    const down = namespaceWith("TASK", (request, id) => id.equals(failingId) &&
      new URL(request.url).pathname === "/requests" ? Promise.resolve(Response.json({}, { status: 500 })) : null);
    await withObjectBinding(tenantStub(bindings, tenant), "TASK", down, async () => {
      expect(ids((await list(headers, "state=open")).body.approvals).sort()).toEqual(everyOpenNow);
      expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ next: failing });
      const decided = await viaWorker(bindings, `/v1/approvals/${done.id}/decision`,
        { method: "POST", headers, body: DECLINE });
      expect(decided).toMatchObject({ status: 409, body: { error: "already_decided" } });
      expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ next: failing });
    });

    // The step after it starts with that task, and the lookup is ready once every task is behind it.
    expect(ids((await list(headers, "state=open")).body.approvals).sort()).toEqual(everyOpenNow);
    expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ ready: true, at: expect.any(String) });
    expect(await lookupValue(tenant, `appr-open:${tenant}:${late.id}`)).toBe(tasks[failing]);
    expect(await lookupValue(tenant, `appr:${tenant}:${done.id}`)).toMatchObject({ taskId: tasks[BACKFILL_TASKS + 3],
      settled: true });

    // From then on the lookup answers: the tasks with something open, and never the index.
    const ready = recording();
    expect(ids((await list(headers, "state=open", ready.env)).body.approvals).sort()).toEqual(everyOpenNow);
    expect(taskReads(ready.calls).sort()).toEqual([`GET /requests ${tasks[0]}: ${meanwhile.id}`,
      `GET /requests ${tasks[1]}: ${early.id}`, `GET /requests ${tasks[failing]}: ${late.id}`].sort());
    expect(lookupPaths(ready.calls)).toEqual(["GET /approvals/open"]);
    expect(ids((await list(headers, "state=recent")).body.approvals)).toEqual([done.id]);
  });

  it("needs no backfill when its first task comes after the lookup", async () => {
    const { tenant, headers } = await session();
    expect(await lookupKeys(tenant)).toEqual([]);
    const taskId = await ownTask(tenant);
    expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ ready: true, at: expect.any(String) });
    const reply = await proposeReply(tenant, taskId, "first");
    const read = recording();
    expect(ids((await list(headers, "state=open", read.env)).body.approvals)).toEqual([reply.id]);
    expect(lookupPaths(read.calls)).toEqual(["GET /approvals/open"]);
  });
});

describe("one shop's lookup and another's requests", () => {
  it("never shows or decides another shop's request, whatever entries are planted in the lookup", async () => {
    const a = await session();
    const b = await session();
    const aTask = await ownTask(a.tenant);
    const aOpen = await proposeReply(a.tenant, aTask, "A's open reply");
    const aDone = await proposeReply(a.tenant, aTask, "A's decided reply");
    await decideInTask(a.tenant, aTask, aDone.id);
    expect(ids((await list(a.headers, "state=open")).body.approvals)).toEqual([aOpen.id]);
    const bTask = await ownTask(b.tenant);
    const bOpen = await proposeReply(b.tenant, bTask, "B's open reply");

    // B's lookup is told A's requests are in A's task, open and settled, and that another of A's is in B's own task.
    const aThird = await proposeReply(a.tenant, aTask, "A's third reply");
    expect(await indexRequest(bindings, b.tenant, aOpen.id, aTask)).toBe(true);
    const learned = await tenantCall(bindings, b.tenant, "/approvals/learned", { method: "POST",
      headers: { "content-type": "application/json", "x-approvals": "1" }, body: JSON.stringify({ tenant: b.tenant,
        found: [{ requestId: aDone.id, taskId: aTask, askedAt: Date.now(), open: false }], missing: [] }) });
    expect(learned.status).toBe(200);
    expect(await indexRequest(bindings, b.tenant, aThird.id, bTask)).toBe(true);
    // A's task outside B's index is never read for B, not even to decide, and B's own task does not hold A's request.
    const outside = recording();
    expect(ids((await list(b.headers, "state=open", outside.env)).body.approvals)).toEqual([bOpen.id]);
    expect(ids((await list(b.headers, "state=recent", outside.env)).body.approvals)).toEqual([]);
    for (const requestId of [aOpen.id, aDone.id, aThird.id]) {
      expect(await viaWorker(outside.env, `/v1/approvals/${requestId}/decision`, { method: "POST", headers: b.headers,
        body: DECLINE })).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(outside.calls.filter((call) => call.binding === "TASK" && call.name === aTask)).toEqual([]);

    // With A's task planted in B's index too, it is read with B's tenant, which A's task does not answer.
    expect((await tenantCall(bindings, b.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: b.tenant, taskId: aTask }) })).status).toBe(200);
    expect(ids((await list(b.headers, "state=open")).body.approvals)).toEqual([bOpen.id]);
    expect(ids((await list(b.headers, "state=recent")).body.approvals)).toEqual([]);
    for (const requestId of [aOpen.id, aDone.id]) {
      expect(await viaWorker(bindings, `/v1/approvals/${requestId}/decision`, { method: "POST", headers: b.headers,
        body: DECLINE })).toEqual({ status: 404, body: { error: "not_found" } });
    }

    // A's own answers are A's as before, and none of A's requests was decided from B.
    expect(ids((await list(a.headers, "state=open")).body.approvals).sort()).toEqual([aOpen.id, aThird.id].sort());
    expect(ids((await list(a.headers, "state=recent")).body.approvals)).toEqual([aDone.id]);
  });
});

describe("deleting a shop", () => {
  it("wipes its whole lookup with the rest, and a shop made again starts ready", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const open = await proposeReply(tenant, taskId, "open");
    const done = await proposeReply(tenant, taskId, "done");
    await decideInTask(tenant, taskId, done.id);
    expect(ids((await list(headers, "state=open")).body.approvals)).toEqual([open.id]);
    expect((await lookupKeys(tenant)).length).toBeGreaterThan(3);

    const deleted = await tenantDelete(bindings, tenant);
    expect(deleted.status).toBe(200);
    expect(await lookupKeys(tenant)).toEqual([]);

    // Data that comes after a deletion is new: its first task makes the lookup ready again, and nothing old is listed.
    const again = await ownTask(tenant);
    expect(await lookupValue(tenant, `appr-state:${tenant}`)).toEqual({ ready: true, at: expect.any(String) });
    const fresh = await proposeReply(tenant, again, "new");
    expect(ids((await list(await tenantSession(tenant), "state=open")).body.approvals)).toEqual([fresh.id]);
    expect(ids((await list(await tenantSession(tenant), "state=recent")).body.approvals)).toEqual([]);
  });

  it("is never undone by a backfill step that was reading when it ran", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    await proposeReply(tenant, taskId, "asked before the lookup");
    await forgetLookup(tenant);
    // The step's read of the task is answered only after the shop's data has been deleted.
    const deleting = namespaceWith("TASK", (request, _id, real) => new URL(request.url).pathname === "/requests"
      ? tenantCall(bindings, tenant, "/tenant-wipe", { method: "POST", headers: { "content-type": "application/json",
        "x-wipe": "1" }, body: JSON.stringify({ tenant }) }).then((wiped) => {
        expect(wiped.status).toBe(200);
        return real();
      }) : null);
    const stepped = await withObjectBinding(tenantStub(bindings, tenant), "TASK", deleting, () => tenantCall(bindings,
      tenant, "/approvals/backfill", { method: "POST", headers: { "content-type": "application/json", "x-approvals": "1" },
        body: JSON.stringify({ tenant }) }));
    expect(stepped.status).toBe(200);
    expect(await lookupKeys(tenant)).toEqual([]);
  });
});

describe("the retention prune", () => {
  const DAY = 24 * 3600_000;

  /// The operator's retention prune of the shop as it would run `days` from now. The task objects age their records by
  /// the clock the prune hands them, and the lookup reads its own, which the spy moves too.
  async function pruneLater(tenant: string, days: number) {
    const later = Date.now() + days * DAY;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const response = await tenantPrune(bindings, tenant, later);
      return { status: response.status, body: (await response.json()) as { actionsPruned?: number; failed?: string[] } };
    } finally {
      clock.mockRestore();
    }
  }

  /// What the task still has to tell its shop's lookup (task-object.ts, `pruneExpired`).
  function noted(taskId: string) {
    return runInDurableObject(task(taskId), (_instance, state) => state.storage.get("lookup-gone"));
  }

  const keysOf = async (tenant: string, requestId: string) =>
    (await lookupKeys(tenant)).filter((key) => key.endsWith(`:${requestId}`));

  it("clears the entry of each request it removes once a read has settled it, and keeps every other", async () => {
    const { tenant, headers } = await session();
    const taskId = await ownTask(tenant);
    const reply = await proposeReply(tenant, taskId, "a reply still waiting");
    const { requestId: declined } = await workerAsks(tenant, taskId);
    await decideInTask(tenant, taskId, declined);
    // A read moves the declined request to the settled list.
    expect((await list(headers, "state=recent")).status).toBe(200);
    expect(await keysOf(tenant, declined)).toHaveLength(2);
    // Nothing is old enough yet: the prune removes nothing, and the lookup keeps both requests.
    expect((await pruneLater(tenant, 0)).body.actionsPruned).toBe(0);
    expect(await keysOf(tenant, declined)).toHaveLength(2);
    // A month on, the declined request goes from its task and its entry from the lookup.
    const swept = await pruneLater(tenant, 31);
    expect(swept.status).toBe(200);
    expect(swept.body.actionsPruned).toBe(1);
    expect(await keysOf(tenant, declined)).toEqual([]);
    // The reply still waits: no dead proposal, so its request and its entry stay.
    expect(await lookupValue(tenant, `appr-open:${tenant}:${reply.id}`)).toBe(taskId);
    expect(await noted(taskId)).toBeUndefined();
  });

  it("clears an entry no read settled, as its task no longer holds the request", async () => {
    const { tenant } = await session();
    const taskId = await ownTask(tenant);
    const { requestId } = await workerAsks(tenant, taskId);
    await decideInTask(tenant, taskId, requestId);
    expect(await lookupValue(tenant, `appr-open:${tenant}:${requestId}`)).toBe(taskId);
    const swept = await pruneLater(tenant, 31);
    expect(swept.status).toBe(200);
    expect(swept.body.actionsPruned).toBe(1);
    expect(await keysOf(tenant, requestId)).toEqual([]);
  });

  it("keeps on the task what the lookup did not hear, says the prune is not done, and tells it at the next prune",
    async () => {
      const { tenant } = await session();
      const taskId = await ownTask(tenant);
      const { requestId } = await workerAsks(tenant, taskId);
      await decideInTask(tenant, taskId, requestId);
      for (const failure of ["answers 500", "throws"]) {
        const down = namespaceWith("TENANT", (request) => new URL(request.url).pathname !== "/approvals/learned" ? null
          : failure === "throws" ? Promise.reject(new Error("tenant object down"))
          : Promise.resolve(Response.json({ error: "down" }, { status: 500 })));
        const failed = await withObjectBinding(task(taskId), "TENANT", down, () => pruneLater(tenant, 31));
        expect(failed.status).toBe(500);
        expect(failed.body.failed).toEqual(["approval-lookup"]);
        // The request is gone from its task, its entry is still in the lookup, and the task holds on to its id.
        expect(await keysOf(tenant, requestId)).toHaveLength(2);
        expect(await noted(taskId)).toEqual([requestId]);
      }
      // The next prune has nothing more to remove, but tells the lookup what the last ones could not.
      const swept = await pruneLater(tenant, 31);
      expect(swept.status).toBe(200);
      expect(swept.body.actionsPruned).toBe(0);
      expect(await keysOf(tenant, requestId)).toEqual([]);
      expect(await noted(taskId)).toBeUndefined();
    });
});
