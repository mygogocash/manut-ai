// Several shops on the connected runtime, end to end under the app's own store, over a fake API (docs/several-shops.md,
// "How the desktop shows them"): each shop read with its own shop session; every shop's asks one Needs you, newest first,
// each naming its shop and offering what the person's role there allows; every answer, and a helper passing a request
// on, sent with the session of the card's own shop and never the one the switcher shows; a shop the person's place in
// ended dropped at once and said so; signing out ending every shop session; and each shop's asks kept apart offline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayTime } from "../../app/time";
import { settleApproval } from "../../chat/cards/respond";
import { setLang } from "../../i18n";
import { newestFirst } from "../../pages/NeedsPage";
import { approveFromNotification, createStore, selectAsks, type ApprovalItem, type Store } from "../../state/store";
import { CACHE_VERSION, ShopCache, cacheKey } from "./cache";
import { HttpHost, POLL_MS } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  approvalJson,
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  replyDetail,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  type FakeApi,
  type ServedShops,
} from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
const HELPER_B = shopToken(SHOP_B.id, "helper");
/** When the owner of Ran Pa Noi removed the person, in the API's words. */
const REMOVED_AT = "2026-11-22T03:00:00.000Z";

/** A worker's money request, as the job flow opens one: it names its operation and where it goes. */
const refund = (id: string, createdAt: number, target: string) =>
  approvalJson({ id, kind: "money", createdAt, detail: { actionId: id, operationType: "shopee.refund", targetResourceId: target } });

function served(api: FakeApi): ServedShops {
  return serveShops(api, [SHOP_A, SHOP_B], {
    [SHOP_A.id]: [
      approvalJson({ id: "a-reply", createdAt: T0 + 100_000, detail: replyDetail("a-reply", "Your parcel left this morning.") }),
      { ...refund("a-refund", T0 + 300_000, "SP-2291"), passedOn: { by: "helper-9", name: "Mint", note: "It looks right to me.", at: iso(T0 + 350_000) } },
    ],
    [SHOP_B.id]: [
      approvalJson({ id: "b-reply-1", createdAt: T0 + 200_000, detail: replyDetail("b-reply-1", "We open at nine.") }),
      approvalJson({ id: "b-reply-2", createdAt: T0 + 210_000, detail: replyDetail("b-reply-2", "Yes, we deliver.") }),
      approvalJson({ id: "b-reply-3", createdAt: T0 + 220_000, detail: replyDetail("b-reply-3", "Thank you!") }),
      refund("b-refund", T0 + 400_000, "RP-118"),
    ],
  });
}

async function settled() {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
}

async function opened() {
  const api = fakeApi();
  const shops = served(api);
  const vault = memoryVault(storedSession(NOW));
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  // as the app wires it (index.ts `sessionFor`): a session that ends forgets what was read with it
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
  await store.actions.init();
  await settled();
  return { api, shops, vault, session, disk, host, rt, store };
}

const asks = (store: Store) => selectAsks(store.getState()).map((a) => a.item as ApprovalItem);
const card = (store: Store, requestId: string) => asks(store).find((a) => a.request_id.endsWith(`/${requestId}@1`));
const cardEvenClosed = (store: Store, requestId: string) =>
  store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id.endsWith(`/${requestId}@1`));
