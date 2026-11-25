// How the card of an ask closes when the request left the open approvals and nobody here answered it (docs/runtime-adapter.md, "How a
// card closes when nobody here answered it"), end to end under the app's own store, over a fake API: the host reads the shop's recent
// requests once for each shop that has such an ask (`GET /v1/approvals?state=recent`, with that shop's own session) and the card says
// how it was settled, in plain words. A read that fails, answers anything but that list, does not list the request, or is slow leaves
// today's closing; no ask leaving means no read; an ask the person answered here is never looked up. The read only reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayTime } from "../../app/time";
import { settleApproval } from "../../chat/cards/respond";
import { setLang } from "../../i18n";
import { leftWords } from "../../lib/shops";
import { createStore, selectAsks, type ApprovalItem, type Store } from "../../state/store";
import { CACHE_VERSION, ShopCache } from "./cache";
import { HttpHost, LEFT_READ_MS, POLL_MS, type HostEvent } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import type { FetchLike } from "./shell";
import {
  actionJson,
  approvalJson,
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  replyDetail,
  serveShop,
  serveShops,
  settledJson,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  taskJson,
  tokens,
  type FakeApi,
  type Recent,
  type ServedShops,
} from "./testkit";

/** Makes the way the host says how a request was settled fail, for the one test that checks no card is left open for it. */
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("./decided", async (importOriginal) => {
  const real = await importOriginal<typeof import("./decided")>();
  return {
    ...real,
    closingFor: (...args: Parameters<typeof real.closingFor>) => {
      if (broken.on) throw new Error("a bug in saying how");
      return real.closingFor(...args);
    },
  };
});

const NOW = T0 + 600_000;
/** When someone decided, a few minutes before the person's computer read it. */
const AT = T0 + 420_000;
const RECENT = `${ORIGIN}/v1/approvals?state=recent`;
const PATH = "/v1/approvals/action-1/decision";
const OWNER_A = shopToken(SHOP_A.id, "owner");
const HELPER_B = shopToken(SHOP_B.id, "helper");
const REMOVED_AT = "2026-11-22T03:00:00.000Z";
const at = dayTime(AT, NOW);

interface Options {
  over?: Parameters<typeof serveShop>[1];
  /** the session's way to the API, given the fake API (to hold a read back) */
  fetch?: (api: FakeApi) => FetchLike;
}

/** Lets everything the store and the host started, which all answer in-process, run to its end. */
async function settled() {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
}

function connected(api: FakeApi, fetch?: FetchLike) {
  const vault = memoryVault(storedSession(NOW));
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  // as the app wires it (index.ts `sessionFor`): a session that ends forgets what was read with it
  const session = new ApiSession({ origin: ORIGIN, fetch: fetch ?? api.fetch, vault, onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  const store = createStore(rt, { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } });
  const events: HostEvent[] = [];
  host.subscribe((ev) => events.push(ev));
  return { api, vault, disk, session, host, rt, store, events };
}

/** The person in no shop: the signed-in tenant's own, read as before shops. */
async function opened(opts: Options = {}) {
  const api = serveShop(fakeApi(), opts.over);
  const s = connected(api, opts.fetch?.(api));
  await s.store.actions.init();
  await settled();
  return s;
}

/** The person in two shops, one they own and one they help at, each with its own session. */
async function openedShops(fetch?: (api: FakeApi, shops: ServedShops) => FetchLike, aReply: Parameters<typeof approvalJson>[0] = {}) {
  const api = fakeApi();
  const shops = serveShops(api, [SHOP_A, SHOP_B], {
    [SHOP_A.id]: [approvalJson({ id: "a-reply", createdAt: T0 + 100_000, detail: replyDetail("a-reply", "Your parcel left this morning."), ...aReply })],
    [SHOP_B.id]: [
      approvalJson({ id: "b-reply-1", createdAt: T0 + 200_000, detail: replyDetail("b-reply-1", "We open at nine.") }),
      approvalJson({ id: "b-reply-2", createdAt: T0 + 210_000, detail: replyDetail("b-reply-2", "Yes, we deliver.") }),
    ],
  });
  const s = connected(api, fetch?.(api, shops));
  await s.store.actions.init();
  await settled();
  return { ...s, shops };
}

/** The shop a minute on, with the reply no longer waiting (its action settled) and these as the shop's recent requests. */
async function minuteLater(api: FakeApi, recent: Recent, over: Parameters<typeof serveShop>[1] = {}) {
  serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent, ...over });
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await settled();
}

