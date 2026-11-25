// A shop the person helps at, on the connected runtime, end to end under the app's own store over a fake API that answers a helper's
// session as apps/api does (docs/runtime-adapter.md, "A shop the person helps at"; docs/people.md, "The helper's session"). The person
// owns Baan Mali and helps Noi at Ran Pa Noi. Pinned here in one place:
// - what a helper's session is sent: what waits (`GET /v1/approvals?state=open`), how an ask that left was settled (`state=recent`),
//   the live feed's ticket, a decision, a note passed on, and the end of the session at sign-out; nothing else, ever;
// - every page that is the owner's refused `owner_only` in the owner's name with nothing sent, or listing nothing, as the API would
//   answer the helper's session;
// - answering: approved and declined through the decide route with the helper's session, refused for its kind here or by
//   approval-core, at an older revision, and already decided by the owner, by a helper by name, or by a helper this app has no name for;
// - the owner removing the helper: the shop leaves in the API's words;
// - the switcher's mark, and what the offline cache keeps of a helper's shop: its asks, and nothing of its work.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayTime } from "../../app/time";
import { settleApproval } from "../../chat/cards/respond";
import { setLang, t } from "../../i18n";
import { shopItems } from "../../sidebar/ShopSwitcher";
import { createStore, selectAsks, type ApprovalItem, type Store } from "../../state/store";
import { CACHE_VERSION, ShopCache } from "./cache";
import { FEED_TICKET_PATH } from "./feed";
import { HttpHost, POLL_MS } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  approvalJson,
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  openedFile,
  ORIGIN,
  replyDetail,
  serveShops,
  settledJson,
  SHOP_A,
  SHOP_B,
  shopToken,
  socketOpener,
  storedSession,
  T0,
  useMicrotaskCrypto,
  type ServedShops,
} from "./testkit";
import { TEAM } from "./view";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
const HELPER_B = shopToken(SHOP_B.id, "helper");
const REMOVED_AT = "2026-11-22T03:00:00.000Z";
/** When someone else decided first, a minute before now. */
const FIRST = NOW - 60_000;

/** A worker's money request, as the job flow opens one, which only Noi may decide at Ran Pa Noi. */
const refund = (id: string, createdAt: number) =>
  approvalJson({ id, kind: "money", createdAt, detail: { actionId: id, operationType: "shopee.refund", targetResourceId: "RP-118" } });
const reply = (id: string, createdAt: number, text: string) => approvalJson({ id, createdAt, detail: replyDetail(id, text) });

async function settled() {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
}

async function opened() {
  const api = fakeApi();
  const shops: ServedShops = serveShops(api, [SHOP_A, SHOP_B], {
    [SHOP_A.id]: [reply("a-reply", T0 + 100_000, "Your parcel left this morning.")],
    [SHOP_B.id]: [
      reply("b-reply-1", T0 + 200_000, "We open at nine."),
      reply("b-reply-2", T0 + 210_000, "Yes, we deliver."),
      reply("b-reply-3", T0 + 220_000, "Thank you!"),
      // another helper, Ploy, passed this one on to Noi: the one place this app learns her name
      { ...refund("b-refund", T0 + 400_000), passedOn: { by: "helper-9", name: "Ploy", note: "It looks right to me.", at: iso(T0 + 450_000) } },
    ],
  });
  // the live feed is on, so each shop's own session mints its ticket
  api.on("POST", FEED_TICKET_PATH, (req) => {
    const held = shops.tokens.get(req.bearer ?? "");
    return held ? { status: 200, json: { feed: "on", protocol: "manut-feed.v1", ticket: `${Buffer.from(held.shop).toString("base64url")}.secret`, expiresIn: 30 } } : { status: 401, json: { error: "unauthorized" } };
  });
  const vault = memoryVault(storedSession(NOW));
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, onEnd: () => cache.clear() });
  const { open } = socketOpener();
  const host = new HttpHost({ session, cache, feed: { open } });
  const rt = new HttpRuntime(host);
  const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
  await store.actions.init();
  await settled();
  return { api, shops, vault, session, disk, host, rt, store };
}

const asks = (store: Store) => selectAsks(store.getState()).map((a) => a.item as ApprovalItem);
const card = (store: Store, id: string) => asks(store).find((a) => a.request_id === `${encodeURIComponent(SHOP_B.id)}/${id}@1`);
const cardEvenClosed = (store: Store, id: string) =>
  store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === `${encodeURIComponent(SHOP_B.id)}/${id}@1`);
