import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptJSON, DraftJSON, TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";
import { tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  bindings,
  call,
  callWith,
  emailSignIn,
  failingWhere,
  joinHelper,
  linkedOwner,
  ownerSession,
  proposeReply,
  setFlags,
  setupShop,
  shopTask,
  signIn,
  stubLine,
  taskStub,
} from "./people-fixtures";

// The shop's tasks, newest first, a page at a time (task-list.ts; docs/pilot-api.md, "The shop's tasks, a page at a
// time"), and the two reads the desktop makes beside it in place of the export (the owner's schedules and attention
// items, shops.ts), through the real Worker and objects in workerd. A page reads the shop's index and at most `limit`
// tasks; paging is stable while tasks are made; a shop's session sees its own shop's tasks and no other's; and every
// refusal comes in the order the shop routes keep. The global fetch counts LINE pushes and answers everything else 599,
// so nothing leaves the test.

const enc = encodeURIComponent;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Listed = {
  task: { id: string; state: string; title: string };
  events: TaskEventJSON[];
  actions: { id: string }[];
  attempts: Record<string, unknown>[];
  attemptsTruncated: boolean;
  drafts: DraftJSON[];
};
type Page = { tasks: Listed[]; next: string | null; error?: string };

/// A page of the tasks, as the desktop asks for it.
function page(headers: { authorization?: string }, query = "") {
  return asSession<Page>(headers, "GET", `/v1/tasks${query ? `?${query}` : ""}`);
}

/// A task of `tenant` in `state`, made and indexed as `POST /v1/tasks` leaves one (without its consent and switches,
/// which are not what this file is about). A task reaches running, verifying or completed only on the trusted path, so
/// the state is set on the stored document.
async function taskIn(tenant: string, state: string, title = `A task in ${state}`): Promise<string> {
  const taskId = `list-task-${crypto.randomUUID()}`;
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title, objective: "Something for the shop", state: "draft",
    location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, tenant)).status)
    .toBe(200);
  if (state !== "draft") {
    await runInDurableObject(taskStub(taskId), async (_instance, stored) => {
      const doc = await stored.storage.get<Record<string, unknown>>("task");
      await stored.storage.put("task", { ...doc, state });
    });
  }
  return taskId;
}

/// Two members' runs on a task, as a job leaves them (job-flow.ts): Nam's run claimed it, reported a spend and passed it
/// to Ton, whose run claimed it after, reported a spend and is still at work, each with a draft; and between them the log
/// holds entries no list reads (a turn starting, a state change).
async function plantRuns(taskId: string): Promise<void> {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  await runInDurableObject(taskStub(taskId), async (_instance, state) => {
    const events = (await state.storage.get<TaskEventJSON[]>("events")) ?? [];
    let seq = events.at(-1)?.seq ?? 0;
    const add = (entry: Omit<TaskEventJSON, "seq" | "rev">) => events.push({ seq: ++seq, rev: 1, ...entry });
    add({ kind: "updated", at: iso(now + 1_000), via: "attempt:claim:run-nam" });
    add({ kind: "agent", at: iso(now + 2_000), attemptId: "run-nam", event: { type: "turnStarted" } });
    add({ kind: "agent", at: iso(now + 3_000), attemptId: "run-nam",
      event: { type: "spend", tokens: 640, model: "claude-haiku-5-5", costSatang: 38 } });
    add({ kind: "agent", at: iso(now + 4_000), attemptId: "run-nam", event: { type: "handoffNote", to: "ton" } });
    add({ kind: "state", at: iso(now + 5_000), from: "draft", to: "draft" });
    add({ kind: "updated", at: iso(now + 6_000), via: "attempt:claim:run-ton" });
    add({ kind: "agent", at: iso(now + 7_000), attemptId: "run-ton",
      event: { type: "spend", tokens: 120, model: "claude-haiku-5-5", costSatang: 9 } });
    const run = (id: string, executorId: string, over: Partial<AttemptJSON>): AttemptJSON => ({ id, executorId,
      fence: `fence-${id}`, leaseUntil: now / 1000 + 300, inputRevision: "rev-1", maxSteps: 40,
      deadline: now / 1000 + 1200, status: "active", steps: [{ id: "step-1", name: "read", status: "done" }], ...over });
    const draft = (attemptId: string, member: string, text: string, at: number): DraftJSON => ({ attemptId, member,
      job: "reply", text, at: iso(at) });
    await state.storage.put({
      events,
      "attempt:run-nam": run("run-nam", "nam", { status: "done", outcome: "done", finishedAt: now / 1000 + 5 }),
      "attempt:run-ton": run("run-ton", "ton", {}),
      "draft:run-nam": draft("run-nam", "nam", "Nam's first go.", now + 4_500),
      "draft:run-ton": draft("run-ton", "ton", "Ton's reply, newer.", now + 8_000),
    });
  });
}

