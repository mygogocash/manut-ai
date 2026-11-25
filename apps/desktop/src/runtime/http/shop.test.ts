// Reading one shop from apps/api: its tasks with their exact actions (the task list, `GET /v1/tasks`, newest first, a page
// at a time; never the export), what waits for the owner (approval-core's records, `GET /v1/approvals?state=open`), its
// schedules and its inbound attention items. Decoding never throws, and what this app does not know is kept as the API
// wrote it.
import { describe, expect, it } from "vitest";
import { ApiSession, type StoredSession } from "./session";
import { LISTED_TASKS, readShop, readTaskList, readTaskPage, TASK_PAGE } from "./shop";
import { approvalJson, attentionJson, clock, fakeApi, iso, listedJson, memoryVault, ORIGIN, scheduleJson, T0, taskJson, taskPage, type FakeApi } from "./testkit";

const TASK = taskJson();
const SCHEDULE = scheduleJson();
const ATTENTION = attentionJson();
const APPROVAL = approvalJson();

function setup() {
  const api = fakeApi();
  const c = clock(T0 + 600_000);
  const saved: StoredSession = {
    v: 1,
    origin: ORIGIN,
    tenant: "apple:owner-1",
    deviceId: "device-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessExpiresAt: c.now() + 3600_000,
    signedInAt: c.now(),
  };
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(JSON.stringify(saved)), now: c.now });
  return { api, c, session };
}

function serve(api: FakeApi, over: { tasks?: unknown[]; schedules?: unknown; attention?: Parameters<FakeApi["on"]>[2]; approvals?: unknown } = {}) {
  api
    .on("GET", "/v1/tasks", (req) => taskPage(over.tasks ?? [TASK], req))
    .on("GET", "/v1/schedules", { status: 200, json: { schedules: over.schedules ?? [SCHEDULE] } })
    .on("GET", "/v1/inbound/attention", over.attention ?? { status: 200, json: { items: [ATTENTION] } })
    .on("GET", "/v1/approvals", { status: 200, json: { state: "open", approvals: over.approvals ?? [APPROVAL] } });
}