const cardOf = (store: Store, request: string) => store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === request);
const shopCard = (store: Store, request: string) => store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id.endsWith(`/${request}@1`));
const asks = (store: Store) => selectAsks(store.getState()).map((a) => a.item as ApprovalItem);
const reads = (api: FakeApi) => api.to("GET", "/v1/approvals").filter((c) => c.url.endsWith("state=recent"));
const closings = (events: HostEvent[]) => events.filter((e) => e.event === "prompt.expired");
/** What the app sent that decides or passes a request on: nothing here ever does. */
const decisions = (api: FakeApi) => api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/approvals"));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  broken.on = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a request decided elsewhere", () => {
  it("closes the card as approved by you, and says when, from one read of the shop's recent requests with the sign-in's session", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { api, store } = await opened();
    expect(reads(api)).toEqual([]);
    await minuteLater(api, [settledJson("decided", { at: AT })]);
    // the wait for the read is bounded, and it is started once
    expect(timers.mock.calls.filter(([, ms]) => ms === LEFT_READ_MS)).toHaveLength(1);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: `Approved by you at ${at}` });
    expect(asks(store)).toEqual([]);
    expect(reads(api).map((c) => [c.url, c.bearer])).toEqual([[RECENT, "access-1"]]);
    // the read only reads: nothing was decided, answered or sent
    expect(decisions(api)).toEqual([]);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("closes the card as declined by you, when the option the request offers that declines was chosen", async () => {
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT, option: "decline" })]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: `Declined by you at ${at}` });
  });

  it("says it was decided from the owner's link on LINE", async () => {
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT, by: "owner-link" })]);
    expect(cardOf(store, "action-1@1")?.expiredNote).toBe(`Approved from your LINE link at ${at}`);
  });

  it("names a helper by the name a note they passed on carries, in the open list or in the recent one", async () => {
    const note = { by: "helper-mint", name: "Mint", note: "The jar arrived broken.", at: iso(T0 + 200_000) };
    const refund = approvalJson({ id: "req-5", kind: "money", createdAt: T0 + 100_000, detail: { operationType: "money.refund", targetResourceId: "order-17" }, passedOn: note });
    // Mint's name is in the open list, where the refund waits
    const open = await opened({ over: { approvals: [approvalJson(), refund] } });
    await minuteLater(open.api, [settledJson("decided", { at: AT, by: "helper-mint", role: "helper" })], { approvals: [refund] });
    expect(cardOf(open.store, "action-1@1")?.expiredNote).toBe(`Approved by Mint at ${at}`);
    expect(asks(open.store).map((a) => a.request_id)).toEqual(["req-5@1"]);
    // or in the recent list, with a request settled since
    const recent = await opened();
    const passed = settledJson("expired", { id: "req-6", kind: "money", passedOn: note });
    await minuteLater(recent.api, [settledJson("decided", { at: AT, by: "helper-mint", role: "helper", option: "decline" }), passed]);
    expect(cardOf(recent.store, "action-1@1")?.expiredNote).toBe(`Declined by Mint at ${at}`);
  });

  it("calls a helper it has no name for a helper", async () => {
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT, by: "helper-9", role: "helper" })]);
    expect(cardOf(store, "action-1@1")?.expiredNote).toBe(`Approved by a helper at ${at}`);
  });

  it("says it was approved, with no verb for who or when, when the API told no time", async () => {
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: 0 })]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: "Approved" });
  });

  it("goes by what the option does: an option called decline that approves is an approval", async () => {
    const options = [
      { id: "decline", label: "Deny", effect: "approve" },
      { id: "approve", label: "Allow", effect: "decline" },
    ];
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT, options, option: "decline" })]);
    expect(cardOf(store, "action-1@1")?.expiredNote).toBe(`Approved by you at ${at}`);
  });

  it("closes the card of a request withdrawn, ended or timed out in the words the answer path says them in", async () => {
    const cases: [Parameters<typeof settledJson>[0], Parameters<typeof settledJson>[1], string, string][] = [
      ["withdrawn", {}, "cancelled", "Withdrawn: the team took it back"],
      ["attempt_ended", {}, "cancelled", "No longer asked: the work it was for has stopped"],
      ["turn_ended", {}, "cancelled", "No longer asked: the work it was for has stopped"],
      ["expired", { at: AT }, "timeout", `Expired at ${at}`],
    ];
    for (const [how, over, reason, words] of cases) {
      const { api, store } = await opened();
      await minuteLater(api, [settledJson(how, over)]);
      expect(cardOf(store, "action-1@1"), how).toMatchObject({ expired: reason, expiredNote: words });
    }
  });

  it("closes every card that left together with one read, each in its own words, once", async () => {
    const two = [
      taskJson({ actions: [actionJson(), actionJson({ id: "action-2", payload: { text: "It is on its way." } })] }),
    ];
    const { api, store, events } = await opened({ over: { tasks: two } });
    expect(asks(store).map((a) => a.request_id)).toEqual(["action-1@1", "action-2@1"]);
    await minuteLater(api, [settledJson("decided", { id: "action-2", at: AT, option: "decline" }), settledJson("withdrawn", { id: "action-1" })], {
      tasks: [taskJson({ actions: [actionJson({ state: "confirmed" }), actionJson({ id: "action-2", state: "rejected" })] })],
    });
    expect(reads(api)).toHaveLength(1);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "cancelled", expiredNote: "Withdrawn: the team took it back" });
    expect(cardOf(store, "action-2@1")).toMatchObject({ expired: "resolved", expiredNote: `Declined by you at ${at}` });
    expect(closings(events).map((e) => (e as { request_id: string }).request_id).sort()).toEqual(["action-1@1", "action-2@1"]);
  });

  it("goes on reading the shop each minute, and a second ask that leaves is read again", async () => {
    const two = [taskJson({ actions: [actionJson(), actionJson({ id: "action-2", payload: { text: "It is on its way." } })] })];
    const { api, store } = await opened({ over: { tasks: two } });
    await minuteLater(api, [settledJson("decided", { at: AT })], { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" }), actionJson({ id: "action-2" })] })] });
    expect(reads(api)).toHaveLength(1);
    await minuteLater(api, [settledJson("expired", { id: "action-2", at: AT })], { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" }), actionJson({ id: "action-2", state: "expired" })] })] });
    expect(reads(api)).toHaveLength(2);
    expect(cardOf(store, "action-2@1")).toMatchObject({ expired: "timeout", expiredNote: `Expired at ${at}` });
    // a minute on, with nothing more that left, nothing more is read
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(reads(api)).toHaveLength(2);
  });
});

describe("a read that does not say", () => {
  it("leaves today's closing when it fails, answers anything but that list, or does not list the request", async () => {
    const quiet: [string, Recent][] = [
      ["a 503", { status: 503, json: { error: "approvals_unavailable" } }],
      ["a refusal", { status: 400, json: { error: "invalid_state" } }],
      ["a 403", { status: 403, json: { error: "forbidden" } }],
      ["no answer", "offline"],
      ["a failed request", "failed"],
      ["a page that is not JSON", { status: 200, text: "<html>Bad gateway</html>" }],
      ["the open list", { status: 200, json: { state: "open", approvals: [settledJson("decided", { at: AT })] } }],
      ["a body with no list", { status: 200, json: { state: "recent" } }],
      ["a list that is not one", { status: 200, json: { state: "recent", approvals: "none" } }],
      ["an empty list", []],
      ["another request", [settledJson("decided", { id: "action-9", at: AT })]],
      ["an entry that is not a request", [{ record: { status: "decided" } }, "no"]],
    ];
    for (const [what, recent] of quiet) {
      const { api, store, events } = await opened();
      await minuteLater(api, recent);
      expect(reads(api), what).toHaveLength(1);
      expect(cardOf(store, "action-1@1"), what).toMatchObject({ expired: "resolved" });
      expect(cardOf(store, "action-1@1"), what).not.toHaveProperty("expiredNote");
      expect(closings(events), what).toHaveLength(1);
    }
  });

  it("never leaves a card open because saying how went wrong: it closes as it did before, once", async () => {
    broken.on = true;
    const { api, store, events } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT })]);
    expect(reads(api)).toHaveLength(1);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved" });
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
    expect(closings(events)).toHaveLength(1);
  });

  it("leaves today's closing for an action that ran out of time and one whose task is gone", async () => {
    const timed = await opened();
    await minuteLater(timed.api, [], { tasks: [taskJson({ actions: [actionJson({ state: "expired" })] })] });
    expect(cardOf(timed.store, "action-1@1")).toMatchObject({ expired: "timeout" });
    const gone = await opened();
    await minuteLater(gone.api, [], { tasks: [] });
    expect(cardOf(gone.store, "action-1@1")).toMatchObject({ expired: "cancelled" });
  });

  it("leaves today's closing for a request the list holds at another revision than the card showed", async () => {
    const { api, store } = await opened();
    await minuteLater(api, [settledJson("decided", { at: AT, revision: 2 })]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved" });
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
  });

  it("leaves today's closing for a request the list says still waits, or in a standing it does not know", async () => {
    for (const entry of [approvalJson({ id: "action-1" }), { ...approvalJson({ id: "action-1" }), standing: { state: "revoked" } }]) {
      const { api, store } = await opened();
      await minuteLater(api, [entry]);
      expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved" });
      expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
    }
  });
});

