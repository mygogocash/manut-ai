// What the team knows on the connected runtime (docs/runtime-adapter.md, "Customize › Memory and routines"; the routes are
// docs/pilot-api.md, "Memory", the owner's own routes): the shop's facts, read with its owner's session, and the owner's four
// changes. A fake of the API answers as apps/api does, through `@manut/shop-memory` itself. Each op is checked for the request it
// sends (the route, the shop's own session, exactly the fields the route reads), for every refusal it can get and the words each is
// said in, for a shop the person only helps at, for the shop the change names, while only a kept read is shown, and for a change that
// got no answer, which is never sent again.
import { MAX_FACTS, MAX_TEXT } from "@manut/shop-memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { createStore } from "../../state/store";
import { ShopCache } from "./cache";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { decodeFact, decodeFacts, decodeSource } from "./memory";
import { ApiSession } from "./session";
import { fakeApi, keptPlain, learned, memoryCacheStore, memoryVault, ORIGIN, serveShop, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, T0, useMicrotaskCrypto, type FakeApi, type ServedShops } from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
const SHOP_C = { id: "pilot:shop-c", name: "Baan Suk", ownerName: "Fon", role: "owner" as const };
const OWNER_C = shopToken(SHOP_C.id, "owner");

/** What Baan Mali's team has learned: four facts the owner's own data gave, and one a customer said, which waits. */
const BAAN_MALI = () =>
  learned(
    { text: "Free shipping on orders over ฿800", source: { kind: "document", name: "price list", date: Date.UTC(2026, 10, 3, 12) }, at: T0 - 5000 },
    { text: "Reply warmly and end with ค่ะ", source: { kind: "edits", count: 12 }, at: T0 - 4000 },
    { text: "Jasmine is the best seller", source: { kind: "orders", days: 90 }, at: T0 - 3000 },
    { text: "A jasmine candle costs ฿118 to make", source: { kind: "connection", name: "Google Sheets", detail: "cost sheet" }, at: T0 - 2000 },
    { text: "Closed on Mondays", source: { kind: "customer", chat: "chat-17" }, at: T0 - 1000 },
  );

