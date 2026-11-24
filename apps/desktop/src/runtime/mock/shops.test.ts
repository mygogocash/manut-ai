// Practice's two sample shops (shops.ts): the person's own, which is the demo team's, and Ran Pa Noi, a sample shop they
// help at. /shops puts both shops' requests in Needs you, each naming its shop and offering what the person's role there
// allows; viewing Ran Pa Noi shows Buddy alone with the requests; and switching under the app's store reads every page
// again while every shop's asks stay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import type { BridgeEvent, EventOf } from "../../lib/protocol";
import { createStore, selectAsks, viewedShopName, type ApprovalItem } from "../../state/store";
import { MockHost, MockRuntime } from "./index";
import { HELPED_INTRO, HELPED_REFUSAL, HELPED_SHOP, OWN_SHOP } from "./shops";

const T0 = 1_800_000_000;

async function open(host = new MockHost({ now: () => T0 })) {
  const rt = new MockRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((e) => events.push(e));
  await rt.connect();
  const asks = () => events.filter((e): e is EventOf<"approval.request"> => e.event === "approval.request");
  return { rt, host, events, asks };
}

beforeEach(() => {
  vi.useFakeTimers();
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Practice's sample shops", () => {
  it("lists the person's own shop first, unnamed so the app names it as the setup did, then Ran Pa Noi, where they help", async () => {
    const { rt } = await open();
    expect(await rt.request("shops.list", {})).toEqual({
      shops: [
        { id: OWN_SHOP, name: "", owner: "", role: "owner" },
        { id: HELPED_SHOP, name: "Ran Pa Noi", owner: "Noi", role: "helper" },
      ],
      current: OWN_SHOP,
      left: [],
    });
  });

  it("waits on nothing until /shops, then asks in Buddy's chat from both shops, each offering what the role there allows", async () => {
    const { rt, asks } = await open();
    expect(asks()).toEqual([]);
    expect((await rt.request("commands.list", { bot: "buddy" })).commands.map((c) => c.name)).toContain("shops");
    await rt.request("chat.send", { bot: "nam", text: "/shops" });
    await vi.advanceTimersByTimeAsync(400);
    const byId = Object.fromEntries(asks().map((a) => [a.request_id, a]));
    expect(Object.keys(byId)).toEqual(["shop-ask-refund-350", "shop-ask-reply-ploy", "shop-ask-refund-120"]);
    for (const a of asks()) expect(a.bot).toBe("buddy");
    // their own shop's refund: theirs to decide, with the note Mint passed on
    expect(byId["shop-ask-refund-350"]).toMatchObject({ kind: "money", choices: ["once", "deny"], shop: { id: OWN_SHOP, role: "owner" }, passed_on: { name: "Mint" } });
    expect(byId["shop-ask-refund-350"].asked_at).toBe(T0 - 40 * 60);
    // at Ran Pa Noi a reply is theirs to decide, and money is Noi's: they may pass it on
    expect(byId["shop-ask-reply-ploy"]).toMatchObject({ kind: "reply", choices: ["once", "deny"], shop: { id: HELPED_SHOP, role: "helper", owner: "Noi" } });
    expect(byId["shop-ask-refund-120"]).toMatchObject({ kind: "money", choices: [], pass_on: true, shop: { role: "helper" } });
  });

  it("takes an answer once where the role may decide, refuses Noi's money, and passes it on once with a note", async () => {
    const { rt } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "/shops" });
    await vi.advanceTimersByTimeAsync(400);
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: "shop-ask-refund-120", choice: "once" })).rejects.toMatchObject({ code: "not_permitted" });
    await rt.request("approval.respond", { bot: "buddy", request_id: "shop-ask-reply-ploy", choice: "once" });
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: "shop-ask-reply-ploy", choice: "deny" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.request("approval.pass_on", { bot: "buddy", request_id: "shop-ask-refund-120", note: "  " })).rejects.toMatchObject({ code: "bad_note" });
    expect(await rt.request("approval.pass_on", { bot: "buddy", request_id: "shop-ask-refund-120", note: " Broken jar. " })).toEqual({ passed_on: { name: "", note: "Broken jar.", at: T0 } });
    await expect(rt.request("approval.pass_on", { bot: "buddy", request_id: "shop-ask-refund-120", note: "again" })).rejects.toMatchObject({ code: "already_passed" });
    await expect(rt.request("approval.pass_on", { bot: "buddy", request_id: "shop-ask-refund-350", note: "mine" })).rejects.toMatchObject({ code: "not_a_helper" });
    await expect(rt.request("approval.pass_on", { bot: "buddy", request_id: "shop-ask-reply-ploy", note: "mine" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("viewing Ran Pa Noi shows Buddy alone with the requests, and refuses the demo team's writes in words", async () => {
    const { rt, events, asks } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "/shops" });
    await vi.advanceTimersByTimeAsync(400);
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((e) => e.event === "shops.update")).toHaveLength(1);
    expect((await rt.request("shops.list", {})).current).toBe(HELPED_SHOP);
    expect((await rt.request("bots.list", {})).bots.map((b) => b.name)).toEqual(["buddy"]);
    const before = asks().length;
    const chat = await rt.request("chat.open", { bot: "buddy" });
    expect(chat.messages.map((m) => m.text)).toEqual([HELPED_INTRO]);
    await vi.advanceTimersByTimeAsync(0);
    expect(asks().length).toBe(before + 3);
    expect(await rt.request("jobs.list", {})).toEqual({ jobs: [] });
    await expect(rt.request("chat.send", { bot: "buddy", text: "hello" })).rejects.toMatchObject({ code: "not_yet", message: HELPED_REFUSAL });
    await expect(rt.request("shops.switch", { shop: "practice:nowhere" })).rejects.toMatchObject({ code: "not_found" });
    // back at their own shop, the demo team is there again
    await rt.request("shops.switch", { shop: OWN_SHOP });
    expect((await rt.request("bots.list", {})).bots.length).toBeGreaterThan(1);
  });
});

