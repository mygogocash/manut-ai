// A shop the person owns, whole, on the connected runtime (docs/runtime-adapter.md, "A shop the person owns"): its tasks,
// threads and history from its export, read with its own owner session; its team as `GET /v1/routines` says it; Mission
// Control's jobs and activity log from its tasks and their runs; and the owner's everyday writes, pausing and resuming a
// routine and Pause everyone, each through apps/api's routines routes with that shop's session and nothing else. A shop
// the person helps at stays its asks only, and every other write stays "not yet".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { createStore } from "../../state/store";
import { ShopCache, decodeCached } from "./cache";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  approvalJson,
  attentionJson,
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  replyDetail,
  routineJson,
  scheduleJson,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  workerTaskJson,
  type ShopWorkJson,
} from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");

/** Baan Mali's work: Nam's reply draft (done, ฿0.38), Pim's post being written now, Ton's summary that failed on the
 *  budget; Ton's morning brief and Pim's weekly post as routines, each with its clock in the schedule object, and one
 *  schedule of the shop's own; one attention item. */
function work(over: Partial<ShopWorkJson> = {}): Partial<ShopWorkJson> {
  return {
    tasks: [
      workerTaskJson({ id: "worker-task-nam", member: "nam", claimedAt: T0 + 60_000, draft: "Thank you! Your parcel left this morning." }),
      workerTaskJson({ id: "worker-task-pim", member: "pim", job: "post", title: "A post", claimedAt: NOW - 30_000, finishedAt: null, draft: null }),
      workerTaskJson({ id: "worker-task-ton", member: "ton", job: "daily_summary", title: "Sales summary for 2026-11-22", claimedAt: T0 + 120_000, outcome: "failed", reason: "budget", draft: null, costSatang: 0, tokens: 0 }),
    ],
    schedules: [
      // the routines' clocks, which name their routine: the routine says them, so they are not listed again
      scheduleJson({ id: "clock-brief", name: "Morning brief", routineId: "rt-0001-brief" }),
      scheduleJson({ id: "clock-post", name: "Weekly post", routineId: "rt-0002-post" }),
      scheduleJson({ id: "sched-own", name: "Stock check", prompt: "Count the jasmine candles", hour: 18, minute: 0, weekdays: [1, 2, 3, 4, 5, 6, 7] }),
    ],
    attention: [attentionJson()],
    team: { paused: false, since: null, members: ["ton", "pim", "nam"] },
    routines: [
      routineJson(),
      routineJson({ id: "rt-0002-post", name: "Weekly post", action: "send", asksFirst: true, member: "pim", trigger: { kind: "weekly", weekdays: [1], at: "10:00" }, when: "Every Monday at 10:00" }),
      routineJson({ id: "rt-0003-books", name: "The books", action: "send", asksFirst: true, member: "ton", trigger: { kind: "monthly", day: "last", at: "18:00" }, when: "On the last day of the month at 18:00", paused: true, next: null }),
    ],
    ...over,
  };
}