async function opened(list = [SHOP_A, SHOP_B]) {
  const api = fakeApi();
  const shops = serveShops(api, list, {}, () => NOW);
  shops.memory[SHOP_A.id] = BAAN_MALI();
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
/** Every request that is not a GET, apart from opening a shop: what the owner's changes sent. */
const sent = (api: FakeApi) => api.calls.filter((c) => c.method !== "GET" && c.path !== "/v1/shops/session").map((c) => [c.method, c.path, c.bearer, c.body]);
const memoryCalls = (api: FakeApi) => api.calls.filter((c) => c.path.startsWith("/v1/memory"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
  // the kept read is sealed, and Node's Web Crypto finishes on its thread pool, which the fake clock never waits for
  useMicrotaskCrypto();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("reading what the team knows", () => {
  it("reads the shop's facts with its own owner session, oldest first, the waiting one included, and names the shop", async () => {
    const { api, req } = await opened();
    const { shop, facts } = await req("memory.list", {});
    expect(memoryCalls(api).map((c) => [c.method, c.path, c.bearer, c.body])).toEqual([["GET", "/v1/memory", OWNER_A, undefined]]);
    expect(shop).toBe(SHOP_A.id);
    expect(facts.map((f: { text: string; status: string }) => [f.text, f.status])).toEqual([
      ["Free shipping on orders over ฿800", "confirmed"],
      ["Reply warmly and end with ค่ะ", "confirmed"],
      ["Jasmine is the best seller", "confirmed"],
      ["A jasmine candle costs ฿118 to make", "confirmed"],
      ["Closed on Mondays", "waiting"],
    ]);
  });

  it("says where each fact came from, its times in seconds and a document's date in seconds too", async () => {
    const { req } = await opened();
    const { facts } = await req("memory.list", {});
    expect(facts.map((f: { id: string }) => f.id)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(facts.map((f: { source: unknown }) => f.source)).toEqual([
      { kind: "document", name: "price list", date: Date.UTC(2026, 10, 3, 12) / 1000 },
      { kind: "edits", count: 12 },
      { kind: "orders", days: 90 },
      { kind: "connection", name: "Google Sheets", detail: "cost sheet" },
      { kind: "customer", chat: "chat-17" },
    ]);
    expect(facts[0]).toMatchObject({ at: (T0 - 5000) / 1000, correctedAt: null });
  });

  it("reads each shop the person owns with that shop's own session, and the one the switcher shows", async () => {
    const { api, shops, req } = await opened([SHOP_A, SHOP_B, SHOP_C]);
    shops.memory[SHOP_C.id] = learned({ text: "Baan Suk opens at ten" });
    await req("shops.switch", { shop: SHOP_C.id });
    const { shop, facts } = await req("memory.list", {});
    expect(shop).toBe(SHOP_C.id);
    expect(facts.map((f: { text: string }) => f.text)).toEqual(["Baan Suk opens at ten"]);
    expect(memoryCalls(api).map((c) => c.bearer)).toEqual([OWNER_C]);
  });

  it("asks only when asked: the minute's read of the shop never reads what the team knows", async () => {
    const { api } = await opened();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(memoryCalls(api)).toEqual([]);
  });

  it("keeps none of it in the saved read of the shop, the offline cache, an event or an error", async () => {
    const { rt, disk, req } = await opened();
    const events: unknown[] = [];
    rt.onAny((ev) => events.push(ev));
    await req("memory.list", {});
    await req("memory.remember", { shop: SHOP_A.id, text: "Our supplier Somchai sells wax at ฿40 a kilo" });
    await vi.advanceTimersByTimeAsync(130_000);
    // what the saved read of the shop holds, opened: sealed, its text would hide what it held
    expect(disk.files.size).toBe(1);
    const everything = JSON.stringify([...(await keptPlain(disk)), events]);
    for (const word of ["jasmine", "Jasmine", "Somchai", "price list", "chat-17", "Closed on Mondays"]) expect(everything, word).not.toContain(word);
  });
});

describe("what the page is told when the team's memory cannot be read", () => {
  it("is the owner's: a shop the person only helps at is refused with nothing sent, and says whose it is", async () => {
    const { api, req } = await opened();
    await req("shops.switch", { shop: SHOP_B.id });
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "owner_only", message: t("memory.err.ownerOnly") });
    expect(memoryCalls(api)).toEqual([]);
  });

  it("has none for a person who is in no shops, and sends nothing", async () => {
    const api = fakeApi();
    serveShop(api);
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
    const rt = new HttpRuntime(new HttpHost({ session }));
    await rt.connect();
    const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "no_shop", message: t("memory.err.noShop") });
    for (const [op, params] of [
      ["memory.remember", { shop: null, text: "We ship on weekdays" }],
      ["memory.confirm", { shop: null, fact: "f1" }],
      ["memory.correct", { shop: null, fact: "f1", text: "We ship on weekdays" }],
      ["memory.forget", { shop: null, fact: "f1" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "no_shop", message: t("memory.err.noShop") });
    expect(memoryCalls(api)).toEqual([]);
  });

  it("says each way the API can fail a read, in words: its owner-only rule, no record of the shop, an object that did not answer", async () => {
    const { api, req } = await opened();
    api.on("GET", "/v1/memory", { status: 403, json: { error: "owner_only" } });
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "owner_only", message: t("memory.err.ownerOnly") });
    api.on("GET", "/v1/memory", { status: 404, json: { error: "not_found" } });
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "not_found", message: t("rt.notFound") });
    api.on("GET", "/v1/memory", { status: 503, json: { error: "memory_unavailable" } });
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "unavailable", message: t("memory.err.unavailable") });
    api.on("GET", "/v1/memory", { status: 400, json: { error: "invalid_request" } });
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "unavailable", message: t("memory.err.unavailable") });
    api.on("GET", "/v1/memory", "offline");
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "offline", message: t("rt.offline") });
  });

  it("shows nothing rather than half of what the team knows when any fact cannot be read", async () => {
    const { api, req } = await opened();
    const whole = { id: "f1", text: "Free shipping", status: "confirmed", createdAt: T0, updatedAt: T0, source: { kind: "owner" } };
    for (const bad of [
      { ...whole, status: "pending" },
      { ...whole, text: "" },
      { ...whole, id: "" },
      { ...whole, updatedAt: "yesterday" },
      { ...whole, correctedAt: "later" },
      { ...whole, source: { kind: "rumour" } },
      { ...whole, source: { kind: "document", name: "list" } },
      { ...whole, source: null },
      null,
    ]) {
      api.on("GET", "/v1/memory", { status: 200, json: { tenant: SHOP_A.id, facts: [whole, bad], forgottenCount: 0 } });
      expect(await refusal(req("memory.list", {})), JSON.stringify(bad)).toEqual({ code: "unavailable", message: t("memory.err.unreadable") });
    }
    api.on("GET", "/v1/memory", { status: 200, json: { tenant: SHOP_A.id, forgottenCount: 0 } });
    expect(await refusal(req("memory.list", {}))).toMatchObject({ code: "unavailable" });
  });

  it("decodes a fact the owner corrected, and every kind of source, as the package writes them", () => {
    const fact = { id: "f9", text: "Closed on Sundays", status: "confirmed", createdAt: 1000, updatedAt: 5000, correctedAt: 5000, source: { kind: "customer", chat: "c1" } };
    expect(decodeFact(fact)).toEqual({ id: "f9", text: "Closed on Sundays", status: "confirmed", source: { kind: "customer", chat: "c1" }, at: 5, correctedAt: 5 });
    expect(decodeFact({ ...fact, correctedAt: undefined })?.correctedAt).toBeNull();
    for (const source of [{ kind: "owner" }, { kind: "document", name: "n", date: 4000 }, { kind: "edits", count: 3 }, { kind: "orders", days: 7 }, { kind: "connection", name: "n", detail: "d" }, { kind: "customer", chat: "c" }])
      expect(decodeSource(source), JSON.stringify(source)).not.toBeNull();
    expect(decodeSource({ kind: "document", name: "n", date: 4000 })).toEqual({ kind: "document", name: "n", date: 4 });
    expect(decodeFacts({ facts: [] })).toEqual([]);
    expect(decodeFacts({ facts: "none" })).toBeNull();
  });

  it("is not read while only a kept read of the shop is shown, and sends nothing", async () => {
    const { api, host, req } = await opened();
    api.on("GET", "/v1/shops", "offline");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(host.cache.kind).toBe("showing");
    const before = api.calls.length;
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "offline", message: t("rt.offline") });
    expect(api.calls).toHaveLength(before);
  });
});