const decided = (requestId: string) => ({
  status: 200,
  json: { result: { ok: true, decision: { requestId, optionId: "approve", seenRevision: 1, decidedBy: "helper-1", role: "helper", decidedAt: NOW } }, action: "confirmed" },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one Needs you across the shops", () => {
  it("reads each shop's asks once, with that shop's own session, and shows them newest first, each naming its shop", async () => {
    const { api, store } = await opened();
    expect(newestFirst(selectAsks(store.getState())).map((a) => [(a.item as ApprovalItem).shop?.name, a.item.request_id.split("/")[1]])).toEqual([
      ["Ran Pa Noi", "b-refund@1"],
      ["Baan Mali", "a-refund@1"],
      ["Ran Pa Noi", "b-reply-3@1"],
      ["Ran Pa Noi", "b-reply-2@1"],
      ["Ran Pa Noi", "b-reply-1@1"],
      ["Baan Mali", "a-reply@1"],
    ]);
    // the sign-in lists the shops and opens a session for each, with exactly { shop }; nothing else is read with it
    expect(api.calls.filter((c) => c.bearer === "access-1").map((c) => [c.method, c.path, c.body])).toEqual([
      ["GET", "/v1/shops", undefined],
      ["POST", "/v1/shops/session", { shop: SHOP_A.id }],
      ["POST", "/v1/shops/session", { shop: SHOP_B.id }],
    ]);
    expect(api.to("GET", "/v1/approvals").map((c) => [c.url, c.bearer])).toEqual([
      [`${ORIGIN}/v1/approvals?state=open`, OWNER_A],
      [`${ORIGIN}/v1/approvals?state=open`, HELPER_B],
    ]);
    // the owner's session of Baan Mali also reads its tasks, routines, schedules and attention items; the helper's session
    // of Ran Pa Noi reads nothing but what waits there; and no session reads the export
    for (const path of ["/v1/tasks", "/v1/routines", "/v1/schedules", "/v1/inbound/attention"]) expect(api.to("GET", path).map((c) => c.bearer)).toEqual([OWNER_A]);
    expect(api.to("GET", "/v1/tenant/export")).toEqual([]);
    for (const call of api.calls) expect(call.url, call.url).not.toMatch(/mos1|mhs1|access-/);
  });

  it("offers on each card only what the person's role at its shop allows", async () => {
    const { store } = await opened();
    // the owner decides a refund, and sees the note a helper passed on with it
    expect(card(store, "a-refund")).toMatchObject({
      choices: ["once", "deny"],
      shop: { id: SHOP_A.id, name: "Baan Mali", owner: "Fon", role: "owner" },
      passedOn: { name: "Mint", note: "It looks right to me." },
    });
    expect(card(store, "a-refund")?.passOn).toBeUndefined();
    // a helper decides a reply, and passes a refund on to the owner instead of approving it
    expect(card(store, "b-reply-1")).toMatchObject({ choices: ["once", "deny"], shop: { role: "helper", owner: "Noi" } });
    expect(card(store, "b-refund")).toMatchObject({ choices: [], passOn: true, shop: { role: "helper" } });
    expect(card(store, "b-refund")?.outdated).toBeUndefined();
  });

  it("lists the shops for the switcher, the owned one first and viewed", async () => {
    const { store, rt } = await opened();
    expect(store.getState().shops).toMatchObject({
      list: [
        { id: SHOP_A.id, name: "Baan Mali", owner: "Fon", role: "owner" },
        { id: SHOP_B.id, name: "Ran Pa Noi", owner: "Noi", role: "helper" },
      ],
      current: SHOP_A.id,
      left: [],
    });
    // the person owns the shop shown, so its team is listed: Buddy, then each member it has on
    expect((await rt.request("bots.list", {})).bots.map((b) => b.name)).toEqual(["buddy", "nam", "pim", "ton"]);
  });
});

describe("a decision goes with its own shop's session", () => {
  it("on every path that answers, never with the shop the switcher shows", async () => {
    const { api, store } = await opened();
    expect(store.getState().shops.current).toBe(SHOP_A.id);
    for (const id of ["b-reply-1", "b-reply-2", "b-reply-3", "a-reply"]) api.on("POST", `/v1/approvals/${id}/decision`, decided(id));
    // the card's buttons and Home's Approve
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBeNull();
    // the store's own path
    await store.actions.respondApproval(card(store, "b-reply-2")!.request_id, "once", "buddy");
    // Approve on a notification
    await approveFromNotification(store, "buddy", card(store, "b-reply-3")!.request_id);
    // and the other way round: viewing Ran Pa Noi, Baan Mali's ask goes with Baan Mali's own session
    await store.actions.switchShop(SHOP_B.id);
    await settled();
    expect(store.getState().shops.current).toBe(SHOP_B.id);
    expect(await settleApproval(store, "buddy", card(store, "a-reply")!, "once")).toBeNull();
    const sent = api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/decision"));
    expect(sent.map((c) => [c.path, c.bearer, c.body])).toEqual([
      ["/v1/approvals/b-reply-1/decision", HELPER_B, { optionId: "approve", seenRevision: 1 }],
      ["/v1/approvals/b-reply-2/decision", HELPER_B, { optionId: "approve", seenRevision: 1 }],
      ["/v1/approvals/b-reply-3/decision", HELPER_B, { optionId: "approve", seenRevision: 1 }],
      ["/v1/approvals/a-reply/decision", OWNER_A, { optionId: "approve", seenRevision: 1 }],
    ]);
    for (const id of ["b-reply-1", "b-reply-2", "b-reply-3", "a-reply"]) expect(cardEvenClosed(store, id)?.resolved, id).toBe("once");
  });

  it("says the owner decided first, by name, to a helper whose answer met it, and that the person did to the owner", async () => {
    const { api, store } = await opened();
    const first = NOW - 120_000;
    const met = (id: string, decidedBy: string) => () => {
      const decision = { requestId: id, optionId: "approve", seenRevision: 1, decidedBy, role: "owner", decidedAt: first };
      return { status: 409, json: { error: "already_decided", result: { ok: false, refused: "already_decided", decision }, action: "confirmed" } };
    };
    api.on("POST", "/v1/approvals/b-reply-1/decision", met("b-reply-1", "owner-link")).on("POST", "/v1/approvals/a-reply/decision", met("a-reply", "owner-session"));
    // Noi's own LINE link decided the reply at Ran Pa Noi, where the person is a helper: it was Noi's decision, not theirs
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBe(`Already decided by Noi at ${dayTime(first, NOW)}`);
    // and at Baan Mali, which the person owns, their own session decided it
    expect(await settleApproval(store, "buddy", card(store, "a-reply")!, "once")).toBe(`Already decided by you at ${dayTime(first, NOW)}`);
  });

  it("refuses here, sending nothing, what the person's role at the card's shop may not decide", async () => {
    const { api, store } = await opened();
    api.on("POST", "/v1/approvals/b-refund/decision", decided("b-refund"));
    expect(await settleApproval(store, "buddy", card(store, "b-refund")!, "once")).toBe("Only Noi can approve money");
    expect(api.to("POST", "/v1/approvals/b-refund/decision")).toEqual([]);
  });
});