async function opened(over: Partial<ShopWorkJson> = {}, list = [SHOP_A, SHOP_B], more: Record<string, Partial<ShopWorkJson>> = {}) {
  const api = fakeApi();
  const shops = serveShops(
    api,
    list,
    {
      [SHOP_A.id]: [approvalJson({ id: "a-reply", taskId: "task-reply", createdAt: T0 + 100_000, detail: replyDetail("a-reply", "We open at nine.") })],
      [SHOP_B.id]: [approvalJson({ id: "b-reply", createdAt: T0 + 200_000, detail: replyDetail("b-reply", "Yes, we deliver.") })],
    },
    () => NOW,
    { [SHOP_A.id]: work(over), ...more },
  );
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
  return { api, shops, disk, host, rt, req };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

/** What was sent beyond the reads: every request that is not a GET. */
const writes = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.bearer, c.body]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what an owner's shop session reads", () => {
  it("reads the shop's export and routines with its own owner session, and a helped shop's asks only", async () => {
    const { api } = await opened();
    for (const path of ["/v1/tenant/export", "/v1/routines"]) expect(api.to("GET", path).map((c) => c.bearer), path).toEqual([OWNER_A]);
    // never the lifted routes the API answers a shop session 401 on
    for (const path of ["/v1/schedules", "/v1/inbound/attention"]) expect(api.to("GET", path)).toEqual([]);
    expect(writes(api).every(([, path]) => path === "/v1/shops/session")).toBe(true);
  });

  it("shows the owned shop's tasks as Buddy's threads, with what a member drafted in the task's notes", async () => {
    const { req } = await opened();
    const { threads } = await req("thread.list", { bot: "buddy" });
    expect(threads.map((r: { thread: string }) => r.thread).sort()).toEqual(["worker-task-nam", "worker-task-pim", "worker-task-ton"]);
    // Pim's run can still act, so the row says the work is going on, although the task itself stays a draft
    expect(threads.find((r: { thread: string }) => r.thread === "worker-task-pim").running).toBe(true);
    const opened_ = await req("thread.open", { bot: "buddy", thread: "worker-task-nam" });
    const draft = opened_.messages.find((m: { id: string }) => m.id === "worker-task-nam:draft");
    expect(draft.text).toBe(t("rt.taskDraft", { who: "Nam", text: "Thank you! Your parcel left this morning." }));
    expect(draft.text).toContain("Nothing was sent");
    // a member has no threads of their own: every task is Buddy's, once
    expect((await req("thread.list", { bot: "nam" })).threads).toEqual([]);
  });

  it("shows the shop's attention items in Buddy's chat, and a member's chat empty", async () => {
    const { req } = await opened();
    const buddy = await req("chat.open", { bot: "buddy" });
    expect(buddy.messages.map((m: { id: string }) => m.id)).toEqual(["attention:att-1"]);
    const nam = await req("chat.open", { bot: "nam" });
    expect(nam).toMatchObject({ session_id: "main-nam", messages: [], running: false });
  });
});

describe("the team, as the API knows it", () => {
  it("lists Buddy, then the members the shop has on in the roster's order, each with what they do", async () => {
    const { req } = await opened();
    const { bots } = await req("bots.list", {});
    expect(bots.map((b: { name: string; display_name: string }) => [b.name, b.display_name])).toEqual([
      ["buddy", "Buddy"],
      ["nam", "Nam"],
      ["pim", "Pim"],
      ["ton", "Ton"],
    ]);
    expect(bots[1].description).toBe(t("onb.team.sales"));
    expect(bots[0].is_default).toBe(true);
    // Pim is writing the post now; Nam finished; Ton's run failed
    expect(bots.map((b: { name: string; running: boolean }) => [b.name, b.running])).toEqual([
      ["buddy", false],
      ["nam", false],
      ["pim", true],
      ["ton", false],
    ]);
    expect(bots.some((b: { paused?: boolean }) => b.paused)).toBe(false);
  });

  it("lists only the members the shop has on, and holds each of them but Buddy while everyone is paused", async () => {
    const { req } = await opened({ team: { paused: true, since: iso(NOW - 60_000), members: ["pim"] } });
    const { bots } = await req("bots.list", {});
    expect(bots.map((b: { name: string; paused?: boolean }) => [b.name, b.paused ?? false])).toEqual([
      ["buddy", false],
      ["pim", true],
    ]);
    // a member the shop does not have on is no member here
    expect(await refusal(req("chat.open", { bot: "nam" }))).toMatchObject({ code: "unknown_bot" });
  });

  it("shows Buddy alone while the person views a shop they help at, whose team is its owner's", async () => {
    const { req } = await opened();
    await req("shops.switch", { shop: SHOP_B.id });
    expect((await req("bots.list", {})).bots.map((b: { name: string }) => b.name)).toEqual(["buddy"]);
    expect((await req("thread.list", { bot: "buddy" })).threads).toEqual([]);
    expect((await req("jobs.list", {})).jobs).toEqual([]);
    // the team is its owner's to see, so the routines say so in place of a list
    expect(await refusal(req("routine.list", {}))).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" }) });
    expect(await refusal(req("team.state", {}))).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" }) });
  });
});