describe("the owner's changes", () => {
  it("remembers a fact through POST /v1/memory/remember with exactly { text }, the words trimmed, and the shop's own session", async () => {
    const { api, req } = await opened();
    const before = sent(api).length;
    const { fact } = await req("memory.remember", { shop: SHOP_A.id, text: "  We ship on weekdays  " });
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/memory/remember", OWNER_A, { text: "We ship on weekdays" }]]);
    expect(fact).toMatchObject({ id: "f6", text: "We ship on weekdays", status: "confirmed", source: { kind: "owner" }, correctedAt: null });
    expect((await req("memory.list", {})).facts.map((f: { text: string }) => f.text)).toContain("We ship on weekdays");
  });

  it("confirms a fact that waits through POST /v1/memory/confirm with exactly { id }, and it is then one the team uses", async () => {
    const { api, req } = await opened();
    const before = sent(api).length;
    const { fact } = await req("memory.confirm", { shop: SHOP_A.id, fact: "f5" });
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/memory/confirm", OWNER_A, { id: "f5" }]]);
    expect(fact).toMatchObject({ id: "f5", text: "Closed on Mondays", status: "confirmed", source: { kind: "customer", chat: "chat-17" } });
  });

  it("corrects a fact through POST /v1/memory/correct with exactly { id, text }, and it says it was corrected and keeps its source", async () => {
    const { api, req } = await opened();
    const before = sent(api).length;
    const { fact } = await req("memory.correct", { shop: SHOP_A.id, fact: "f1", text: " Free shipping on orders over ฿1,000 " });
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/memory/correct", OWNER_A, { id: "f1", text: "Free shipping on orders over ฿1,000" }]]);
    expect(fact).toMatchObject({ id: "f1", text: "Free shipping on orders over ฿1,000", status: "confirmed", source: { kind: "document", name: "price list" } });
    expect(fact.correctedAt).toBe(NOW / 1000);
  });

  it("forgets a fact through POST /v1/memory/forget with exactly { id }, and the answer names the fact and holds none of it", async () => {
    const { api, req } = await opened();
    const before = sent(api).length;
    const answer = await req("memory.forget", { shop: SHOP_A.id, fact: "f3" });
    expect(sent(api).slice(before)).toEqual([["POST", "/v1/memory/forget", OWNER_A, { id: "f3" }]]);
    expect(answer).toEqual({ fact: "f3" });
    expect(JSON.stringify(answer)).not.toContain("Jasmine");
    // and it is gone from what the API holds, words and id
    const { facts } = await req("memory.list", {});
    expect(facts.map((f: { id: string }) => f.id)).toEqual(["f1", "f2", "f4", "f5"]);
    expect(JSON.stringify(facts)).not.toContain("Jasmine is the best seller");
  });

  it("sends no tenant, shop or role with any change, which the API refuses", async () => {
    const { api, req } = await opened();
    await req("memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" });
    await req("memory.confirm", { shop: SHOP_A.id, fact: "f5" });
    await req("memory.correct", { shop: SHOP_A.id, fact: "f1", text: "Free shipping on orders over ฿900" });
    await req("memory.forget", { shop: SHOP_A.id, fact: "f2" });
    for (const [, , , body] of sent(api)) for (const key of ["shop", "tenant", "role", "fact"]) expect(Object.keys(body as object), key).not.toContain(key);
  });

  it("works through the app's own store: the list names the shop, and a change names it back", async () => {
    const { rt } = await opened();
    const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
    await store.actions.init();
    const { shop, facts } = await store.actions.memoryList();
    expect(facts).toHaveLength(5);
    const { fact } = await store.actions.memoryRemember(shop, "We ship on weekdays");
    expect(fact.text).toBe("We ship on weekdays");
    expect(await store.actions.memoryForget(shop, fact.id)).toEqual({ fact: fact.id });
  });
});