describe("switching shops under the app's store", () => {
  it("reads every page again for the shop now shown, while every shop's asks stay in Needs you", async () => {
    const host = new MockHost({ now: () => T0, pace: 0 });
    const store = createStore(new MockRuntime(host), { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
    await store.actions.init();
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(5);
    expect(store.getState().shops).toMatchObject({ current: OWN_SHOP, loaded: true });
    expect(store.getState().shops.list.map((s) => s.id)).toEqual([OWN_SHOP, HELPED_SHOP]);
    await store.actions.selectBot("buddy");
    await store.actions.send("/shops");
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(50);
    const shopAsks = () => selectAsks(store.getState()).filter((a) => (a.item as ApprovalItem).shop);
    expect(shopAsks()).toHaveLength(3);
    // asked at their own times, so Needs you can put the newest first
    expect(shopAsks().map((a) => a.ts)).toEqual([T0 - 40 * 60, T0 - 15 * 60, T0 - 5 * 60]);
    expect(store.getState().chats.nam).toBeDefined();
    await store.actions.switchShop(HELPED_SHOP);
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(5);
    const s = store.getState();
    expect(s.shops.current).toBe(HELPED_SHOP);
    expect(viewedShopName(s)).toBe("Ran Pa Noi");
    expect(s.bots.map((b) => b.name)).toEqual(["buddy"]);
    // the demo team's chats went with their shop; Buddy's chat is the helped shop's, with every shop's asks in it
    expect(s.chats.nam?.items ?? []).toEqual([]);
    expect(s.chats.buddy.items.filter((i) => i.kind === "assistant").map((i) => (i.kind === "assistant" ? i.text : ""))).toEqual([HELPED_INTRO]);
    expect(shopAsks()).toHaveLength(3);
  });
});

// Make your shop in Practice (Settings › Developer, MakeShop.tsx): no network, the API's refusals, and the shop listed with
// the person's others and shown, as the connected runtime shows one the API made.
describe("making a shop in Practice", () => {
  const make = (rt: MockRuntime, params: { name: string; ownerName: string; template: string | null }) =>
    (rt.request as unknown as (op: string, p: unknown) => Promise<{ shop: { id: string } }>)("shops.make", params);
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string }) => e.code);

  it("makes a shop of the person's own, lists it after their own and before Ran Pa Noi, and shows it", async () => {
    const { rt, events } = await open();
    const made = await make(rt, { name: "  Khao Hom ", ownerName: "Dao", template: "food" });
    expect(made).toEqual({ shop: { id: "practice:made-1", name: "Khao Hom", owner: "Dao", role: "owner" } });
    await vi.advanceTimersByTimeAsync(50);
    expect(events.some((e) => e.event === "shops.update")).toBe(true);
    expect(await rt.request("shops.list", {})).toEqual({
      shops: [
        { id: OWN_SHOP, name: "", owner: "", role: "owner" },
        { id: "practice:made-1", name: "Khao Hom", owner: "Dao", role: "owner" },
        { id: HELPED_SHOP, name: "Ran Pa Noi", owner: "Noi", role: "helper" },
      ],
      current: "practice:made-1",
      left: [],
    });
    // It is a shop like the others: the switcher moves away from it and back.
    await rt.request("shops.switch", { shop: OWN_SHOP });
    await rt.request("shops.switch", { shop: "practice:made-1" });
    expect((await rt.request("shops.list", {})).current).toBe("practice:made-1");
    // Its people and sign-ins are not pretended: Practice says so in words.
    expect(await refusal(rt.request("people.list", {}))).toBe("not_yet");
  });

  it("refuses as the API would: a name it would not keep, a kind it does not have, a fourth shop", async () => {
    const { rt } = await open();
    expect(await refusal(make(rt, { name: " ", ownerName: "Dao", template: null }))).toBe("invalid_name");
    expect(await refusal(make(rt, { name: "Khao Hom", ownerName: "x".repeat(81), template: null }))).toBe("invalid_owner_name");
    expect(await refusal(make(rt, { name: "Khao Hom", ownerName: "Dao", template: "bakery" }))).toBe("unknown_template");
    for (const name of ["One", "Two", "Three"]) expect((await make(rt, { name, ownerName: "Dao", template: null })).shop.id).toMatch(/^practice:made-/);
    expect(await refusal(make(rt, { name: "Four", ownerName: "Dao", template: null }))).toBe("too_many_shops");
    expect((await rt.request("shops.list", {})).shops).toHaveLength(5);
  });
});