/// The Worker's bindings with every call to a task object counted, by method and path.
function countingTasks(): { env: typeof bindings; calls: string[] } {
  const calls: string[] = [];
  const namespace = bindings.TASK;
  const env = { ...bindings, TASK: {
    idFromName: (id: string) => namespace.idFromName(id),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(`${request.method} ${new URL(request.url).pathname}`);
        return stub.fetch(request);
      } };
    },
  } as unknown as DurableObjectNamespace };
  return { env, calls };
}

/// The Worker's bindings with each task object's listing of `taskId` failing, as an object that cannot be reached does.
function failingTask(taskId: string): typeof bindings {
  const namespace = bindings.TASK;
  const failing = namespace.idFromName(taskId).toString();
  return { ...bindings, TASK: {
    idFromName: (id: string) => namespace.idFromName(id),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        id.toString() === failing ? Response.json({ error: "fixture" }, { status: 500 }) : stub.fetch(input, init) };
    },
  } as unknown as DurableObjectNamespace };
}

describe("the shop's tasks, from the owner's session", () => {
  it("lists them newest first, each with what the lists read of its export and nothing more", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const first = await shopTask(shop.tenant);
    await plantRuns(first);
    const reply = await proposeReply(shop, "Your parcel left this morning.");

    const listed = await page(owner.headers);
    expect(listed.status).toBe(200);
    expect(listed.body.next).toBeNull();
    expect(listed.body.tasks.map((one) => one.task.id)).toEqual([reply.taskId, first]);

    const exported = await asSession<{ tasks: (Listed & { attempts: AttemptJSON[]; eventFloor: number;
      requests: unknown[] })[] }>(owner.headers, "GET", "/v1/tenant/export");
    expect(exported.status).toBe(200);
    for (const one of listed.body.tasks) {
      const whole = exported.body.tasks.find((entry) => entry.task.id === one.task.id)!;
      expect(Object.keys(one).sort()).toEqual(["actions", "attempts", "attemptsTruncated", "drafts", "events", "task"]);
      expect(one.task).toEqual(whole.task);
      expect(one.actions).toEqual(whole.actions);
      expect(one.attemptsTruncated).toBe(whole.attemptsTruncated);
      // The runs, without what only their executor uses.
      expect(one.attempts).toEqual(whole.attempts.map(({ fence: _f, steps: _s, inputRevision: _i, maxSteps: _m, ...kept }) =>
        kept));
      // The newest draft alone.
      expect(one.drafts).toEqual(whole.drafts.slice(-1));
      // From the log, the entries the lists read, in order: the one that made it, each claim, each handoff and spend.
      expect(one.events).toEqual(whole.events.filter((event) => event.kind === "created" ||
        /^attempt:claim:/.test(event.via ?? "") || (event.kind === "agent" &&
          ["spend", "handoffNote"].includes((event.event as { type?: string }).type ?? ""))));
    }
    const job = listed.body.tasks.find((one) => one.task.id === first)!;
    expect(job.events.map((event) => event.via ?? (event.event as { type: string } | undefined)?.type ?? event.kind))
      .toEqual(["put", "attempt:claim:run-nam", "spend", "handoffNote", "attempt:claim:run-ton", "spend"]);
    expect(job.attempts.map((run) => run.id).sort()).toEqual(["run-nam", "run-ton"]);
    expect(job.drafts.map((draft) => draft.text)).toEqual(["Ton's reply, newer."]);
    // The reply waits for the owner with its exact words, which Needs you and the activity log read.
    expect(listed.body.tasks[0]!.actions).toEqual([expect.objectContaining({ id: reply.actionId, state: "proposed",
      payload: { text: "Your parcel left this morning." } })]);
    // It holds customers' words and members' drafts, so no browser or proxy may keep it, as with the export.
    expect((await call("/v1/tasks", { headers: owner.headers })).headers.get("cache-control")).toBe("no-store");
  });

  it("reads the index and at most a page of tasks, never another task or the export", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const made: string[] = [];
    for (let n = 0; n < 27; n++) made.push(await taskIn(shop.tenant, "draft", `Task ${n}`));
    const newest = [...made].reverse();
    for (const [query, size] of [["", 25], ["limit=3", 3], ["limit=25", 25]] as const) {
      const counted = countingTasks();
      const answered = await callWith(counted.env, `/v1/tasks${query ? `?${query}` : ""}`, { headers: owner.headers });
      expect(answered.status).toBe(200);
      const body = answered.body as unknown as Page;
      expect(body.tasks.map((one) => one.task.id)).toEqual(newest.slice(0, size));
      expect(body.next).toBe(newest[size - 1]);
      // One listing per task looked at, and nothing else: no export, no log, no other task.
      expect(counted.calls).toEqual(Array.from({ length: size }, () => "GET /listing"));
    }
    // The hard limit: a page never asks for more than 25, and the refusal reads nothing.
    for (const limit of ["26", "100", "0", "-1", "1.5", "2e1", "", " 5", "five"]) {
      const counted = countingTasks();
      expect(await callWith(counted.env, `/v1/tasks?limit=${enc(limit)}`, { headers: owner.headers })).toEqual({
        status: 400, body: { error: "invalid_limit" } });
      expect(counted.calls).toEqual([]);
    }
  });

  it("pages stably while tasks are made: no task is skipped or listed twice", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const older: string[] = [];
    for (let n = 0; n < 5; n++) older.push(await taskIn(shop.tenant, "draft", `Older ${n}`));
    const seen: string[] = [];
    const first = await page(owner.headers, "limit=2");
    expect(first.status).toBe(200);
    seen.push(...first.body.tasks.map((one) => one.task.id));
    // Two tasks are made between the pages, and one more before the last.
    const newer = [await taskIn(shop.tenant, "draft", "Newer 0"), await taskIn(shop.tenant, "draft", "Newer 1")];
    const second = await page(owner.headers, `limit=2&cursor=${enc(first.body.next!)}`);
    expect(second.status).toBe(200);
    seen.push(...second.body.tasks.map((one) => one.task.id));
    newer.push(await taskIn(shop.tenant, "draft", "Newer 2"));
    const third = await page(owner.headers, `limit=2&cursor=${enc(second.body.next!)}`);
    expect(third.status).toBe(200);
    expect(third.body.next).toBeNull();
    seen.push(...third.body.tasks.map((one) => one.task.id));
    expect(seen).toEqual([...older].reverse());
    // The tasks made meanwhile are on a new first page, newest first.
    expect((await page(owner.headers, "limit=3")).body.tasks.map((one) => one.task.id)).toEqual([...newer].reverse());
    // A page from the end of the list again gives what it gave, and the last page's cursor reads an empty page.
    expect((await page(owner.headers, `limit=2&cursor=${enc(first.body.next!)}`)).body.tasks.map((one) => one.task.id))
      .toEqual(second.body.tasks.map((one) => one.task.id));
    expect(await page(owner.headers, `cursor=${enc(older[0]!)}`)).toEqual({ status: 200, body: { tasks: [], next: null } });
  });

  it("filters by state among the tasks a page looks at, and says where to look next", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const made = [await taskIn(shop.tenant, "draft"), await taskIn(shop.tenant, "running"),
      await taskIn(shop.tenant, "completed"), await taskIn(shop.tenant, "running"), await taskIn(shop.tenant, "failed")];
    const newest = [...made].reverse();
    expect((await page(owner.headers, "state=running")).body).toEqual({ tasks: [expect.objectContaining({
      task: expect.objectContaining({ id: made[3] }) }), expect.objectContaining({ task: expect.objectContaining({
      id: made[1] }) })], next: null });
    // A page of two looks at the two newest, of which one is running; the next looks at the two before them.
    const short = await page(owner.headers, "state=running&limit=2");
    expect(short.body.tasks.map((one) => one.task.id)).toEqual([made[3]]);
    expect(short.body.next).toBe(newest[1]);
    const after = await page(owner.headers, `state=running&limit=2&cursor=${enc(short.body.next!)}`);
    expect(after.body.tasks.map((one) => one.task.id)).toEqual([made[1]]);
    expect(after.body.next).toBe(newest[3]);
    // A page can come back empty while there is more to look at.
    const none = await page(owner.headers, "state=completed&limit=1");
    expect(none.body).toEqual({ tasks: [], next: newest[0] });
    expect((await page(owner.headers, "state=paused")).body).toEqual({ tasks: [], next: null });
    // Every state a task can be in is taken, and nothing else.
    for (const state of ["draft", "queued", "waitingForAuthorization", "cancelled"]) {
      expect((await page(owner.headers, `state=${state}`)).status).toBe(200);
    }
    for (const state of ["", "Running", "done", "proposed", "running,failed"]) {
      expect(await page(owner.headers, `state=${enc(state)}`)).toEqual({ status: 400, body: { error: "invalid_state" } });
    }
  });

  it("shows a shop's session its own shop's tasks and never another shop's", async () => {
    const mali = await setupShop("Baan Mali");
    const paNoi = await setupShop("Ran Pa Noi");
    const fon = await signIn();
    const ownerOfMali = await linkedOwner(mali, fon);
    const ownerOfPaNoi = { headers: await (async () => {
      await admin("POST", "/v1/admin/shops/owner", { tenant: paNoi.tenant, code: await (await asSession<{ code: string }>(
        fon.headers, "POST", "/v1/shops/owner-code")).body.code });
      return ownerSession(fon, paNoi);
    })() };
    const malis = await taskIn(mali.tenant, "draft", "Mali's task");
    const paNois = await taskIn(paNoi.tenant, "draft", "Pa Noi's task");
    // Another shop's task planted in Mali's index is passed over, as the export passes it over.
    expect((await tenantCall(bindings, mali.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: mali.tenant, taskId: paNois }) })).status).toBe(200);
    expect((await page(ownerOfMali.headers)).body).toEqual({ tasks: [expect.objectContaining({
      task: expect.objectContaining({ id: malis, title: "Mali's task" }) })], next: null });
    expect((await page(ownerOfPaNoi.headers)).body).toEqual({ tasks: [expect.objectContaining({
      task: expect.objectContaining({ id: paNois, title: "Pa Noi's task" }) })], next: null });
    // A proposal of another shop's planted inside Mali's own task is left out, as the export leaves it out.
    await runInDurableObject(taskStub(malis), (_instance, state) => state.storage.put("action:planted", { id: "planted",
      tenant: paNoi.tenant, connectionId: "conn", providerAccountId: "acct", operationType: "line.message.push",
      targetResourceId: "bot", resourceScope: ["bot"], payload: { text: "Pa Noi's words" }, payloadHash: "h",
      grantRevision: 0, proposedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), state: "proposed" }));
    const malisPage = await page(ownerOfMali.headers);
    expect(malisPage.body.tasks.map((one) => one.actions)).toEqual([[]]);
    expect(JSON.stringify(malisPage.body)).not.toContain("Pa Noi");
    // A cursor naming another shop's task is no cursor of this shop's list.
    expect(await page(ownerOfPaNoi.headers, `cursor=${enc(malis)}`)).toEqual({ status: 400,
      body: { error: "invalid_cursor" } });
    // The session names the shop: a query naming one, a tenant or a role is refused, not read.
    for (const query of [`tenant=${enc(paNoi.tenant)}`, `shop=${enc(paNoi.tenant)}`, "role=owner"]) {
      expect(await page(ownerOfMali.headers, query)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
  });

  it("answers a deleted shop as the export does, and a shop with no tasks with an empty page", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    expect(await page(owner.headers)).toEqual({ status: 200, body: { tasks: [], next: null } });
    // The deletion's tombstone, with no task after it. A real deletion ends the owner's sessions too; the tombstone alone
    // is what the list and the export read.
    const deletedAt = new Date().toISOString();
    await runInDurableObject(bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`)), (_instance, state) =>
      state.storage.put(`tomb:${shop.tenant}`, { deletedAt, tasksWiped: 3 }));
    expect(await page(owner.headers)).toEqual({ status: 404, body: { error: "tenant_deleted", deletedAt } });
    expect(await asSession(owner.headers, "GET", "/v1/tenant/export")).toEqual({ status: 404,
      body: { error: "tenant_deleted", deletedAt } });
  });
});

describe("refusals, in the order the shop routes keep", () => {
  it("is who is asking, then the role, the method, the query, and then the list's own", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const task = await taskIn(shop.tenant, "draft");
    const signedOut = await ownerSession(owner.person, shop);
    expect((await asSession(signedOut, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    const bad = "limit=99&state=nope&cursor=nope";
    // Who is asking: no session, the operator key, a shop session ended or never held. Nothing about the route is told:
    // a shop session's token is refused whatever the method, and the other two are the lifted routes' to answer, as
    // before (their read is this list; their other methods are what they were).
    for (const headers of [{}, { authorization: "Bearer test-key" }, signedOut]) {
      expect(await asSession(headers, "GET", `/v1/tasks?${bad}&tenant=${enc(other.tenant)}`)).toEqual({ status: 401,
        body: { error: "unauthorized" } });
    }
    for (const method of ["PUT", "DELETE"]) {
      expect(await asSession(signedOut, method, `/v1/tasks?${bad}`)).toEqual({ status: 401,
        body: { error: "unauthorized" } });
    }
    // The session cannot be checked: 503, never an answer as if there were no session.
    for (const throws of [false, true]) {
      const unchecked = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/people/owner-session-check",
        throws);
      expect(await callWith(unchecked, `/v1/tasks?${bad}`, { headers: owner.headers })).toEqual({ status: 503,
        body: { error: "people_unavailable" } });
    }
    // Then the role: a helper's session is told the list is the owner's, whatever the method or the query.
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(await asSession(helper.headers, method, `/v1/tasks?${bad}`)).toEqual({ status: 403,
        body: { error: "owner_only" } });
    }
    // Then the method: the list is read only. A shop session never makes a task here.
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(await asSession(owner.headers, method, `/v1/tasks?${bad}&tenant=x`, method === "DELETE" ? undefined : {}))
        .toEqual({ status: 405, body: { error: "method_not_allowed" } });
    }
    // Then the query: what only the session decides first, then the page asked for.
    expect(await page(owner.headers, `${bad}&role=owner`)).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await page(owner.headers, bad)).toEqual({ status: 400, body: { error: "invalid_limit" } });
    expect(await page(owner.headers, "state=nope&cursor=")).toEqual({ status: 400, body: { error: "invalid_state" } });
    expect(await page(owner.headers, "cursor=")).toEqual({ status: 400, body: { error: "invalid_cursor" } });
    expect(await page(owner.headers, `cursor=${"x".repeat(257)}`)).toEqual({ status: 400,
      body: { error: "invalid_cursor" } });
    expect(await page(owner.headers, "cursor=no-such-task")).toEqual({ status: 400, body: { error: "invalid_cursor" } });
    // Then what the list reads: the index, and each task on the page. A part that cannot be read fails the page.
    for (const throws of [false, true]) {
      const noIndex = failingWhere("TENANT", (request) => request.method === "GET" &&
        new URL(request.url).pathname === "/index", throws);
      expect(await callWith(noIndex, "/v1/tasks", { headers: owner.headers })).toEqual({ status: 503,
        body: { error: "tasks_unavailable" } });
    }
    expect(await callWith(failingTask(task), "/v1/tasks", { headers: owner.headers })).toEqual({ status: 503,
      body: { error: "tasks_unavailable" } });
    expect((await page(owner.headers)).status).toBe(200);
  });

  it("answers an unlinked owner and a removed helper with why, as every shop route does", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id })).status).toBe(200);
    for (const path of ["/v1/tasks", "/v1/schedules", "/v1/inbound/attention"]) {
      expect(await asSession(owner.headers, "GET", path)).toMatchObject({ status: 401,
        body: { error: "unlinked", unlinkedAt: expect.any(String) } });
      expect(await asSession(helper.headers, "GET", path)).toMatchObject({ status: 401,
        body: { error: "removed", removedAt: expect.any(String) } });
    }
  });
});

describe("a person's own sign-in", () => {
  it("lists their own tenant's tasks, as the export does for them, and never a shop's", async () => {
    const shop = await setupShop();
    await taskIn(shop.tenant, "draft", "The shop's task");
    // Signed in by email: their own tenant holds no task, so the list is empty, as their export is.
    const byEmail = await emailSignIn(`list-${crypto.randomUUID()}@example.org`);
    expect(await page(byEmail.headers)).toEqual({ status: 200, body: { tasks: [], next: null } });
    // A tenant's own lifted session lists its own tasks; the shop's are never among them.
    const person = await signIn();
    const own = await taskIn(person.tenant, "running", "My own task");
    expect((await page(person.headers)).body).toEqual({ tasks: [expect.objectContaining({ task: expect.objectContaining({
      id: own, title: "My own task" }) })], next: null });
    expect((await page(person.headers, "state=draft")).body).toEqual({ tasks: [], next: null });
    // The query cannot name another tenant, and the page's rules are the same.
    for (const query of [`tenant=${enc(shop.tenant)}`, `shop=${enc(shop.tenant)}`, "role=owner"]) {
      expect(await page(person.headers, query)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await page(person.headers, "limit=26")).toEqual({ status: 400, body: { error: "invalid_limit" } });
    // The shop's own lifted session lists the shop's tasks, as its export would.
    const shopsOwn = await tenantSession(shop.tenant);
    expect((await page(shopsOwn)).body.tasks.map((one) => one.task.title)).toEqual(["The shop's task"]);
  });
});

describe("the shop's schedules and attention items, from the owner's session", () => {
  it("reads what the export carried, the attention items whatever the inbound switch, and changes nothing", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const made = await admin<{ routine: { id: string } }>("POST", "/v1/admin/routines", { tenant: shop.tenant,
      name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" } });
    expect(made.status).toBe(200);
    expect((await tenantCall(bindings, shop.tenant, "/attention", { method: "POST", headers: {
      "content-type": "application/json", "x-inbound": "1" }, body: JSON.stringify({ tenant: shop.tenant,
      deliveryId: "delivery-1", connectionId: "conn-linear", eventType: "linear.issue.update", issueId: "ISS-9" }) }))
      .status).toBe(200);
    const exported = await asSession<{ schedules: unknown[]; attention: unknown[] }>(owner.headers, "GET",
      "/v1/tenant/export");
    expect(exported.status).toBe(200);
    const schedules = await asSession<{ schedules: { id: string; routineId?: string }[] }>(owner.headers, "GET",
      "/v1/schedules");
    expect(schedules).toEqual({ status: 200, body: { schedules: exported.body.schedules } });
    expect(schedules.body.schedules).toEqual([expect.objectContaining({ id: made.body.routine.id,
      routineId: made.body.routine.id })]);
    for (const inbound of [true, false]) {
      expect((await setFlags({ officeInbound: inbound })).status).toBe(200);
      expect(await asSession(owner.headers, "GET", "/v1/inbound/attention")).toEqual({ status: 200,
        body: { items: exported.body.attention } });
    }
    expect(exported.body.attention).toEqual([expect.objectContaining({ eventType: "linear.issue.update", issueId: "ISS-9" })]);
    // Reads only: making or deleting a schedule stays closed to a shop session, and nothing was made.
    expect(await asSession(owner.headers, "POST", "/v1/schedules", { id: "owner-made", name: "x", prompt: "x", hour: 8,
      minute: 0, weekdays: [1], timeZone: "Asia/Bangkok", hasSchedulingConsent: true })).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    expect(await asSession(owner.headers, "POST", "/v1/inbound/attention", {})).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    expect((await asSession(owner.headers, "DELETE", `/v1/schedules/${enc(made.body.routine.id)}`)).status).toBe(401);
    expect((await asSession<{ schedules: unknown[] }>(owner.headers, "GET", "/v1/schedules")).body.schedules)
      .toHaveLength(1);
    // The owner's, and the session's own shop's alone.
    const helper = await joinHelper(shop);
    for (const path of ["/v1/schedules", "/v1/inbound/attention"]) {
      expect(await asSession(helper.headers, "GET", path)).toEqual({ status: 403, body: { error: "owner_only" } });
      expect(await asSession(owner.headers, "GET", `${path}?tenant=${enc("pilot:other")}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
  });

  it("is 503 when what it reads cannot be read", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    expect(await callWith(failingWhere("TENANT", (request) => new URL(request.url).pathname === "/attention", true),
      "/v1/inbound/attention", { headers: owner.headers })).toEqual({ status: 503, body: { error: "attention_unavailable" } });
    const schedulesDown = { ...bindings, SCHEDULES: { idFromName: (id: string) => bindings.SCHEDULES.idFromName(id),
      get: () => ({ fetch: async () => Response.json({ error: "fixture" }, { status: 500 }) }) } as unknown as
      DurableObjectNamespace };
    expect(await callWith(schedulesDown, "/v1/schedules", { headers: owner.headers })).toEqual({ status: 503,
      body: { error: "schedules_unavailable" } });
  });
});