describe("a fact's words and id, checked before anything is sent", () => {
  it("refuses words the package would refuse, nothing sent: nothing, only spaces, and more than 280 characters", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const text of ["", "   ", "x".repeat(MAX_TEXT + 1), "ข".repeat(MAX_TEXT + 1), 7 as unknown as string]) {
      expect(await refusal(req("memory.remember", { shop: SHOP_A.id, text })), String(text).slice(0, 4)).toEqual({ code: "invalid_text", message: t("memory.refuse.invalid_text", { max: MAX_TEXT }) });
      expect(await refusal(req("memory.correct", { shop: SHOP_A.id, fact: "f1", text })), String(text).slice(0, 4)).toMatchObject({ code: "invalid_text" });
    }
    expect(api.calls).toHaveLength(before);
    // and what it takes, including Thai counted as letters and 280 whole, it sends
    await req("memory.remember", { shop: SHOP_A.id, text: "ก".repeat(MAX_TEXT) });
    expect(sent(api).at(-1)).toEqual(["POST", "/v1/memory/remember", OWNER_A, { text: "ก".repeat(MAX_TEXT) }]);
  });

  it("refuses a fact it cannot name as one that is gone, nothing sent: no id, an empty one, one over 64 characters, not text", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const fact of [undefined, "", "f".repeat(65), 5, null, ["f1"]]) {
      for (const op of ["memory.confirm", "memory.correct", "memory.forget"] as const)
        expect(await refusal(req(op, { shop: SHOP_A.id, fact, text: "Free shipping on orders over ฿900" })), `${op} ${JSON.stringify(fact)}`).toMatchObject({ code: "not_found" });
    }
    expect(api.calls).toHaveLength(before);
  });

  it("says a fact is gone before it says its new words are wrong, as the package does for a fact it does not hold", async () => {
    const { req } = await opened();
    expect(await refusal(req("memory.correct", { shop: SHOP_A.id, fact: "", text: "" }))).toMatchObject({ code: "not_found" });
  });
});