describe("the team's routines", () => {
  it("lists the routines first, in the API's words, then the shop's own schedules, and never a routine's clock", async () => {
    const { req } = await opened();
    const { shop, routines } = await req("routine.list", {});
    // the list says the shop it was read for, which every change names
    expect(shop).toBe(SHOP_A.id);
    expect(routines.map((r: { id: string }) => r.id)).toEqual(["rt-0001-brief", "rt-0002-post", "rt-0003-books", "sched-own"]);
    expect(routines[0]).toEqual({ id: "rt-0001-brief", name: "Morning brief", when: "Every day at 08:00", action: "brief", asksFirst: false, enabled: true, next: (T0 + 7 * 3600_000) / 1000, timeZone: "Asia/Bangkok", removable: true });
    expect(routines[2]).toMatchObject({ id: "rt-0003-books", enabled: false, next: null, asksFirst: true, action: "send", removable: true });
    // the shop's own schedule says nothing about the work, as before, and is shown and never changed
    expect(routines[3]).toMatchObject({ id: "sched-own", action: null, asksFirst: null, removable: false });
  });

  it("shows each member's routines on their Schedule tab, and the shop's own schedules on Buddy's", async () => {
    const { req } = await opened();
    const ton = (await req("routines.list", { bot: "ton" })).routines;
    expect(ton.map((r: { id: string; schedule: string; enabled: boolean }) => [r.id, r.schedule, r.enabled])).toEqual([
      ["rt-0001-brief", "0 8 * * *", true],
      // a timing cron cannot say in the app's words is the API's own words
      ["rt-0003-books", "On the last day of the month at 18:00", false],
    ]);
    expect((await req("routines.list", { bot: "pim" })).routines.map((r: { schedule: string }) => r.schedule)).toEqual(["0 10 * * 1"]);
    expect((await req("routines.list", { bot: "buddy" })).routines.map((r: { id: string }) => r.id)).toEqual(["sched-own"]);
    const automations = (await req("automations.list", {})).automations;
    expect(automations.map((a: { id: string; bot: string; paused: boolean }) => [a.id, a.bot, a.paused])).toEqual([
      ["sched-own", "buddy", false],
      ["rt-0001-brief", "ton", false],
      ["rt-0002-post", "pim", false],
      ["rt-0003-books", "ton", true],
    ]);
  });
});

describe("Mission Control", () => {
  it("lists each task as a job of the member whose run has it, where it stands, newest moved first", async () => {
    const { req } = await opened();
    const { jobs } = await req("jobs.list", {});
    expect(jobs.map((j: { id: string; bot: string; stage: string }) => [j.id, j.bot, j.stage])).toEqual([
      ["worker-task-pim", "pim", "working"],
      ["worker-task-ton", "ton", "failed"],
      ["worker-task-nam", "nam", "drafted"],
    ]);
  });

  it("opens a job whole: its goal, its draft, what its run cost and how long it took, and its trace", async () => {
    const { req } = await opened();
    const job = await req("jobs.get", { job: "worker-task-nam" });
    expect(job).toMatchObject({
      id: "worker-task-nam",
      bot: "nam",
      stage: "drafted",
      goal: "Draft a reply to a customer's message for the owner to read.",
      summary: "Thank you! Your parcel left this morning.",
      recipients: [],
      costSatang: 38,
      tookSeconds: 4,
    });
    expect(job.steps.map((s: { stage: string }) => s.stage)).toEqual(["working", "drafted"]);
    expect(job.trace).toEqual([{ tool: "nam · claude-haiku-5-5", found: "done", ms: 4_000, costSatang: 38, tokens: 640, result: "pass" }]);
    const failed = await req("jobs.get", { job: "worker-task-ton" });
    expect(failed.trace[0]).toMatchObject({ found: "failed: budget", result: "fail" });
    expect(await refusal(req("jobs.get", { job: "worker-task-none" }))).toMatchObject({ code: "not_found" });
  });

  it("logs each draft a member wrote as drafted, a reply's words private, and claims no span it does not keep", async () => {
    const { req } = await opened();
    const { events, keptMonths } = await req("activity.list", {});
    expect(keptMonths).toBeNull();
    expect(events.map((e: { id: string; who: string; status: string; kind: string }) => [e.id, e.who, e.status, e.kind])).toEqual([["worker-task-nam:draft", "nam", "drafted", "msg"]]);
    expect(events[0]).toMatchObject({ title: t("rt.ev.draft", { who: "Nam" }), where: t("rt.ev.app"), text: { body: "Thank you! Your parcel left this morning.", private: true } });
  });

  it("says the team's state as the API's pause holds it: routines only, the jobs running now going on", async () => {
    const { req } = await opened();
    expect(await req("team.state", {})).toEqual({
      paused: false,
      since: null,
      members: ["nam", "pim", "ton"],
      routines: 2,
      running: [{ id: "worker-task-pim", title: "A post", bot: "pim", out: null }],
      holds: "routines",
    });
  });
});