describe("passing a request on", () => {
  it("sends exactly { note }, trimmed, with the helper's session of that shop, and the card shows it passed on", async () => {
    const { api, store, shops } = await opened();
    const path = "/v1/approvals/b-refund/pass-on";
    api.on("POST", path, () => {
      // the API keeps the note with the request; the next read lists it
      shops.approvals[SHOP_B.id] = shops.approvals[SHOP_B.id].map((a) =>
        (a as { record: { request: { id: string } } }).record.request.id === "b-refund" ? { ...(a as object), passedOn: { by: "helper-1", name: "Mint", note: "The jar arrived broken.", at: iso(NOW) } } : a,
      );
      return { status: 200, json: { passedOn: { requestId: "b-refund", kind: "money", by: "helper-1", note: "The jar arrived broken.", at: iso(NOW) } } };
    });
    await store.actions.passOnApproval(card(store, "b-refund")!.request_id, "  The jar arrived broken.  ", "buddy");
    expect(api.to("POST", path).map((c) => [c.bearer, c.body])).toEqual([[HELPER_B, { note: "The jar arrived broken." }]]);
    expect(card(store, "b-refund")).toMatchObject({ passedOn: { note: "The jar arrived broken." } });
    expect(card(store, "b-refund")?.passOn).toBeUndefined();
    // the read after it lists the note with the helper's name, and the card follows
    await settled();
    expect(card(store, "b-refund")).toMatchObject({ passedOn: { name: "Mint", note: "The jar arrived broken." }, choices: [] });
  });

  it("refuses here, sending nothing, a note that is empty or too long, and an ask the person may not pass on", async () => {
    const { api, store } = await opened();
    const id = card(store, "b-refund")!.request_id;
    await store.actions.passOnApproval(id, "   ", "buddy");
    expect(store.getState().lastError).toBe("Write a note of 1 to 500 characters");
    await store.actions.passOnApproval(id, "x".repeat(501), "buddy");
    await store.actions.passOnApproval(card(store, "b-reply-1")!.request_id, "for you", "buddy");
    expect(store.getState().lastError).toBe("You can decide this one yourself");
    await store.actions.passOnApproval(card(store, "a-refund")!.request_id, "for me", "buddy");
    expect(store.getState().lastError).toBe("Only a helper passes a request on");
    expect(api.calls.filter((c) => c.path.endsWith("/pass-on"))).toEqual([]);
  });
});

describe("switching shops", () => {
  it("shows the chosen shop on every page and reads them again, while every shop's asks stay", async () => {
    const { api, store, rt } = await opened();
    const before = asks(store).length;
    const reads = api.calls.length;
    await store.actions.switchShop(SHOP_B.id);
    await settled();
    expect(store.getState().shops.current).toBe(SHOP_B.id);
    expect((await rt.request("shops.list", {})).current).toBe(SHOP_B.id);
    expect(asks(store)).toHaveLength(before);
    // switching reads nothing new from the API: what a shop session may read of a shop is in every read already
    expect(api.calls.slice(reads).filter((c) => c.path !== "/v1/shops" && c.path !== "/v1/approvals")).toEqual([]);
    // an unknown shop is refused
    await store.actions.switchShop("pilot:not-mine");
    expect(store.getState().shops.current).toBe(SHOP_B.id);
  });
});