describe("when nothing is read", () => {
  it("reads nothing, and starts no wait for a read, while no ask has left, however many minutes pass", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { api } = await opened();
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(api.to("GET", "/v1/approvals")).toHaveLength(4);
    expect(reads(api)).toEqual([]);
    expect(timers.mock.calls.filter(([, ms]) => ms === LEFT_READ_MS)).toEqual([]);
  });

  it("reads nothing for a request asked again at another revision: its new version is an ask of its own", async () => {
    const asked = (revision: number) => approvalJson({ id: "action-1", revision, detail: replyDetail("action-1", revision === 1 ? "Ships tomorrow." : "Ships on Friday.") });
    const { api, store } = await opened({ over: { approvals: [asked(1)] } });
    serveShop(api, { approvals: [asked(2)], recent: [settledJson("decided", { at: AT })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api)).toEqual([]);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "cancelled", expiredNote: "It changed since you saw it. Answer the new version" });
    expect(asks(store).map((a) => a.request_id)).toEqual(["action-1@2"]);
  });

  it("reads nothing for an ask the person answered here: the API's answer already says how it closes", async () => {
    const taken = { status: 200, json: { result: { ok: true, decision: { requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "owner-session", role: "owner", decidedAt: NOW } }, action: "confirmed" } };
    const { api, store } = await opened();
    api.on("POST", PATH, () => (serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT })] }), taken));
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBeNull();
    await settled();
    expect(api.to("GET", "/v1/approvals")).toHaveLength(2);
    expect(reads(api)).toEqual([]);
    // the card keeps the person's own answer
    expect(cardOf(store, "action-1@1")).toMatchObject({ resolved: "once" });
  });

  it("reads nothing for an ask the API said someone decided first: its words are the API's", async () => {
    const { api, store } = await opened();
    api.on("POST", PATH, () => {
      serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT, option: "decline" })] });
      const decision = { requestId: "action-1", optionId: "decline", seenRevision: 1, decidedBy: "owner-link", role: "owner", decidedAt: AT };
      return { status: 409, json: { error: "already_decided", result: { ok: false, refused: "already_decided", decision }, action: "rejected" } };
    });
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBe(`Already decided from your LINE link at ${at}`);
    await settled();
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: `Already decided from your LINE link at ${at}` });
    expect(reads(api)).toEqual([]);
  });

  it("is the one way a lost answer is found out: its request was decided, the read says by whom", async () => {
    const { api, store } = await opened();
    // the decision reached the API, and its answer never came back
    api.on("POST", PATH, () => {
      serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT })] });
      return "offline";
    });
    expect(await settleApproval(store, "buddy", asks(store)[0], "once")).toBe("No reply from the API. Checking whether your answer arrived");
    await settled();
    expect(reads(api)).toHaveLength(1);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved", expiredNote: `Approved by you at ${at}` });
    expect(api.to("POST", PATH)).toHaveLength(1);
  });
});

