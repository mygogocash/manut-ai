// Mission Control in the app's store, on the demo runtime: the job view and the activity log are places a page opens and
// goes back from, and the jobs, the log and Pause everyone are asked of the runtime through the store's own actions.
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "./store";
import { MockHost, MockRuntime } from "../runtime/mock";

async function demoStore(): Promise<Store> {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  store.actions.firstRunEnd();
  return store;
}

/** Lets the events a request caused reach the store. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("the job view and the activity log as places", () => {
  it("opens a job from History and the back arrow returns to History", async () => {
    const { actions, getState } = await demoStore();
    actions.openPage("history");
    actions.openJob("late-parcels");
    expect(getState().ui).toMatchObject({ view: "job", job: "late-parcels", back: "history" });
    actions.closeSettings();
    expect(getState().ui.view).toBe("history");
  });

  it("opens a job from Home or from a member's chat, and returns to where it was opened from", async () => {
    const store = await demoStore();
    store.actions.openPage("home");
    store.actions.openJob("late-parcels");
    expect(store.getState().ui).toMatchObject({ view: "job", back: "home" });
    store.actions.closeSettings();
    expect(store.getState().ui.view).toBe("home");
    await store.actions.selectBot("nam");
    store.actions.openJob("order-status");
    expect(store.getState().ui).toMatchObject({ view: "job", job: "order-status", back: "chat" });
    store.actions.closeSettings();
    expect(store.getState().ui.view).toBe("chat");
    expect(store.getState().selectedBot).toBe("nam");
  });

  it("opens the activity log from History, and a job opened from it goes back to History, as the other pages do", async () => {
    const { actions, getState } = await demoStore();
    actions.openPage("history");
    actions.openActivity();
    expect(getState().ui).toMatchObject({ view: "activity", back: "history" });
    actions.openJob("late-parcels");
    expect(getState().ui).toMatchObject({ view: "job", job: "late-parcels", back: "history" });
    actions.closeSettings();
    expect(getState().ui.view).toBe("history");
  });
});

describe("what the store asks of the runtime for Mission Control", () => {
  it("reads the jobs, one job, the activity log and the team's state", async () => {
    const { actions } = await demoStore();
    const { jobs } = await actions.missionJobs();
    expect(jobs.map((j) => j.id)).toContain("late-parcels");
    expect((await actions.missionJob("late-parcels")).title).toBe("Replies about late parcels");
    const log = await actions.missionActivity();
    expect(log.events.length).toBeGreaterThan(0);
    expect(log.keptMonths).toBe(12);
    expect(await actions.teamState()).toMatchObject({ paused: false, members: ["nam", "pim", "ton", "kit"] });
  });

  it("refuses with the runtime's own error, so a page can say why", async () => {
    const { actions } = await demoStore();
    await expect(actions.missionJob("no-such-job")).rejects.toMatchObject({ code: "not_found" });
  });

  it("pauses the team and the members' rows say so, then resumes and they do not", async () => {
    const { actions, getState } = await demoStore();
    expect(getState().bots.some((b) => b.paused)).toBe(false);
    expect(await actions.teamPause()).toMatchObject({ paused: true });
    await settle();
    expect(Object.fromEntries(getState().bots.map((b) => [b.name, b.paused ?? false]))).toEqual({ buddy: false, nam: true, pim: true, ton: true, kit: true });
    expect(await actions.teamResume()).toMatchObject({ paused: false });
    await settle();
    expect(getState().bots.some((b) => b.paused)).toBe(false);
  });
});