describe("a change names the shop its list was read for", () => {
  it("goes to the shop it names, with that shop's own session, although the switcher shows another by now", async () => {
    const { api, shops, req } = await opened([SHOP_A, SHOP_B, SHOP_C]);
    shops.memory[SHOP_C.id] = learned({ text: "Baan Suk opens at ten" });
    const listedForA = await req("memory.list", {});
    await req("shops.switch", { shop: SHOP_C.id });
    await req("memory.remember", { shop: listedForA.shop, text: "We ship on weekdays" });
    expect(sent(api).at(-1)).toEqual(["POST", "/v1/memory/remember", OWNER_A, { text: "We ship on weekdays" }]);
    expect(shops.memory[SHOP_A.id].facts.map((f) => f.text)).toContain("We ship on weekdays");
    // what Baan Suk's team knows is as it was, and no request carried its session
    expect(shops.memory[SHOP_C.id].facts.map((f) => f.text)).toEqual(["Baan Suk opens at ten"]);
    expect(api.calls.filter((c) => c.path.startsWith("/v1/memory")).every((c) => c.bearer !== OWNER_C)).toBe(true);
  });

  it("refuses, nothing sent, a shop that is not the person's, no shop at all, and a person's own tenant while they are in shops", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const shop of ["pilot:someone-elses", null, undefined, 7]) {
      for (const [op, params] of [
        ["memory.remember", { text: "We ship on weekdays" }],
        ["memory.confirm", { fact: "f5" }],
        ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
        ["memory.forget", { fact: "f1" }],
      ] as const)
        expect(await refusal(req(op, { shop, ...params })), `${op} ${String(shop)}`).toEqual({ code: "not_found", message: t("rt.notFound") });
    }
    expect(api.calls).toHaveLength(before);
  });

  it("refuses a shop the person only helps at, nothing sent, so a helper's session never carries what the owner typed", async () => {
    const { api, req } = await opened();
    const before = api.calls.length;
    for (const [op, params] of [
      ["memory.remember", { text: "Our supplier Somchai sells wax at ฿40 a kilo" }],
      ["memory.confirm", { fact: "f5" }],
      ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { fact: "f1" }],
    ] as const)
      expect(await refusal(req(op, { shop: SHOP_B.id, ...params })), op).toEqual({ code: "owner_only", message: t("memory.err.ownerOnly") });
    expect(api.calls).toHaveLength(before);
    expect(JSON.stringify(api.calls)).not.toContain("Somchai");
  });
});

