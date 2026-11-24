// What the store asks of the runtime for Customize, on the demo runtime: what the team knows and its routines. The store
// keeps none of it (the page holds its own copy); each action goes straight to the runtime and rejects with the runtime's
// own error, so a page can say why. A list says the shop it was read for and every change names that shop, so a change never
// lands on another shop because the switcher moved meanwhile.
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "./store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { HELPED_SHOP, OWN_SHOP } from "../runtime/mock/shops";

async function demoStore(): Promise<Store> {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  store.actions.firstRunEnd();
  return store;
}

describe("what the store asks of the runtime for what the team knows", () => {
  it("reads the facts, the waiting one included, and the shop they were read for", async () => {
    const { actions } = await demoStore();
    const { shop, facts } = await actions.memoryList();
    expect(shop).toBe(OWN_SHOP);
    expect(facts.map((f) => f.text)).toContain("Free shipping on orders over ฿800");
    expect(facts.filter((f) => f.status === "waiting").map((f) => f.text)).toEqual(["Closed on Mondays"]);
  });

  it("remembers, confirms, corrects and forgets for the shop the list named, and each answer is the runtime's", async () => {
    const { actions } = await demoStore();
    const { shop } = await actions.memoryList();
    const { fact } = await actions.memoryRemember(shop, "We ship on weekdays");
    expect(fact).toMatchObject({ text: "We ship on weekdays", status: "confirmed", source: { kind: "owner" } });
    const waiting = (await actions.memoryList()).facts.find((f) => f.status === "waiting");
    expect((await actions.memoryConfirm(shop, waiting?.id ?? "")).fact.status).toBe("confirmed");
    expect((await actions.memoryCorrect(shop, fact.id, "We ship on weekdays and Saturdays")).fact).toMatchObject({ text: "We ship on weekdays and Saturdays" });
    expect(await actions.memoryForget(shop, fact.id)).toEqual({ fact: fact.id });
    expect((await actions.memoryList()).facts.map((f) => f.id)).not.toContain(fact.id);
  });

  it("refuses with the runtime's own error, so a page can say why", async () => {
    const { actions } = await demoStore();
    await expect(actions.memoryRemember(OWN_SHOP, "   ")).rejects.toMatchObject({ code: "invalid_text" });
    await expect(actions.memoryConfirm(OWN_SHOP, "f999")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.memoryRemember(OWN_SHOP, "jasmine is the best seller")).rejects.toMatchObject({ code: "already_known" });
  });

  it("refuses a shop the person only helps at, and one that is not theirs, and keeps what the team knows as it was", async () => {
    const { actions } = await demoStore();
    for (const act of [
      () => actions.memoryRemember(HELPED_SHOP, "We ship on weekdays"),
      () => actions.memoryConfirm(HELPED_SHOP, "f5"),
      () => actions.memoryCorrect(HELPED_SHOP, "f1", "Free shipping on orders over ฿900"),
      () => actions.memoryForget(HELPED_SHOP, "f1"),
    ])
      await expect(act()).rejects.toMatchObject({ code: "owner_only" });
    await expect(actions.memoryRemember("practice:someone-elses", "We ship on weekdays")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.memoryRemember(null, "We ship on weekdays")).rejects.toMatchObject({ code: "not_found" });
    expect((await actions.memoryList()).facts).toHaveLength(5);
  });

  it("says a shop the person only helps at is its owner's, in place of a list", async () => {
    const store = await demoStore();
    await store.actions.switchShop(HELPED_SHOP);
    await expect(store.actions.memoryList()).rejects.toMatchObject({ code: "owner_only" });
  });
});

describe("what the store asks of the runtime for the team's routines", () => {
  it("reads the routines the canvas lists, and the shop they were read for", async () => {
    const { actions } = await demoStore();
    const { shop, routines } = await actions.routineList();
    expect(shop).toBe(OWN_SHOP);
    expect(routines.map((r) => r.name)).toEqual([
      "Morning brief",
      "Weekly growth brief",
      "Tell me and draft a restock order",
      "Send the books to FlowAccount",
      "Answer order-status questions",
    ]);
    // every one of the team's routines can be removed
    expect(routines.every((r) => r.removable)).toBe(true);
  });

  it("adds a routine, pauses it, resumes it and removes it, and each answer is the runtime's", async () => {
    const { actions } = await demoStore();
    const { shop } = await actions.routineList();
    const { routine } = await actions.routineCreate(shop, { name: "Tell me when a parcel is late", action: "draft", trigger: { kind: "daily", at: "15:00" } });
    expect(routine).toMatchObject({ when: "Every day at 15:00", enabled: true, asksFirst: false });
    expect((await actions.routinePause(shop, routine.id)).routine).toMatchObject({ enabled: false, next: null });
    expect((await actions.routineResume(shop, routine.id)).routine).toMatchObject({ enabled: true });
    expect(await actions.routineRemove(shop, routine.id)).toEqual({ routine: routine.id });
    expect((await actions.routineList()).routines.map((r) => r.id)).not.toContain(routine.id);
  });

  it("refuses with the runtime's own error, so a page can say why", async () => {
    const { actions } = await demoStore();
    await expect(actions.routinePause(OWN_SHOP, "no-such-routine")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.routineRemove(OWN_SHOP, "no-such-routine")).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.routineCreate(OWN_SHOP, { name: "Reply quietly", action: "reply", trigger: { kind: "daily", at: "09:00" }, asksFirst: false })).rejects.toMatchObject({ code: "must_ask_first" });
  });

  it("refuses a shop the person only helps at, and one that is not theirs, and keeps the routines as they were", async () => {
    const { actions } = await demoStore();
    const make = { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } } as const;
    await expect(actions.routineCreate(HELPED_SHOP, make)).rejects.toMatchObject({ code: "owner_only" });
    await expect(actions.routinePause(HELPED_SHOP, "r1")).rejects.toMatchObject({ code: "owner_only" });
    await expect(actions.routineResume(HELPED_SHOP, "r1")).rejects.toMatchObject({ code: "owner_only" });
    await expect(actions.routineRemove(HELPED_SHOP, "r1")).rejects.toMatchObject({ code: "owner_only" });
    await expect(actions.routineCreate("practice:someone-elses", make)).rejects.toMatchObject({ code: "not_found" });
    await expect(actions.routineRemove(null, "r1")).rejects.toMatchObject({ code: "not_found" });
    expect((await actions.routineList()).routines).toHaveLength(5);
  });

  it("says a shop the person only helps at is its owner's, in place of a list", async () => {
    const store = await demoStore();
    await store.actions.switchShop(HELPED_SHOP);
    await expect(store.actions.routineList()).rejects.toMatchObject({ code: "owner_only" });
  });
});