describe("a shop the person's place in ended", () => {
  it("is dropped at once on 401 removed: its asks close saying when, its session goes, and the switcher says so", async () => {
    const { store, shops, vault, disk } = await opened();
    shops.ended[SHOP_B.id] = { error: "removed", at: REMOVED_AT };
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    const words = "You no longer have access to Ran Pa Noi. Noi removed you on Sunday, November 22. Ask Noi if this is a mistake";
    expect(cardEvenClosed(store, "b-refund")).toMatchObject({ expired: "cancelled", expiredNote: words });
    expect(asks(store).every((a) => a.shop?.id === SHOP_A.id)).toBe(true);
    expect(JSON.parse(vault.value!).shops[SHOP_B.id]).toBeUndefined();
    expect(store.getState().shops).toMatchObject({
      list: [{ id: SHOP_A.id }],
      left: [{ id: SHOP_B.id, name: "Ran Pa Noi", owner: "Noi", why: "removed", at: Date.parse(REMOVED_AT) / 1000 }],
    });
    // the kept read no longer holds it
    const file = JSON.parse([...disk.files.values()][0]);
    expect(file.snapshot.shops.map((p: { id: string }) => p.id)).toEqual([SHOP_A.id]);
  });

  it("is dropped at the next read when it leaves the list, and its own session says why", async () => {
    const { store, shops, vault } = await opened();
    // the operator unlinked the person's account from Baan Mali, the shop being viewed
    shops.list = [SHOP_B];
    shops.ended[SHOP_A.id] = { error: "unlinked", at: REMOVED_AT };
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(cardEvenClosed(store, "a-reply")).toMatchObject({
      expired: "cancelled",
      expiredNote: "You no longer have access to Baan Mali. Your account was unlinked from it on Sunday, November 22",
    });
    expect(JSON.parse(vault.value!).shops[SHOP_A.id]).toBeUndefined();
    // every page now shows the shop that is left, and its asks are still there
    expect(store.getState().shops).toMatchObject({ list: [{ id: SHOP_B.id }], current: SHOP_B.id, left: [{ id: SHOP_A.id, why: "unlinked" }] });
    expect(card(store, "b-refund")).toBeDefined();
  });
});

describe("signing out", () => {
  it("ends every shop session with itself and exactly {}, then forgets every shop's session and kept read", async () => {
    const { api, session, vault, disk } = await opened();
    api.on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    expect(disk.files.size).toBe(1);
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(api.to("POST", "/v1/shops/session/end").map((c) => [c.bearer, c.body])).toEqual([
      [OWNER_A, {}],
      [HELPER_B, {}],
    ]);
    expect(vault.value).toBeNull();
    await settled();
    expect(disk.files.size).toBe(0);
  });
});

describe("offline", () => {
  it("keeps each shop's asks under its own id, shows every shop's while the API cannot be reached, and answers none", async () => {
    const { api, store, disk, host } = await opened();
    const [[key, text]] = [...disk.files];
    expect(key).toBe(cacheKey(ORIGIN, "apple:owner-1"));
    const file = JSON.parse(text);
    expect(file.v).toBe(CACHE_VERSION);
    expect(file.snapshot.shops.map((p: { id: string; approvals: { record: { request: { id: string } } }[] }) => [p.id, p.approvals.map((a) => a.record.request.id)])).toEqual([
      [SHOP_A.id, ["a-reply", "a-refund"]],
      [SHOP_B.id, ["b-reply-1", "b-reply-2", "b-reply-3", "b-refund"]],
    ]);
    expect(text).not.toMatch(/mos1|mhs1|access-|refresh-/);
    for (const route of ["/v1/shops", "/v1/approvals"]) api.on("GET", route, "offline");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(host.cache.kind).toBe("showing");
    expect(asks(store)).toHaveLength(6);
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBe("Connect to answer this");
    await store.actions.passOnApproval(card(store, "b-refund")!.request_id, "a note", "buddy");
    expect(store.getState().lastError).toBe("Connect to answer this");
    expect(api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/approvals/"))).toEqual([]);
  });
});