/** Everything sent with the helper's session, as method, path and query. */
const helperCalls = (api: ReturnType<typeof fakeApi>) => api.calls.filter((c) => c.bearer === HELPER_B).map((c) => `${c.method} ${c.path}${new URL(c.url).search}`);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
const decided = (requestId: string, optionId: string) => ({
  status: 200,
  json: { result: { ok: true, decision: { requestId, optionId, seenRevision: 1, decidedBy: "helper-1", role: "helper", decidedAt: NOW } }, action: optionId === "approve" ? "confirmed" : "rejected" },
});
const already = (requestId: string, decidedBy: string, role: "owner" | "helper") => ({
  status: 409,
  json: { error: "already_decided", result: { ok: false, refused: "already_decided", decision: { requestId, optionId: "approve", seenRevision: 1, decidedBy, role, decidedAt: FIRST } }, action: "confirmed" },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
  useMicrotaskCrypto();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the shop in the switcher", () => {
  it("is listed after the one the person owns, marked Helper, and opens with a helper session the sign-in asked for", async () => {
    const { api, store, rt } = await opened();
    expect(store.getState().shops.list).toEqual([
      { id: SHOP_A.id, name: "Baan Mali", owner: "Fon", role: "owner" },
      { id: SHOP_B.id, name: "Ran Pa Noi", owner: "Noi", role: "helper" },
    ]);
    expect(shopItems(store.getState().shops.list, store.getState().shops.current).map((i) => [i.name, i.role])).toEqual([
      ["Baan Mali", "Owner"],
      ["Ran Pa Noi", "Helper"],
    ]);
    // the sign-in opens it as it opens the owned one, with exactly { shop }; the API's record of the person says the role
    expect(api.to("POST", "/v1/shops/session").map((c) => [c.bearer, c.body])).toContainEqual(["access-1", { shop: SHOP_B.id }]);
    await store.actions.switchShop(SHOP_B.id);
    await settled();
    expect((await rt.request("shops.list", {})).current).toBe(SHOP_B.id);
    // Buddy alone stands for its team: the helper's session is told nothing of the team
    expect((await rt.request("bots.list", {})).bots.map((b) => b.name)).toEqual([TEAM]);
  });
});

describe("what a helper's session is sent", () => {
  it("what waits there, the feed's ticket, and nothing of the owner's: no tasks, schedules, attention, routines, devices, memory or people", async () => {
    const { api } = await opened();
    expect(helperCalls(api)).toEqual(["GET /v1/approvals?state=open", `POST ${FEED_TICKET_PATH}`]);
    // the owned shop is read whole with its own owner session, as before
    for (const path of ["/v1/tasks", "/v1/schedules", "/v1/inbound/attention", "/v1/routines", "/v1/people/devices"]) {
      expect(api.calls.filter((c) => c.path === path).map((c) => c.bearer), path).toEqual([OWNER_A]);
    }
    // and the minute's read asks the same again, no more
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(helperCalls(api)).toEqual(["GET /v1/approvals?state=open", `POST ${FEED_TICKET_PATH}`, "GET /v1/approvals?state=open"]);
  });

  it("how an ask that left was settled, read once with the helper's own session", async () => {
    const { api, shops, store } = await opened();
    shops.approvals[SHOP_B.id] = shops.approvals[SHOP_B.id].filter((a) => (a as { record: { request: { id: string } } }).record.request.id !== "b-reply-1");
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: FIRST, option: "decline" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(helperCalls(api).filter((c) => c.includes("state=recent"))).toEqual(["GET /v1/approvals?state=recent"]);
    // the owner's decision is the owner's, by name, never "yours"
    expect(cardEvenClosed(store, "b-reply-1")).toMatchObject({ expired: "resolved", expiredNote: `Declined by Noi at ${dayTime(FIRST, NOW)}` });
  });
});