describe("the owner's everyday writes", () => {
  it("pauses everyone through POST /v1/team/pause with exactly {} and the shop's own session, and shows it at once", async () => {
    const { api, req } = await opened();
    const before = writes(api).length;
    const state = await req("team.pause", {});
    expect(writes(api).slice(before)).toEqual([["POST", "/v1/team/pause", OWNER_A, {}]]);
    expect(state).toMatchObject({ paused: true, since: NOW / 1000, members: ["nam", "pim", "ton"], holds: "routines" });
    expect((await req("bots.list", {})).bots.filter((b: { paused?: boolean }) => b.paused).map((b: { name: string }) => b.name)).toEqual(["nam", "pim", "ton"]);
    await vi.advanceTimersByTimeAsync(5);
    // the shop is read again after the change
    expect(api.to("GET", "/v1/routines").length).toBeGreaterThan(1);
    const resumed = await req("team.resume", {});
    expect(writes(api).at(-1)).toEqual(["POST", "/v1/team/resume", OWNER_A, {}]);
    expect(resumed).toMatchObject({ paused: false, since: null });
  });

  it("pauses and resumes one routine through the routines routes with exactly { routineId }", async () => {
    const { api, req } = await opened();
    const paused = await req("routine.pause", { shop: SHOP_A.id, routine: "rt-0001-brief" });
    expect(writes(api).at(-1)).toEqual(["POST", "/v1/routines/pause", OWNER_A, { routineId: "rt-0001-brief" }]);
    expect(paused.routine).toMatchObject({ id: "rt-0001-brief", enabled: false, next: null });
    expect((await req("routine.list", {})).routines[0]).toMatchObject({ id: "rt-0001-brief", enabled: false });
    const resumed = await req("routine.resume", { shop: SHOP_A.id, routine: "rt-0003-books" });
    expect(writes(api).at(-1)).toEqual(["POST", "/v1/routines/resume", OWNER_A, { routineId: "rt-0003-books" }]);
    expect(resumed.routine).toMatchObject({ id: "rt-0003-books", enabled: true });
    // the Automations page's pause is the same change, for a routine of the member it lists it under
    expect(await req("automations.pause", { bot: "pim", job: "rt-0002-post" })).toEqual({ job: "rt-0002-post" });
    expect(writes(api).at(-1)).toEqual(["POST", "/v1/routines/pause", OWNER_A, { routineId: "rt-0002-post" }]);
  });

  it("refuses here, sending nothing, a routine the read does not list, a schedule of the shop's own, and every other write", async () => {
    const { api, req } = await opened();
    const before = writes(api).length;
    expect(await refusal(req("routine.pause", { shop: SHOP_A.id, routine: "rt-9999-none" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(req("automations.pause", { bot: "buddy", job: "sched-own" }))).toEqual({ code: "not_yet", message: t("rt.notYet") });
    for (const [op, params] of [
      ["chat.send", { bot: "buddy", text: "Hello" }],
      ["chat.send", { bot: "nam", text: "Hello" }],
      ["automations.remove", { bot: "ton", job: "rt-0001-brief" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "not_yet", message: t("rt.notYet") });
    expect(writes(api).slice(before)).toEqual([]);
  });

  it("refuses a helper's every change to the team, sending nothing: the team is its owner's", async () => {
    const { api, req } = await opened();
    await req("shops.switch", { shop: SHOP_B.id });
    const before = writes(api).length;
    for (const op of ["team.pause", "team.resume"]) expect(await refusal(req(op, {})), op).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" }) });
    expect(await refusal(req("routine.pause", { shop: SHOP_B.id, routine: "rt-0001-brief" }))).toMatchObject({ code: "owner_only" });
    expect(writes(api).slice(before)).toEqual([]);
  });

  it("says the API's own refusal, and what it could not tell, in words, and reads the shop again", async () => {
    const { api, req } = await opened();
    api.on("POST", "/v1/team/pause", { status: 503, json: { error: "routines_unavailable" } });
    expect(await refusal(req("team.pause", {}))).toEqual({ code: "unavailable", message: t("rt.change.noReply") });
    api.on("POST", "/v1/routines/pause", { status: 400, json: { error: "invalid_request" } });
    expect(await refusal(req("routine.pause", { shop: SHOP_A.id, routine: "rt-0001-brief" }))).toEqual({ code: "invalid_request", message: t("rt.change.refused") });
    // nothing was taken as changed
    expect((await req("bots.list", {})).bots.some((b: { paused?: boolean }) => b.paused)).toBe(false);
  });
});

describe("reading an owned shop's work", () => {
  it("fails the whole read rather than show half a shop when its export cannot be read", async () => {
    const { api, host } = await opened();
    api.on("GET", "/v1/tenant/export", { status: 500, json: { error: "export_incomplete", failed: ["audit"] } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(host.link).toBe("unavailable");
  });

  it("shows the shop's asks only when its session may not read its work (403 owner_only)", async () => {
    const { api, req } = await opened();
    api.on("GET", "/v1/routines", { status: 403, json: { error: "owner_only" } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await req("bots.list", {})).bots.map((b: { name: string }) => b.name)).toEqual(["buddy"]);
    expect((await req("thread.list", { bot: "buddy" })).threads).toEqual([]);
  });

  it("keeps each owned shop's work under its own id, and shows it while the API cannot be reached", async () => {
    const { api, disk, host, req } = await opened();
    const [text] = [...disk.files.values()];
    const file = JSON.parse(text);
    const [a, b] = file.snapshot.shops;
    expect(a.id).toBe(SHOP_A.id);
    expect(Object.keys(a.work).sort()).toEqual(["attention", "routines", "schedules", "tasks", "team"]);
    expect(b.id).toBe(SHOP_B.id);
    expect(b.work).toBeUndefined();
    // the viewed shop's work is its record's alone, not kept twice
    expect(file.snapshot.tasks).toEqual([]);
    const kept = decodeCached(text, NOW);
    expect(kept.kind === "usable" && kept.snapshot.team?.members).toEqual(["nam", "pim", "ton"]);
    api.on("GET", "/v1/shops", "offline");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(host.cache.kind).toBe("showing");
    expect((await req("jobs.list", {})).jobs).toHaveLength(3);
    // a change to the team needs the live shop
    const before = writes(api).length;
    expect(await refusal(req("team.pause", {}))).toEqual({ code: "offline", message: t("rt.offline") });
    expect(writes(api).slice(before)).toEqual([]);
  });
});

describe("under the app's own store", () => {
  it("lists the owned shop's team, and holds every member but Buddy once everyone is paused", async () => {
    const { rt } = await opened();
    const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
    await store.actions.init();
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
    expect(store.getState().bots.map((b) => b.name)).toEqual(["buddy", "nam", "pim", "ton"]);
    await store.actions.teamPause();
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
    expect(store.getState().bots.filter((b) => b.paused).map((b) => b.name)).toEqual(["nam", "pim", "ton"]);
  });
});

describe("a change names the shop its list was read for", () => {
  /** A second shop the person owns, with a routine of its own. */
  const SHOP_C = { id: "pilot:shop-c", name: "Baan Suk", ownerName: "Fon", role: "owner" as const };
  const OWNER_C = shopToken(SHOP_C.id, "owner");
  const brewC = routineJson({ id: "rt-c-0001", name: "Baan Suk brief" });

  async function two() {
    return opened({}, [SHOP_A, SHOP_B, SHOP_C], { [SHOP_C.id]: { routines: [brewC] } });
  }

  it("names the shop each list was read for, and the shop viewed is the one it names", async () => {
    const { req } = await two();
    expect((await req("routine.list", {})).shop).toBe(SHOP_A.id);
    await req("shops.switch", { shop: SHOP_C.id });
    const listed = await req("routine.list", {});
    expect(listed.shop).toBe(SHOP_C.id);
    expect(listed.routines.map((r: { id: string }) => r.id)).toEqual(["rt-c-0001"]);
  });

  it("sends a change to the shop it names, with that shop's own session, although the switcher shows another by now", async () => {
    const { api, shops, req } = await two();
    const listedForA = await req("routine.list", {});
    // the person switches shops after the page read Baan Mali's routines, and then flips one of its switches
    await req("shops.switch", { shop: SHOP_C.id });
    const paused = await req("routine.pause", { shop: listedForA.shop, routine: "rt-0001-brief" });
    expect(writes(api).at(-1)).toEqual(["POST", "/v1/routines/pause", OWNER_A, { routineId: "rt-0001-brief" }]);
    expect(paused.routine).toMatchObject({ id: "rt-0001-brief", enabled: false });
    expect(shops.work[SHOP_A.id].routines.find((r) => r.id === "rt-0001-brief")).toMatchObject({ paused: true });
    // what the person is looking at is Baan Suk, which that change did not touch
    const nowViewing = await req("routine.list", {});
    expect(nowViewing.shop).toBe(SHOP_C.id);
    expect(nowViewing.routines.map((r: { id: string; enabled: boolean }) => [r.id, r.enabled])).toEqual([["rt-c-0001", true]]);
    expect(api.calls.filter((c) => c.path === "/v1/routines/pause").map((c) => c.bearer)).toEqual([OWNER_A]);
    // and Baan Mali, once shown again, has the change
    await req("shops.switch", { shop: SHOP_A.id });
    expect((await req("routine.list", {})).routines.find((r: { id: string }) => r.id === "rt-0001-brief")).toMatchObject({ enabled: false });
    expect(api.to("POST", "/v1/routines/pause").every((c) => c.bearer !== OWNER_C)).toBe(true);
  });

  it("refuses, sending nothing, a routine the named shop does not list, although another shop does", async () => {
    const { api, req } = await two();
    const before = writes(api).length;
    // rt-c-0001 is Baan Suk's, so asked of Baan Mali it is not there
    expect(await refusal(req("routine.pause", { shop: SHOP_A.id, routine: "rt-c-0001" }))).toMatchObject({ code: "not_found" });
    expect(await refusal(req("routine.resume", { shop: SHOP_C.id, routine: "rt-0001-brief" }))).toMatchObject({ code: "not_found" });
    expect(writes(api).slice(before)).toEqual([]);
  });

  it("refuses, sending nothing, a change that names no shop, one that is not the person's, and a person's own tenant", async () => {
    const { api, req } = await two();
    const before = writes(api).length;
    for (const named of [{}, { shop: null }, { shop: "pilot:someone-elses" }, { shop: 7 }])
      expect(await refusal(req("routine.pause", { ...named, routine: "rt-0001-brief" })), JSON.stringify(named)).toMatchObject({ code: "not_found" });
    expect(writes(api).slice(before)).toEqual([]);
  });

  it("refuses a shop the person helps at with the owner's name, sending nothing, and says the same of its list", async () => {
    const { api, req } = await two();
    const before = writes(api).length;
    for (const op of ["routine.pause", "routine.resume"])
      expect(await refusal(req(op, { shop: SHOP_B.id, routine: "rt-0001-brief" })), op).toEqual({ code: "owner_only", message: t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" }) });
    expect(writes(api).slice(before)).toEqual([]);
  });

  it("shows another shop's change at once only when it is the shop viewed, and tells the screens only then", async () => {
    const { rt, req } = await two();
    const heard: string[] = [];
    rt.on("routines.update", () => heard.push("routines.update"));
    // viewing Baan Mali: a change to Baan Suk leaves what is shown as it is
    await req("routine.pause", { shop: SHOP_C.id, routine: "rt-c-0001" });
    // the read that follows a change is waited for, so the next change is not read over by one made before it
    await vi.advanceTimersByTimeAsync(5);
    expect((await req("routine.list", {})).routines.find((r: { id: string }) => r.id === "rt-0001-brief")).toMatchObject({ enabled: true });
    expect(heard).toEqual([]);
    // a change to the shop viewed is shown and told
    await req("routine.pause", { shop: SHOP_A.id, routine: "rt-0001-brief" });
    await vi.advanceTimersByTimeAsync(5);
    expect(heard).toEqual(["routines.update"]);
  });
});
