// What the store asks of the runtime for Customize, on the demo runtime: what the team knows and its routines. The store
// keeps none of it (the page holds its own copy); each action goes straight to the runtime and rejects with the runtime's
// own error, so a page can say why.
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "./store";
import { MockHost, MockRuntime } from "../runtime/mock";

async function demoStore(): Promise<Store> {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  store.actions.firstRunEnd();
  return store;
}

describe("what the store asks of the runtime for what the team knows", () => {
  it("reads the facts, the waiting one included", async () => {
    const { actions } = await demoStore();
    const { facts } = await actions.memoryList();
    expect(facts.map((f) => f.text)).toContain("Free shipping on orders over ฿800");
    expect(facts.filter((f) => f.status === "waiting").map((f) => f.text)).toEqual(["Closed on Mondays"]);
  });

  it("remembers, confirms, corrects and forgets, and each answer is the runtime's", async () => {
    const { actions } = await demoStore();
    const { fact } = await actions.memoryRemember("We ship on weekdays");
    expect(fact).toMatchObject({ text: "We ship on weekdays", status: "confirmed", source: { kind: "owner" } });
    const waiting = (await actions.memoryList()).facts.find((f) => f.status === "waiting");
    expect((await actions.memoryConfirm(waiting?.id ?? "")).fact.status).toBe("confirmed");
    expect((await actions.memoryCorrect(fact.id, "We ship on weekdays and Saturdays")).fact).toMatchObject({ text: "We ship on weekdays and Saturdays" });
    expect(await actions.memoryForget(fact.id)).toEqual({ fact: fact.id });
    expect((await actions.memoryList()).facts.map((f) => f.id)).not.toContain(fact.id);
  });

  it("refuses with the runtime's own error, so a page can say why", async () => {
    const { actions } = await demoStore();
    await expect(actions.memoryRemember("   ")).rejects.toMatchObject({ code: "invalid_text" });
    await expect(actions.memoryConfirm("f999")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.memoryRemember("jasmine is the best seller")).rejects.toMatchObject({ code: "already_known" });
  });
});

describe("what the store asks of the runtime for the team's routines", () => {
  it("reads the routines the canvas lists", async () => {
    const { actions } = await demoStore();
    const { routines } = await actions.routineList();
    expect(routines.map((r) => r.name)).toEqual([
      "Morning brief",
      "Weekly growth brief",
      "Tell me and draft a restock order",
      "Send the books to FlowAccount",
      "Answer order-status questions",
    ]);
  });

  it("adds a routine, pauses it and resumes it, and each answer is the runtime's", async () => {
    const { actions } = await demoStore();
    const { routine } = await actions.routineCreate({ name: "Tell me when a parcel is late", action: "draft", trigger: { kind: "daily", at: "15:00" } });
    expect(routine).toMatchObject({ when: "Every day at 15:00", enabled: true, asksFirst: false });
    expect((await actions.routinePause(routine.id)).routine).toMatchObject({ enabled: false, next: null });
    expect((await actions.routineResume(routine.id)).routine).toMatchObject({ enabled: true });
  });

  it("refuses with the runtime's own error, so a page can say why", async () => {
    const { actions } = await demoStore();
    await expect(actions.routinePause("no-such-routine")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.routineCreate({ name: "Reply quietly", action: "reply", trigger: { kind: "daily", at: "09:00" }, asksFirst: false })).rejects.toMatchObject({ code: "must_ask_first" });
  });
});