describe("readShop", () => {
  it("reads the four routes with the session's token, and only what waits for an answer", async () => {
    const { api, session, c } = setup();
    serve(api);
    const out = await readShop(session, c.now);
    expect(api.calls.map((r) => [r.method, r.path, r.bearer]).sort()).toEqual([
      ["GET", "/v1/approvals", "access-1"],
      ["GET", "/v1/inbound/attention", "access-1"],
      ["GET", "/v1/schedules", "access-1"],
      ["GET", "/v1/tasks", "access-1"],
    ]);
    expect(api.to("GET", "/v1/approvals")[0].url).toBe(`${ORIGIN}/v1/approvals?state=open`);
    expect(api.to("GET", "/v1/tasks")[0].url).toBe(`${ORIGIN}/v1/tasks?limit=25`);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const { snapshot } = out;
    expect(snapshot.readAt).toBe(c.now());
    expect(snapshot.tasks).toEqual([
      {
        id: "task-1",
        title: "Reply to Khun Mali",
        objective: "Answer her question about delivery",
        state: "waitingForAuthorization",
        createdAt: T0,
        updatedAt: T0 + 120_000,
        actions: [
          {
            id: "action-1",
            taskId: "task-1",
            operationType: "line.message.push",
            targetResourceId: "bot-user-1",
            recipients: ["U-customer"],
            payload: { text: "Your order ships tomorrow morning." },
            state: "proposed",
            proposedAt: T0 + 90_000,
            expiresAt: T0 + 24 * 3600_000,
            approvedAt: null,
            approvedBy: "",
            dispatchedAt: null,
            raw: TASK.actions[0],
          },
        ],
        attempts: [],
        draft: null,
        raw: listedJson(TASK),
      },
    ]);
    expect(snapshot.schedules).toEqual([
      {
        id: "sched-1",
        name: "Morning brief",
        prompt: "Tell me what came in overnight",
        hour: 8,
        minute: 30,
        weekdays: [2, 3, 4, 5, 6],
        timeZone: "Asia/Bangkok",
        enabled: true,
        revision: 2,
        nextFire: T0 + 3600_000,
        createdAt: T0 - 86_400_000,
        raw: SCHEDULE,
      },
    ]);
    expect(snapshot.attention).toEqual([{ ...ATTENTION, receivedAt: T0 + 30_000, raw: ATTENTION }]);
    expect(snapshot.attentionOff).toBe(false);
    // what waits for the owner, as approval-core's record and standing; the request's detail keeps the words it shows
    const record = APPROVAL.record as { status: string; request: Record<string, unknown> & { detail: Record<string, unknown> } };
    const { payloadHash: _hash, ...shown } = record.request.detail;
    expect(snapshot.approvals).toEqual([
      { taskId: "task-1", record: { ...record, request: { ...record.request, detail: shown } }, standing: { state: "open", reason: "waiting" }, passedOn: null, raw: APPROVAL },
    ]);
    expect(snapshot.unreadable).toEqual([]);
  });

  it("keeps what it does not know: new fields, states, operations and event kinds stay as the API wrote them", async () => {
    const { api, session, c } = setup();
    const task = {
      ...TASK,
      task: { ...TASK.task, state: "waitingForWeather", mood: "sunny" },
      actions: [{ ...TASK.actions[0], operationType: "shopee.price.set", state: "superseded", extra: [1, 2] }],
      nextThing: { a: 1 },
    };
    const schedule = { ...SCHEDULE, weekdays: [1, 9, "x"], cadence: "lunar" };
    const attention = { ...ATTENTION, eventType: "shopee.order.create", issueId: "order-3" };
    serve(api, { tasks: [task], schedules: [schedule], attention: { status: 200, json: { items: [attention] } } });
    const out = await readShop(session, c.now);
    if (!out.ok) throw new Error("expected a snapshot");
    const [t] = out.snapshot.tasks;
    expect(t.state).toBe("waitingForWeather");
    // the list carries the document whole, a field this app does not know included
    expect(t.raw).toEqual(listedJson(task));
    expect((t.raw as { task: { mood: string } }).task.mood).toBe("sunny");
    expect(t.actions[0]).toMatchObject({ operationType: "shopee.price.set", state: "superseded", raw: task.actions[0] });
    // weekday numbers outside 1 to 7 are left out of the days, but the schedule keeps them in `raw`
    expect(out.snapshot.schedules[0]).toMatchObject({ weekdays: [1], raw: schedule });
    expect(out.snapshot.attention[0]).toMatchObject({ eventType: "shopee.order.create", issueId: "order-3" });
  });

  it("keeps entries it cannot read in `unreadable`, never silently dropped", async () => {
    const { api, session, c } = setup();
    const noId = { task: { title: "no id" } };
    const badAction = { ...TASK, actions: [{ state: "proposed" }] };
    const noRequestId = approvalJson({ id: "" });
    serve(api, { schedules: [{ name: "no id" }], approvals: [noRequestId, APPROVAL] });
    // the list as an API that sent what this app cannot read would answer it: newest first, so the oldest last
    api.on("GET", "/v1/tasks", { status: 200, json: { tasks: [7, listedJson(badAction), noId], next: null } });
    const out = await readShop(session, c.now);
    if (!out.ok) throw new Error("expected a snapshot");
    expect(out.snapshot.tasks.map((t) => [t.id, t.actions.length])).toEqual([["task-1", 0]]);
    expect(out.snapshot.approvals.map((a) => a.record.request.id)).toEqual(["action-1"]);
    expect(out.snapshot.unreadable).toEqual([noId, { state: "proposed" }, 7, { name: "no id" }, noRequestId]);
  });

  it("reads odd shapes as empty rather than failing", async () => {
    const { api, session, c } = setup();
    api
      .on("GET", "/v1/tasks", { status: 200, json: { tasks: "none", next: 7 } })
      .on("GET", "/v1/schedules", { status: 200, json: [] })
      .on("GET", "/v1/inbound/attention", { status: 200, json: { items: null } })
      .on("GET", "/v1/approvals", { status: 200, json: { approvals: "none" } });
    const out = await readShop(session, c.now);
    expect(out).toMatchObject({ ok: true, snapshot: { tasks: [], schedules: [], attention: [], approvals: [], unreadable: [] } });
  });

  it("reads the attention feed as off when the API has it switched off, not as a failure", async () => {
    const { api, session, c } = setup();
    serve(api, { attention: { status: 403, json: { error: "feature_disabled", feature: "officeInbound" } } });
    const out = await readShop(session, c.now);
    expect(out).toMatchObject({ ok: true, snapshot: { attention: [], attentionOff: true } });
  });

  it("reads a deleted tenant as one with no tasks", async () => {
    const { api, session, c } = setup();
    serve(api);
    api.on("GET", "/v1/tasks", { status: 404, json: { error: "tenant_deleted", deletedAt: iso(T0) } });
    const out = await readShop(session, c.now);
    expect(out).toMatchObject({ ok: true, snapshot: { tasks: [] } });
  });

  it("fails as a whole, the worst reason first: signed out, then offline, then unavailable", async () => {
    /** `answers` by "METHOD path". */
    const run = async (answers: Record<string, Parameters<FakeApi["on"]>[2]>) => {
      const { api, session, c } = setup();
      serve(api);
      for (const [route, answer] of Object.entries(answers)) {
        const [method, path] = route.split(" ");
        api.on(method, path, answer);
      }
      return readShop(session, c.now);
    };
    expect(await run({ "GET /v1/schedules": { status: 500, json: {} } })).toEqual({ ok: false, failure: "unavailable" });
    expect(await run({ "GET /v1/tasks": { status: 503, json: { error: "tasks_unavailable" } } })).toEqual({ ok: false, failure: "unavailable" });
    // an API from before the list answers it 404: the read fails rather than show a shop with no tasks
    expect(await run({ "GET /v1/tasks": { status: 404, json: { error: "not_found" } } })).toEqual({ ok: false, failure: "unavailable" });
    expect(await run({ "GET /v1/schedules": { status: 400, json: { error: "tenant_required" } } })).toEqual({ ok: false, failure: "unavailable" });
    // what waits for the owner is never shown half read: the API answers 503 rather than leave one out
    expect(await run({ "GET /v1/approvals": { status: 503, json: { error: "approvals_unavailable" } } })).toEqual({ ok: false, failure: "unavailable" });
    expect(await run({ "GET /v1/approvals": { status: 400, json: { error: "invalid_state" } } })).toEqual({ ok: false, failure: "unavailable" });
    expect(await run({ "GET /v1/approvals": "offline" })).toEqual({ ok: false, failure: "offline" });
    expect(await run({ "GET /v1/schedules": "offline", "GET /v1/tasks": { status: 503, json: {} } })).toEqual({ ok: false, failure: "offline" });
    expect(
      await run({
        "GET /v1/inbound/attention": "offline",
        "GET /v1/schedules": { status: 401, json: {} },
        "POST /v1/auth/refresh": { status: 401, json: { error: "invalid_grant" } },
      }),
    ).toEqual({ ok: false, failure: "signed_out" });
  });

  it("reads the newest tasks a page at a time with the cursor each page gives, at most two pages, and keeps them oldest first", async () => {
    const tasks = (n: number) => Array.from({ length: n }, (_, i) => taskJson({ task: { id: `task-${i}`, title: `Task ${i}` }, actions: [] }));
    const ids = (out: Awaited<ReturnType<typeof readShop>>) => (out.ok ? out.snapshot.tasks.map((t) => t.id) : out.failure);
    // a shop of fewer than a page reads one page
    const one = setup();
    serve(one.api, { tasks: tasks(3) });
    expect(ids(await readShop(one.session, one.c.now))).toEqual(["task-0", "task-1", "task-2"]);
    expect(one.api.to("GET", "/v1/tasks").map((r) => r.url)).toEqual([`${ORIGIN}/v1/tasks?limit=25`]);
    // more than a page: the next page from the first page's cursor
    const two = setup();
    serve(two.api, { tasks: tasks(30) });
    expect(ids(await readShop(two.session, two.c.now))).toEqual(tasks(30).map((t) => t.task.id));
    expect(two.api.to("GET", "/v1/tasks").map((r) => r.url)).toEqual([`${ORIGIN}/v1/tasks?limit=25`, `${ORIGIN}/v1/tasks?limit=25&cursor=task-5`]);
    // more than the screens show: the newest fifty, and no third page
    const many = setup();
    serve(many.api, { tasks: tasks(70) });
    expect(ids(await readShop(many.session, many.c.now))).toEqual(tasks(70).slice(20).map((t) => t.task.id));
    expect(many.api.to("GET", "/v1/tasks")).toHaveLength(LISTED_TASKS / TASK_PAGE);
    // a page that fails fails the whole read: half a list is never shown as the whole one
    const broken = setup();
    serve(broken.api, { tasks: tasks(30) });
    broken.api.on("GET", "/v1/tasks", (req) => (new URL(req.url).searchParams.has("cursor") ? { status: 503, json: { error: "tasks_unavailable" } } : taskPage(tasks(30), req)));
    expect(await readShop(broken.session, broken.c.now)).toEqual({ ok: false, failure: "unavailable" });
    // it never reads the export, which holds every task's whole history
    for (const { api } of [one, two, many, broken]) expect(api.to("GET", "/v1/tenant/export")).toEqual([]);
  });
});