describe("the wait for the read", () => {
  it("leaves no timer behind once the read has answered", async () => {
    const two = [taskJson({ actions: [actionJson(), actionJson({ id: "action-2", payload: { text: "It is on its way." } })] })];
    const { api } = await opened({ over: { tasks: two } });
    // a minute in which nothing leaves, and one in which an ask does: the same timers are pending after each
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    const quiet = vi.getTimerCount();
    await minuteLater(api, [settledJson("decided", { at: AT })], { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" }), actionJson({ id: "action-2" })] })] });
    expect(reads(api)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(quiet);
  });
});

describe("a read held back", () => {
  /** A fetch that holds the shop's recent requests until `release` is called, and answers everything else at once. `asked` counts the
   *  requests it holds, which the fake API does not see until they are let go. */
  function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      asked: 0,
      release,
      fetch: (api: FakeApi): FetchLike => async (url, init) => {
        if (!url.endsWith("state=recent")) return api.fetch(url, init);
        slow.asked += 1;
        return gate.then(() => api.fetch(url, init));
      },
    };
    return slow;
  }

  it("holds the card open a few seconds for it at most, then closes it as it did before, and never uses an answer that comes later", async () => {
    const slow = held();
    const { api, store, events } = await opened({ fetch: slow.fetch });
    serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    // the card is still open while the read is on its way
    expect(slow.asked).toBe(1);
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expired");
    await vi.advanceTimersByTimeAsync(LEFT_READ_MS - 200);
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expired");
    await vi.advanceTimersByTimeAsync(400);
    expect(cardOf(store, "action-1@1")).toMatchObject({ expired: "resolved" });
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
    // the answer that comes after is not used, and no second closing is made
    slow.release();
    await settled();
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
    expect(closings(events)).toHaveLength(1);
    expect(LEFT_READ_MS).toBeLessThanOrEqual(5_000);
  });

  it("closes nothing when the app lets go of the runtime while the read is on its way", async () => {
    const slow = held();
    const { api, rt, events } = await opened({ fetch: slow.fetch });
    serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(slow.asked).toBe(1);
    rt.close();
    slow.release();
    await settled();
    expect(closings(events)).toEqual([]);
  });

  it("closes nothing for a person who signed out while the read was on its way, even when someone else signed in", async () => {
    const slow = held();
    const { api, store, session, host, events } = await opened({ fetch: slow.fetch });
    serveShop(api, { tasks: [taskJson({ actions: [actionJson({ state: "confirmed" })] })], recent: [settledJson("decided", { at: AT })] });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(slow.asked).toBe(1);
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2, "apple:owner-2") });
    await session.signOut();
    expect(host.link).toBe("signed_out");
    await session.signIn("identity-token", "nonce");
    await settled();
    slow.release();
    await settled();
    expect(closings(events)).toEqual([]);
    expect(cardOf(store, "action-1@1")).not.toHaveProperty("expiredNote");
  });
});