describe("while only a kept read of the shop is shown", () => {
  it("sends none of the four changes, queues none, and sends none when the API is back", async () => {
    const { api, host, req } = await opened();
    api.on("GET", "/v1/shops", "offline");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(host.cache.kind).toBe("showing");
    const before = api.calls.length;
    for (const [op, params] of [
      ["memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" }],
      ["memory.confirm", { shop: SHOP_A.id, fact: "f5" }],
      ["memory.correct", { shop: SHOP_A.id, fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { shop: SHOP_A.id, fact: "f1" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "offline", message: t("rt.offline") });
    expect(api.calls).toHaveLength(before);
    api.on("GET", "/v1/shops", { status: 200, json: { shops: [SHOP_A, SHOP_B] } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent(api)).toEqual([]);
  });
});

describe("what the API refuses, said in words", () => {
  const change = (shop = SHOP_A.id) => ({ remember: { shop, text: "We ship on weekdays" }, confirm: { shop, fact: "f5" }, correct: { shop, fact: "f1", text: "Free shipping on orders over ฿900" }, forget: { shop, fact: "f1" } });

  it("says the package's own refusals the way the page does: the team already knows it, it is full, the fact is gone", async () => {
    const { shops, req } = await opened();
    // 409 already_known: the same words, however they are spaced or cased
    expect(await refusal(req("memory.remember", { shop: SHOP_A.id, text: "  jasmine is   the BEST seller " }))).toEqual({ code: "already_known", message: t("memory.refuse.already_known") });
    // the same refusal for a correction to the words another fact holds
    expect(await refusal(req("memory.correct", { shop: SHOP_A.id, fact: "f1", text: "Jasmine is the best seller" }))).toEqual({ code: "already_known", message: t("memory.refuse.already_known") });
    // 404 not_found for a fact the shop does not hold
    for (const [op, params] of [["memory.confirm", { fact: "f99" }], ["memory.correct", { fact: "f99", text: "Anything at all" }], ["memory.forget", { fact: "f99" }]] as const)
      expect(await refusal(req(op, { shop: SHOP_A.id, ...params })), op).toEqual({ code: "not_found", message: t("memory.refuse.not_found") });
    // 409 full at 200 facts, until one is forgotten
    for (let i = shops.memory[SHOP_A.id].facts.length; i < MAX_FACTS; i += 1) await req("memory.remember", { shop: SHOP_A.id, text: `Fact number ${i}` });
    expect(await refusal(req("memory.remember", { shop: SHOP_A.id, text: "One too many" }))).toEqual({ code: "full", message: t("memory.refuse.full", { max: MAX_FACTS }) });
    await req("memory.forget", { shop: SHOP_A.id, fact: "f1" });
    await req("memory.remember", { shop: SHOP_A.id, text: "One too many" });
  });

  it("says the API's owner-only rule, a body it could not read and a code it does not say, each in its own words", async () => {
    const { api, req } = await opened();
    const refuse = (path: string, status: number, error: string) => api.on("POST", path, { status, json: { error } });
    for (const [op, params, path] of [
      ["memory.remember", change().remember, "/v1/memory/remember"],
      ["memory.confirm", change().confirm, "/v1/memory/confirm"],
      ["memory.correct", change().correct, "/v1/memory/correct"],
      ["memory.forget", change().forget, "/v1/memory/forget"],
    ] as const) {
      refuse(path, 403, "owner_only");
      expect(await refusal(req(op, params)), `${op} owner_only`).toEqual({ code: "owner_only", message: t("memory.err.ownerOnly") });
      for (const [status, error] of [[400, "invalid_request"], [400, "invalid_json"], [413, "body_too_large"], [409, "forgotten"], [400, "invalid_source"], [405, "method_not_allowed"], [409, "something_new"]] as const) {
        refuse(path, status, error);
        expect(await refusal(req(op, params)), `${op} ${error}`).toEqual({ code: error, message: t("rt.change.refused") });
      }
    }
  });

  it("says each of those words in every language, none empty", () => {
    for (const l of LANGS)
      for (const k of ["memory.err.ownerOnly", "memory.err.noShop", "memory.err.unavailable", "memory.err.unreadable", "rt.change.refused", "rt.change.noReply", "rt.change.unreadable"] as const)
        expect(t(k, undefined, l).trim(), `${l} ${k}`).not.toBe("");
  });

  it("says the person's place in the shop ended, in the host's words, and shows the shop no more", async () => {
    const { shops, req } = await opened();
    shops.ended[SHOP_A.id] = { error: "removed", at: new Date(NOW - 60_000).toISOString() };
    const out = await refusal(req("memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" }));
    expect(out).toMatchObject({ code: "removed" });
    expect(out?.message).not.toBe("");
  });
});

describe("a change that got no answer", () => {
  const changes = [
    ["memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" }, "/v1/memory/remember"],
    ["memory.confirm", { shop: SHOP_A.id, fact: "f5" }, "/v1/memory/confirm"],
    ["memory.correct", { shop: SHOP_A.id, fact: "f1", text: "Free shipping on orders over ฿900" }, "/v1/memory/correct"],
    ["memory.forget", { shop: SHOP_A.id, fact: "f1" }, "/v1/memory/forget"],
  ] as const;

  it("is said as no reply, never as done, and is sent once and never again from here: not for a 5xx, not offline, not too slow", async () => {
    for (const [answer, words] of [
      [{ status: 503, json: { error: "memory_unavailable" } }, t("rt.change.noReply")],
      [{ status: 502, text: "<html>bad gateway</html>" }, t("rt.change.noReply")],
      ["failed", t("rt.change.noReply")],
      ["offline", t("rt.offline")],
    ] as const) {
      const { api, req } = await opened();
      for (const [op, params, path] of changes) {
        api.on("POST", path, answer);
        const out = await refusal(req(op, params));
        expect(out?.message, `${op} ${JSON.stringify(answer)}`).toBe(words);
        expect(out?.code, `${op} ${JSON.stringify(answer)}`).toMatch(/^(unavailable|offline)$/);
      }
      // one request each, and none later: the API may have it, and the next read of the list says
      await vi.advanceTimersByTimeAsync(130_000);
      for (const [op, , path] of changes) expect(api.to("POST", path), `${op} ${JSON.stringify(answer)}`).toHaveLength(1);
    }
  });

  it("is read again at once: the list asked for next is the read that says whether it happened", async () => {
    const { api, shops, req } = await opened();
    // the API makes the change and the answer is lost
    api.on("POST", "/v1/memory/remember", (call) => {
      const text = (call.body as { text: string }).text;
      shops.memory[SHOP_A.id] = learned(...shops.memory[SHOP_A.id].facts.map((f) => ({ text: f.text, source: f.source, at: f.createdAt })), { text });
      return "failed";
    });
    expect((await refusal(req("memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" })))?.message).toBe(t("rt.change.noReply"));
    const { facts } = await req("memory.list", {});
    expect(facts.map((f: { text: string }) => f.text)).toContain("We ship on weekdays");
    expect(api.to("POST", "/v1/memory/remember")).toHaveLength(1);
  });

  it("is not done when the answer cannot be read, however it came: an answer for another fact, or none of a fact", async () => {
    const { api, req } = await opened();
    api.on("POST", "/v1/memory/remember", { status: 200, json: {} });
    expect(await refusal(req("memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" }))).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    api.on("POST", "/v1/memory/confirm", { status: 200, json: { id: "f2", text: "Reply warmly", status: "confirmed", createdAt: 1, updatedAt: 1, source: { kind: "owner" } } });
    expect(await refusal(req("memory.confirm", { shop: SHOP_A.id, fact: "f5" }))).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    api.on("POST", "/v1/memory/correct", { status: 200, json: { id: "f1", text: "x", status: "maybe", createdAt: 1, updatedAt: 1, source: { kind: "owner" } } });
    expect(await refusal(req("memory.correct", { shop: SHOP_A.id, fact: "f1", text: "Free shipping on orders over ฿900" }))).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    api.on("POST", "/v1/memory/forget", { status: 200, json: { id: "f9" } });
    expect(await refusal(req("memory.forget", { shop: SHOP_A.id, fact: "f1" }))).toEqual({ code: "unavailable", message: t("rt.change.unreadable") });
    api.on("POST", "/v1/memory/forget", { status: 200, json: { removed: true } });
    expect(await refusal(req("memory.forget", { shop: SHOP_A.id, fact: "f1" }))).toMatchObject({ code: "unavailable" });
  });

  it("is sent again after a 401 only, as every shop request is: the session opens again once and the same body goes with it", async () => {
    const { api, shops, req } = await opened();
    const first = shopToken(SHOP_A.id, "owner", 1);
    // the API no longer takes the session it gave: the first send is answered 401 before it reads the body
    shops.refused.add(first);
    const { fact } = await req("memory.remember", { shop: SHOP_A.id, text: "We ship on weekdays" });
    expect(fact.text).toBe("We ship on weekdays");
    const posts = api.to("POST", "/v1/memory/remember");
    expect(posts.map((c) => c.bearer)).toEqual([first, shopToken(SHOP_A.id, "owner", 2)]);
    expect(posts.map((c) => c.body)).toEqual([{ text: "We ship on weekdays" }, { text: "We ship on weekdays" }]);
    // the fact exists once
    expect(shops.memory[SHOP_A.id].facts.filter((f) => f.text === "We ship on weekdays")).toHaveLength(1);
  });
});