describe("the cursor the newest read stopped at", () => {
  const tasks = (n: number) => Array.from({ length: n }, (_, i) => taskJson({ task: { id: `task-${i}`, title: `Task ${i}` }, actions: [] }));
  const cursor = async (n: number) => {
    const { api, session, c } = setup();
    serve(api, { tasks: tasks(n) });
    const out = await readShop(session, c.now);
    return out.ok ? (out.snapshot.more ?? null) : out.failure;
  };

  it("is the id of the last task the list looked at when the shop has older ones, the oldest task the read holds", async () => {
    // 51 tasks: the newest 50 are task-1 .. task-50, and task-0 is older
    expect(await cursor(51)).toBe("task-1");
    expect(await cursor(70)).toBe("task-20");
    expect(await cursor(200)).toBe("task-150");
  });

  it("is none when the list ended within the newest read: a shop of 50 tasks or fewer has nothing older", async () => {
    for (const n of [0, 1, 25, 26, 49, 50]) expect(await cursor(n), `${n} tasks`).toBeNull();
  });

  it("is the one the second page gave, so a page after it is the next page of the list", async () => {
    const { api, session, c } = setup();
    serve(api, { tasks: tasks(80) });
    const out = await readShop(session, c.now);
    expect(out.ok && out.snapshot.more).toBe("task-30");
    // the page after it, as Show older reads it: task-29 .. task-5, then the five left
    const page = await readTaskPage((path) => session.read(path), "task-30");
    expect(page.kind === "ok" && page.tasks.map((t) => t.id)).toEqual(tasks(30).slice(5, 30).map((t) => t.task.id));
    expect(page.kind === "ok" && page.next).toBe("task-5");
    expect(api.to("GET", "/v1/tasks").at(-1)?.url).toBe(`${ORIGIN}/v1/tasks?limit=25&cursor=task-30`);
  });

  it("is kept by the read of the list itself, and none for a list that answered no page", async () => {
    const { api, session } = setup();
    serve(api, { tasks: tasks(80) });
    expect(await readTaskList((path) => session.read(path))).toMatchObject({ kind: "ok", next: "task-30" });
    api.on("GET", "/v1/tasks", { status: 404, json: { error: "tenant_deleted", deletedAt: iso(T0) } });
    expect(await readTaskList((path) => session.read(path))).toMatchObject({ kind: "refused", status: 404 });
    const { api: other, session: again, c } = setup();
    serve(other, { tasks: tasks(80) });
    other.on("GET", "/v1/tasks", { status: 404, json: { error: "tenant_deleted", deletedAt: iso(T0) } });
    const out = await readShop(again, c.now);
    expect(out.ok && out.snapshot.more).toBeUndefined();
  });
});