describe("several shops", () => {
  it("reads each shop that has an ask that left once, with that shop's own session, and closes each card from its own shop's record", async () => {
    const { api, shops, store } = await openedShops();
    shops.approvals[SHOP_A.id] = [];
    shops.approvals[SHOP_B.id] = [approvalJson({ id: "b-reply-2", createdAt: T0 + 210_000, detail: replyDetail("b-reply-2", "Yes, we deliver.") })];
    shops.recent[SHOP_A.id] = [settledJson("decided", { id: "a-reply", at: AT, by: "owner-link" })];
    // a request with the same id at the other shop never closes this one: each shop's list is its own
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT, by: "helper-9", role: "helper", option: "decline" }), settledJson("decided", { id: "a-reply", at: AT, option: "decline" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api).map((c) => [c.url, c.bearer]).sort()).toEqual([[RECENT, OWNER_A], [RECENT, HELPER_B]].sort());
    expect(shopCard(store, "a-reply")).toMatchObject({ expired: "resolved", expiredNote: `Approved from your LINE link at ${at}` });
    expect(shopCard(store, "b-reply-1")).toMatchObject({ expired: "resolved", expiredNote: `Declined by a helper at ${at}` });
    expect(shopCard(store, "b-reply-2")).not.toHaveProperty("expired");
    expect(decisions(api)).toEqual([]);
    for (const call of api.calls) expect(call.url, call.url).not.toMatch(/mos1|mhs1|access-/);
  });

  it("reads only the shop whose ask left", async () => {
    const { api, shops, store } = await openedShops();
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT }), settledJson("expired", { id: "b-reply-2", at: AT })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api).map((c) => [c.url, c.bearer])).toEqual([[RECENT, HELPER_B]]);
    expect(shopCard(store, "b-reply-2")).toMatchObject({ expired: "timeout", expiredNote: `Expired at ${at}` });
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expired");
  });

  it("names the owner to a helper, never you, whether the app or the link on LINE decided", async () => {
    const { api, shops, store } = await openedShops();
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT }), settledJson("decided", { id: "b-reply-2", at: AT, by: "owner-link", option: "decline" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api)).toHaveLength(1);
    expect(shopCard(store, "b-reply-1")?.expiredNote).toBe(`Approved by ${SHOP_B.ownerName} at ${at}`);
    expect(shopCard(store, "b-reply-2")?.expiredNote).toBe(`Declined by ${SHOP_B.ownerName} at ${at}`);
  });

  it("names a helper by the note they passed on at that shop, and no other shop's", async () => {
    const passed = { by: "helper-mint", name: "Mint", note: "Over to you.", at: iso(T0 + 150_000) };
    const { shops, store } = await openedShops();
    // Mint's note is on the open refund at Baan Mali, so her name is Baan Mali's to say, never Ran Pa Noi's
    shops.approvals[SHOP_A.id] = [approvalJson({ id: "a-refund", kind: "money", detail: { operationType: "shopee.refund", targetResourceId: "SP-1" }, passedOn: passed }), ...shops.approvals[SHOP_A.id]];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    shops.approvals[SHOP_A.id] = shops.approvals[SHOP_A.id].slice(0, 1);
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_A.id] = [settledJson("decided", { id: "a-refund", kind: "money", at: AT, by: "helper-mint", role: "helper" })];
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT, by: "helper-mint", role: "helper" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(shopCard(store, "b-reply-1")).toMatchObject({ expired: "resolved", expiredNote: `Approved by a helper at ${at}` });
  });

  it("closes a shop's card at once when its read answers, while another shop's slow read is waited for no longer than the others'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { shops, store } = await openedShops((fake) => async (url, init) => {
      const bearer = init.headers.authorization ?? init.headers.Authorization;
      return url.endsWith("state=recent") && bearer === `Bearer ${OWNER_A}` ? gate.then(() => fake.fetch(url, init)) : fake.fetch(url, init);
    });
    shops.approvals[SHOP_A.id] = [];
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_A.id] = [settledJson("decided", { id: "a-reply", at: AT })];
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT }), settledJson("decided", { id: "b-reply-2", at: AT, option: "decline" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    // Ran Pa Noi's cards closed with their words while Baan Mali's read is still on its way
    expect(shopCard(store, "b-reply-1")?.expiredNote).toBe(`Approved by ${SHOP_B.ownerName} at ${at}`);
    expect(shopCard(store, "b-reply-2")?.expiredNote).toBe(`Declined by ${SHOP_B.ownerName} at ${at}`);
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expired");
    await vi.advanceTimersByTimeAsync(LEFT_READ_MS);
    expect(shopCard(store, "a-reply")).toMatchObject({ expired: "resolved" });
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expiredNote");
    release();
    await settled();
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expiredNote");
  });

  it("leaves one shop's closing as it was when only that shop's read fails", async () => {
    const { shops, store } = await openedShops();
    shops.approvals[SHOP_A.id] = [];
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_A.id] = { status: 503, json: { error: "approvals_unavailable" } };
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT }), settledJson("withdrawn", { id: "b-reply-2" })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(shopCard(store, "a-reply")).toMatchObject({ expired: "resolved" });
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expiredNote");
    expect(shopCard(store, "b-reply-1")?.expiredNote).toBe(`Approved by ${SHOP_B.ownerName} at ${at}`);
    expect(shopCard(store, "b-reply-2")?.expiredNote).toBe("Withdrawn: the team took it back");
  });

  it("closes a card whose request ran out of time as timed out when the read does not say, as before", async () => {
    // Baan Mali's reply expires half a minute after the person's computer first read it, so the next minute's read finds it past
    const { api, shops, store } = await openedShops(undefined, { expiresAt: NOW + 30_000 });
    shops.approvals[SHOP_A.id] = [];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api)).toHaveLength(1);
    expect(shopCard(store, "a-reply")).toMatchObject({ expired: "timeout" });
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expiredNote");
  });

  it("learns the person's place in a shop ended from the read, and says so as any other read does", async () => {
    const { api, shops, store, session, events } = await openedShops();
    shops.approvals[SHOP_B.id] = [];
    shops.recent[SHOP_B.id] = [settledJson("decided", { id: "b-reply-1", at: AT })];
    // Ran Pa Noi's owner removed the person after the shop's open list was read: only the read of recent requests finds out
    api.on("GET", "/v1/approvals", (req) => {
      const state = new URL(req.url).searchParams.get("state");
      if (state === "recent" && req.bearer === HELPER_B) return { status: 401, json: { error: "removed", removedAt: REMOVED_AT } };
      const shop = req.bearer === OWNER_A ? SHOP_A.id : SHOP_B.id;
      return { status: 200, json: { state, approvals: state === "open" ? shops.approvals[shop] : [] } };
    });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    const words = leftWords({ name: SHOP_B.name, owner: SHOP_B.ownerName, why: "removed", at: Date.parse(REMOVED_AT) / 1000 });
    expect(shopCard(store, "b-reply-1")).toMatchObject({ expired: "cancelled", expiredNote: words });
    // what still waited there closes the same way, and the session of that shop is gone
    expect(shopCard(store, "b-reply-2")).toMatchObject({ expired: "cancelled", expiredNote: words });
    expect(session.shopSession(SHOP_B.id)).toBeNull();
    expect(events.filter((e) => e.event === "shops.update").length).toBeGreaterThan(0);
    expect(shopCard(store, "a-reply")).not.toHaveProperty("expired");
  });

  it("reads nothing for a request of a shop asked again at another revision: its new version is an ask of its own", async () => {
    const { api, shops, store } = await openedShops();
    shops.approvals[SHOP_A.id] = [approvalJson({ id: "a-reply", revision: 2, createdAt: T0 + 100_000, detail: replyDetail("a-reply", "Your parcel left at noon.") })];
    shops.recent[SHOP_A.id] = [settledJson("decided", { id: "a-reply", at: AT })];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(reads(api)).toEqual([]);
    expect(store.getState().chats.buddy?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id.endsWith("/a-reply@1"))).toMatchObject({
      expired: "cancelled",
      expiredNote: "It changed since you saw it. Answer the new version",
    });
  });

  it("reads nothing for a shop whose place ended in the read itself: its asks close in the words that say so", async () => {
    const { api, shops, store } = await openedShops();
    shops.ended[SHOP_B.id] = { error: "removed", at: REMOVED_AT };
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    const words = leftWords({ name: SHOP_B.name, owner: SHOP_B.ownerName, why: "removed", at: Date.parse(REMOVED_AT) / 1000 });
    expect(shopCard(store, "b-reply-1")).toMatchObject({ expired: "cancelled", expiredNote: words });
    expect(reads(api)).toEqual([]);
  });
});

describe("what is kept", () => {
  it("is the same on disk whether or not the read said how: nothing of it is kept", async () => {
    const kept = async (recent: Recent) => {
      // both runs start at the same moment, so what each read is stamped with is the same
      vi.setSystemTime(NOW);
      const { api, disk, store } = await opened();
      await minuteLater(api, recent);
      expect(cardOf(store, "action-1@1")?.expired).toBe("resolved");
      return [...disk.files.values()];
    };
    const said = await kept([settledJson("decided", { at: AT, by: "helper-9", role: "helper" })]);
    const quiet = await kept([]);
    expect(said).toHaveLength(1);
    expect(said).toEqual(quiet);
    expect(JSON.parse(said[0]).v).toBe(CACHE_VERSION);
    expect(said[0]).not.toMatch(/Approved|helper-9|state=recent|expiredNote/);
  });
});