describe("each page that is the owner's, viewing the shop the person helps at", () => {
  it("is refused in the owner's name, with nothing sent, or lists nothing: the helper's session would be told owner_only", async () => {
    const { api, host, store } = await opened();
    await store.actions.switchShop(SHOP_B.id);
    await settled();
    const before = api.calls.length;
    const team = t("rt.ownerOnly", { owner: "Noi", shop: "Ran Pa Noi" });
    // the team and Pause everyone, the routines, Show older
    for (const [op, params] of [
      ["team.state", {}],
      ["team.pause", {}],
      ["team.resume", {}],
      ["routine.list", {}],
      ["routine.create", { shop: SHOP_B.id, name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" } }],
      ["routine.pause", { shop: SHOP_B.id, routine: "rt-0001-brief" }],
      ["jobs.older", {}],
    ] as const) {
      expect(await refusal(host.handle(op, params)), op).toEqual({ code: "owner_only", message: team });
    }
    // what the team knows, the connections, the Google Sheet and the people: each in its own words, all the owner's
    expect(await refusal(host.handle("memory.list", {}))).toEqual({ code: "owner_only", message: t("memory.err.ownerOnly") });
    expect(await refusal(host.handle("memory.remember", { shop: SHOP_B.id, text: "Closed on Mondays" }))).toMatchObject({ code: "owner_only" });
    expect(await refusal(host.handle("connections.list", {}))).toEqual({ code: "owner_only", message: t("conn.err.ownerOnly") });
    expect(await refusal(host.handle("google.status", {}))).toMatchObject({ code: "owner_only" });
    expect(await refusal(host.handle("people.list", {}))).toMatchObject({ code: "owner_only" });
    // past work, the activity log, the routines' list and Buddy's threads have nothing the helper's session could read
    expect(await host.handle("jobs.list", {})).toEqual({ jobs: [] });
    expect(await host.handle("activity.list", {})).toEqual({ events: [], keptMonths: null });
    expect(await host.handle("automations.list", {})).toEqual({ automations: [] });
    expect(await host.handle("thread.list", { bot: TEAM })).toEqual({ threads: [] });
    // and not one of those was sent anywhere
    expect(api.calls.slice(before)).toEqual([]);
  });
});

describe("answering what the shop asks of the helper", () => {
  it("approves and declines a reply through the decide route with the helper's session, exactly { optionId, seenRevision }", async () => {
    const { api, store } = await opened();
    api.on("POST", "/v1/approvals/b-reply-1/decision", decided("b-reply-1", "approve"));
    api.on("POST", "/v1/approvals/b-reply-2/decision", decided("b-reply-2", "decline"));
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBeNull();
    expect(await settleApproval(store, "buddy", card(store, "b-reply-2")!, "deny")).toBeNull();
    expect(api.calls.filter((c) => c.path.endsWith("/decision")).map((c) => [c.path, c.bearer, c.body])).toEqual([
      ["/v1/approvals/b-reply-1/decision", HELPER_B, { optionId: "approve", seenRevision: 1 }],
      ["/v1/approvals/b-reply-2/decision", HELPER_B, { optionId: "decline", seenRevision: 1 }],
    ]);
    expect(cardEvenClosed(store, "b-reply-1")?.resolved).toBe("once");
    expect(cardEvenClosed(store, "b-reply-2")?.resolved).toBe("deny");
  });

  it("refuses money here in the app's words, sending nothing, and says the same when approval-core refuses a kind", async () => {
    const { api, store } = await opened();
    // no answer offered, and no Ask Noi either: Ploy passed it on already, and a request is passed on once
    expect(card(store, "b-refund")).toMatchObject({ choices: [], passedOn: { name: "Ploy" } });
    expect(card(store, "b-refund")?.passOn).toBeUndefined();
    expect(await settleApproval(store, "buddy", card(store, "b-refund")!, "once")).toBe("Only Noi can approve money");
    expect(api.to("POST", "/v1/approvals/b-refund/decision")).toEqual([]);
    // the API's own refusal of the helper's role, for a kind this build let the card offer: named, and the card stays open
    api.on("POST", "/v1/approvals/b-reply-3/decision", { status: 403, json: { error: "not_permitted", result: { ok: false, refused: "not_permitted" } } });
    expect(await settleApproval(store, "buddy", card(store, "b-reply-3")!, "once")).toBe("Only Noi can decide this");
    expect(card(store, "b-reply-3")).toBeDefined();
  });

  it("refuses an older revision: one the read moved past here with nothing sent, and one the API says changed", async () => {
    const { api, shops, store, host } = await opened();
    api.on("POST", "/v1/approvals/b-reply-1/decision", { status: 409, json: { error: "changed", result: { ok: false, refused: "changed", currentRevision: 2 } } });
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBe(t("rt.ask.changed"));
    // the shop's own read now holds b-reply-2 at revision 2; the card the helper saw named revision 1
    shops.approvals[SHOP_B.id] = shops.approvals[SHOP_B.id].map((a) =>
      (a as { record: { request: { id: string } } }).record.request.id === "b-reply-2" ? approvalJson({ id: "b-reply-2", revision: 2, createdAt: T0 + 210_000, detail: replyDetail("b-reply-2", "Yes, we deliver on Sundays.") }) : a,
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const sent = api.calls.length;
    expect(await refusal(host.handle("approval.respond", { bot: TEAM, request_id: `${encodeURIComponent(SHOP_B.id)}/b-reply-2@1`, choice: "once" }))).toEqual({ code: "changed", message: t("rt.ask.changed") });
    expect(api.calls.slice(sent).filter((c) => c.method === "POST")).toEqual([]);
  });

  it("says who decided first: Noi by name, Ploy by the note she passed on, and a helper it has no name for", async () => {
    const { api, store } = await opened();
    api.on("POST", "/v1/approvals/b-reply-1/decision", already("b-reply-1", "owner-link", "owner"));
    api.on("POST", "/v1/approvals/b-reply-2/decision", already("b-reply-2", "helper-9", "helper"));
    api.on("POST", "/v1/approvals/b-reply-3/decision", already("b-reply-3", "helper-7", "helper"));
    const at = dayTime(FIRST, NOW);
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBe(`Already decided by Noi at ${at}`);
    expect(await settleApproval(store, "buddy", card(store, "b-reply-2")!, "once")).toBe(`Already decided by Ploy at ${at}`);
    expect(await settleApproval(store, "buddy", card(store, "b-reply-3")!, "deny")).toBe(`Already decided by a helper at ${at}`);
  });
});

describe("a helper the owner removed", () => {
  it("leaves the shop in the API's words at the answer that found it: its asks close, its session and kept read go", async () => {
    const { api, shops, store, vault } = await opened();
    shops.ended[SHOP_B.id] = { error: "removed", at: REMOVED_AT };
    shops.list = [SHOP_A];
    api.on("POST", "/v1/approvals/b-reply-1/decision", { status: 401, json: { error: "removed", removedAt: REMOVED_AT } });
    const words = "You no longer have access to Ran Pa Noi. Noi removed you on Sunday, November 22. Ask Noi if this is a mistake";
    expect(await settleApproval(store, "buddy", card(store, "b-reply-1")!, "once")).toBe(words);
    await settled();
    // a 401 removed is never answered by opening the shop again
    expect(api.to("POST", "/v1/shops/session").filter((c) => (c.body as { shop: string }).shop === SHOP_B.id)).toHaveLength(1);
    expect(cardEvenClosed(store, "b-refund")).toMatchObject({ expired: "cancelled", expiredNote: words });
    expect(JSON.parse(vault.value!).shops[SHOP_B.id]).toBeUndefined();
    expect(store.getState().shops).toMatchObject({ list: [{ id: SHOP_A.id }], left: [{ id: SHOP_B.id, why: "removed" }] });
  });
});

describe("kept for offline use", () => {
  it("keeps the helper's shop's asks under its own id, sealed with the rest, and nothing of its work", async () => {
    const { disk } = await opened();
    const [[, sealed]] = [...disk.files];
    const text = await openedFile(sealed);
    const file = JSON.parse(text);
    expect(file.v).toBe(CACHE_VERSION);
    const helped = file.snapshot.shops.find((p: { id: string }) => p.id === SHOP_B.id);
    expect(Object.keys(helped).sort()).toEqual(["approvals", "id", "name", "owner", "role"]);
    expect(helped).toMatchObject({ name: "Ran Pa Noi", owner: "Noi", role: "helper" });
    expect(helped.approvals.map((a: { record: { request: { id: string } } }) => a.record.request.id)).toEqual(["b-reply-1", "b-reply-2", "b-reply-3", "b-refund"]);
    expect(file.snapshot.shops.find((p: { id: string }) => p.id === SHOP_A.id).work).toBeDefined();
    expect(text).not.toMatch(/mhs1|mos1|access-|refresh-/);
  });
});
