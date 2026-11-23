// Reading one shop from apps/api: its tasks with their exact-action approvals (the tenant export, the only session
// route that lists a tenant's own tasks), its schedules and its inbound attention items. Decoding never throws, and
// what this app does not know is kept as the API wrote it.
import { describe, expect, it } from "vitest";
import { ApiSession, type StoredSession } from "./session";
import { readShop } from "./shop";
import { attentionJson, clock, fakeApi, iso, memoryVault, ORIGIN, scheduleJson, T0, taskJson, type FakeApi } from "./testkit";

const TASK = taskJson();
const SCHEDULE = scheduleJson();
const ATTENTION = attentionJson();

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

function serve(api: FakeApi, over: { tasks?: unknown; schedules?: unknown; attention?: Parameters<FakeApi["on"]>[2] } = {}) {
  api
    .on("GET", "/v1/tenant/export", { status: 200, json: { tenant: "apple:owner-1", exportedAt: iso(T0), tasks: over.tasks ?? [TASK], schedules: [], attention: [] } })
    .on("GET", "/v1/schedules", { status: 200, json: { schedules: over.schedules ?? [SCHEDULE] } })
    .on("GET", "/v1/inbound/attention", over.attention ?? { status: 200, json: { items: [ATTENTION] } });
}

describe("readShop", () => {
  it("reads the three routes with the session's token", async () => {
    const { api, session, c } = setup();
    serve(api);
    const out = await readShop(session, c.now);
    expect(api.calls.map((r) => [r.method, r.path, r.bearer]).sort()).toEqual([
      ["GET", "/v1/inbound/attention", "access-1"],
      ["GET", "/v1/schedules", "access-1"],
      ["GET", "/v1/tenant/export", "access-1"],
    ]);
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
        events: 2,
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
            raw: TASK.actions[0],
          },
        ],
        raw: TASK,
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
    expect(t.raw).toEqual(task);
    expect(t.actions[0]).toMatchObject({ operationType: "shopee.price.set", state: "superseded", raw: task.actions[0] });
    // weekday numbers outside 1 to 7 are left out of the days, but the schedule keeps them in `raw`
    expect(out.snapshot.schedules[0]).toMatchObject({ weekdays: [1], raw: schedule });
    expect(out.snapshot.attention[0]).toMatchObject({ eventType: "shopee.order.create", issueId: "order-3" });
  });

  it("keeps entries it cannot read in `unreadable`, never silently dropped", async () => {
    const { api, session, c } = setup();
    const noId = { task: { title: "no id" } };
    const badAction = { ...TASK, actions: [{ state: "proposed" }] };
    serve(api, { tasks: [noId, badAction, 7], schedules: [{ name: "no id" }] });
    const out = await readShop(session, c.now);
    if (!out.ok) throw new Error("expected a snapshot");
    expect(out.snapshot.tasks.map((t) => [t.id, t.actions.length])).toEqual([["task-1", 0]]);
    expect(out.snapshot.unreadable).toEqual([noId, { state: "proposed" }, 7, { name: "no id" }]);
  });

  it("reads odd shapes as empty rather than failing", async () => {
    const { api, session, c } = setup();
    api
      .on("GET", "/v1/tenant/export", { status: 200, json: { tasks: "none" } })
      .on("GET", "/v1/schedules", { status: 200, json: [] })
      .on("GET", "/v1/inbound/attention", { status: 200, json: { items: null } });
    const out = await readShop(session, c.now);
    expect(out).toMatchObject({ ok: true, snapshot: { tasks: [], schedules: [], attention: [], unreadable: [] } });
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
    api.on("GET", "/v1/tenant/export", { status: 404, json: { error: "tenant_deleted", deletedAt: iso(T0) } });
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
    expect(await run({ "GET /v1/tenant/export": { status: 500, json: { error: "export_incomplete", failed: ["index"] } } })).toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(await run({ "GET /v1/schedules": { status: 400, json: { error: "tenant_required" } } })).toEqual({ ok: false, failure: "unavailable" });
    expect(await run({ "GET /v1/schedules": "offline", "GET /v1/tenant/export": { status: 503, json: {} } })).toEqual({ ok: false, failure: "offline" });
    expect(
      await run({
        "GET /v1/inbound/attention": "offline",
        "GET /v1/schedules": { status: 401, json: {} },
        "POST /v1/auth/refresh": { status: 401, json: { error: "invalid_grant" } },
      }),
    ).toEqual({ ok: false, failure: "signed_out" });
  });
});
