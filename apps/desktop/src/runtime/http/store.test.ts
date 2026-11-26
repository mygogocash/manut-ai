// The connected runtime under the app's own store, end to end over a fake API: what waits for the owner reaches Needs
// you, the shop's tasks are Buddy's threads, its schedules are on the Automations page, and pressing Approve answers
// through the shop's decide route (every way that can go is in answering.test.ts). When the API cannot be reached the
// store opens on the last good read the app kept, where an ask cannot be answered, and replaces it when the API answers
// again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleApproval } from "../../chat/cards/respond";
import { setLang } from "../../i18n";
import { createStore, selectAsks } from "../../state/store";
import { ShopCache } from "./cache";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { actionJson, fakeApi, memoryCacheStore, memoryVault, ORIGIN, savedRead, serveShop, storedSession, T0, taskJson } from "./testkit";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 600_000);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

function connectedStore() {
  const api = fakeApi();
  serveShop(api);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(Date.now())) });
  const store = createStore(new HttpRuntime(new HttpHost({ session })), {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
  });
  return { api, store };
}

describe("the app's store on the connected runtime", () => {
  it("shows what waits for the owner in Needs you, the tasks as Buddy's threads and the schedules as automations", async () => {
    const { store } = connectedStore();
    await store.actions.init();
    await vi.advanceTimersByTimeAsync(0);
    const state = store.getState();
    expect(state.bots.map((b) => b.name)).toEqual(["buddy"]);
    expect(selectAsks(state).map((a) => [a.bot, a.item.kind, a.item.request_id])).toEqual([["buddy", "approval", "action-1@1"]]);
    expect(state.threads.buddy?.map((r) => [r.thread, r.title, r.needs])).toEqual([["task-1", "Reply to Khun Mali", true]]);
    expect(state.automations?.map((a) => [a.id, a.name, a.paused])).toEqual([["sched-1", "Morning brief", false]]);
  });

  it("answers Approve through the shop's decide route, and the ask leaves Needs you once the API took it", async () => {
    const { api, store } = connectedStore();
    await store.actions.init();
    await vi.advanceTimersByTimeAsync(0);
    const [ask] = selectAsks(store.getState());
    api.on("POST", "/v1/approvals/action-1/decision", () => {
      serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })] });
      return { status: 200, json: { result: { ok: true }, action: "confirmed" } };
    });
    expect(await settleApproval(store, "buddy", ask.item, "once")).toBeNull();
    expect(api.to("POST", "/v1/approvals/action-1/decision").map((c) => c.body)).toEqual([{ optionId: "approve", seenRevision: 1 }]);
    expect(selectAsks(store.getState())).toEqual([]);
  });
});

/** The store on a connected runtime that keeps its reads in `files` (what an earlier run left), with no way to the API. */
function offlineStore(files: Record<string, string>) {
  const api = fakeApi().on("GET", "/v1/tasks", "offline").on("GET", "/v1/schedules", "offline").on("GET", "/v1/inbound/attention", "offline");
  const cache = new ShopCache(memoryCacheStore(files));
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(Date.now())), onEnd: () => cache.clear() });
  const store = createStore(new HttpRuntime(new HttpHost({ session, cache })), {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
  });
  return { api, store };
}

/** Lets everything the store started when the runtime opened, which all answer in-process, run to its end. A timer asked
 *  for with no delay while the clock is moving is set a millisecond on, so the clock moves a few. */
async function settled() {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(5);
}

describe("the app's store when the API cannot be reached", () => {
  const EARLIER = T0 + 300_000;

  it("opens on the read the app kept: Buddy, the task, the schedule and what waits for the owner are there, and the ask cannot be answered", async () => {
    const { api, store } = offlineStore(await savedRead(EARLIER));
    await store.actions.init();
    await settled();
    const state = store.getState();
    expect(state.conn).toBe("open");
    expect(state.bots.map((b) => b.name)).toEqual(["buddy"]);
    expect(selectAsks(state).map((a) => [a.bot, a.item.kind, a.item.request_id])).toEqual([["buddy", "approval", "action-1@1"]]);
    expect(state.threads.buddy?.map((r) => [r.thread, r.title, r.needs])).toEqual([["task-1", "Reply to Khun Mali", true]]);
    expect(state.automations?.map((a) => [a.id, a.name, a.paused])).toEqual([["sched-1", "Morning brief", false]]);
    const [ask] = selectAsks(state);
    expect(await settleApproval(store, "buddy", ask.item, "once")).toBe("Connect to answer this");
    expect(selectAsks(store.getState())).toHaveLength(1);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("replaces what the kept read showed when the API answers again: an ask decided meanwhile leaves Needs you, and a new one arrives", async () => {
    const { api, store } = offlineStore(await savedRead(EARLIER));
    await store.actions.init();
    await settled();
    expect(selectAsks(store.getState()).map((a) => a.item.request_id)).toEqual(["action-1@1"]);
    // meanwhile the owner approved action-1 from the link on LINE, and the shop has made a new task with an ask of its own
    serveShop(api, {
      tasks: [
        taskJson({ actions: [actionJson({ state: "confirmed" })] }),
        taskJson({ task: { id: "task-7", title: "Weekend post" }, actions: [actionJson({ id: "action-9", payload: { text: "Open on Saturday." } })] }),
      ],
      schedules: [],
      attention: [],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await settled();
    const state = store.getState();
    expect(state.conn).toBe("open");
    expect(selectAsks(state).map((a) => a.item.request_id)).toEqual(["action-9@1"]);
    const old = state.chats.buddy?.items.find((i) => i.kind === "approval" && i.request_id === "action-1@1");
    expect(old).toMatchObject({ kind: "approval", expired: "resolved" });
    expect(state.threads.buddy?.map((r) => r.thread).sort()).toEqual(["task-1", "task-7"]);
    expect(state.automations ?? []).toEqual([]);
  });

  it("takes an ask out of Needs you as not answered when its whole task is gone by the time the API answers", async () => {
    const { api, store } = offlineStore(await savedRead(EARLIER));
    await store.actions.init();
    await settled();
    serveShop(api, { tasks: [], schedules: [], attention: [] });
    await vi.advanceTimersByTimeAsync(2_000);
    await settled();
    const state = store.getState();
    expect(selectAsks(state)).toEqual([]);
    expect(state.chats.buddy?.items.find((i) => i.kind === "approval" && i.request_id === "action-1@1")).toMatchObject({ expired: "cancelled" });
    expect(state.threads.buddy ?? []).toEqual([]);
  });
});