describe("readTaskPage", () => {
  const page = (json: unknown) => readTaskPage(async () => ({ kind: "ok" as const, status: 200, json }), "task-9");
  const entry = (id: string) => listedJson(taskJson({ task: { id, title: id }, actions: [] }));

  it("reads a page as the screens keep tasks, oldest first, with the cursor of the page after it, and null on the last", async () => {
    expect(await page({ tasks: [entry("task-8"), entry("task-7")], next: "task-7" })).toMatchObject({ kind: "ok", next: "task-7", tasks: [{ id: "task-7" }, { id: "task-8" }] });
    expect(await page({ tasks: [], next: null })).toMatchObject({ kind: "ok", tasks: [], next: null });
  });

  it("keeps an entry it cannot read in `unreadable`, never silently dropped", async () => {
    const out = await page({ tasks: [entry("task-8"), { task: { title: "no id" } }], next: null });
    expect(out.kind === "ok" && out.tasks.map((t) => t.id)).toEqual(["task-8"]);
    expect(out.kind === "ok" && out.unreadable).toEqual([{ task: { title: "no id" } }]);
  });

  it("is `unreadable` for a 200 that is not a page, never an empty page and never the end of the list", async () => {
    for (const json of [null, "oops", [], {}, { error: "oops" }, { tasks: "none", next: null }, { tasks: {}, next: null }, { tasks: [] }, { tasks: [], next: "" }, { tasks: [], next: 7 }, { tasks: [], next: undefined }]) {
      expect(await page(json), JSON.stringify(json)).toEqual({ kind: "unreadable" });
    }
  });

  it("asks for the page after the cursor it is given, and gives every other answer back as it came", async () => {
    const asked: string[] = [];
    const answers = [{ kind: "refused" as const, status: 400, code: "invalid_cursor", json: {} }, { kind: "offline" as const }, { kind: "signed_out" as const }, { kind: "unavailable" as const }];
    for (const answer of answers) expect(await readTaskPage(async (path) => (asked.push(path), answer), "a b/c")).toBe(answer);
    expect(new Set(asked)).toEqual(new Set(["/v1/tasks?limit=25&cursor=a%20b%2Fc"]));
  });
});
