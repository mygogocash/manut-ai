// The connected runtime under the app's own store, end to end over a fake API: what waits for the owner reaches Needs
// you, the shop's tasks are Buddy's threads, its schedules are on the Automations page, and pressing Approve is
// refused as "not yet" without settling anything, so the ask stays open and the API is sent nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleApproval } from "../../chat/cards/respond";
import { setLang, t } from "../../i18n";
import { createStore, selectAsks } from "../../state/store";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, memoryVault, ORIGIN, serveShop, storedSession, T0 } from "./testkit";

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
    expect(selectAsks(state).map((a) => [a.bot, a.item.kind, a.item.request_id])).toEqual([["buddy", "approval", "action-1"]]);
    expect(state.threads.buddy?.map((r) => [r.thread, r.title, r.needs])).toEqual([["task-1", "Reply to Khun Mali", true]]);
    expect(state.automations?.map((a) => [a.id, a.name, a.paused])).toEqual([["sched-1", "Morning brief", false]]);
  });

  it("refuses Approve as not yet, leaves the ask open, and sends the API nothing", async () => {
    const { api, store } = connectedStore();
    await store.actions.init();
    await vi.advanceTimersByTimeAsync(0);
    const [ask] = selectAsks(store.getState());
    expect(await settleApproval(store, "buddy", ask.item, "once")).toBe(t("rt.notYet"));
    expect(selectAsks(store.getState())).toHaveLength(1);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
