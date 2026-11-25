// The live feed under the connected runtime's host, end to end over a fake API (host.ts, feed.ts; docs/runtime-adapter.md,
// "The live feed"): a socket for each shop the read shows, opened with that shop's own session once the API says the feed
// is on; a ping reading the shops again soon, at most once in FRESH_MS and as one read for several pings; a feed that is
// off, missing or dropping leaving the minute's read exactly as it was; and signing out, leaving a shop and the host
// stopping closing the sockets.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED_DEBOUNCE_MS, FEED_OFF_MS, FEED_PATH, FEED_RETRY_MIN_MS } from "./feed";
import { FRESH_MS, HttpHost, POLL_MS, type HostEvent } from "./host";
import { ApiSession } from "./session";
import type { FetchLike } from "./shell";
import { approvalJson, fakeApi, iso, memoryVault, ORIGIN, serveShops, SHOP_A, SHOP_B, shopToken, socketOpener, storedSession, T0, type ShopJson } from "./testkit";
import { TEAM } from "./view";

const NOW = T0 + 600_000;
const PING = JSON.stringify({ v: 1, seq: 1795591574420 });

async function settled() {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
}

type FeedMode = "on" | "off" | "missing" | "garbled";

/** The API as apps/api answers it, with `GET /v1/feed` by the shop session it is sent with: on, off (403
 *  `feature_disabled`), or missing (an API from before the feed, 404). `gate`, while set, holds every read of the person's
 *  shops back until it is released: a read on its way. */
function world(list: ShopJson[] = [SHOP_A, SHOP_B], opts: { origin?: string; approvals?: Record<string, unknown[]> } = {}) {
  const api = fakeApi();
  const shops = serveShops(api, list, { ...Object.fromEntries(list.map((s) => [s.id, []])), ...opts.approvals });
  const vault = memoryVault(storedSession(NOW, opts.origin ? { origin: opts.origin } : {}));
  /** `gate` holds the reads of the person's shops back, and `looks` the feed's looks, until each is released. */
  const route = { feed: "on" as FeedMode, gate: null as Promise<void> | null, looks: null as Promise<void> | null };
  api.on("GET", FEED_PATH, (req) => {
    const held = shops.tokens.get(req.bearer ?? "");
    if (!held || shops.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    const ended = shops.ended[held.shop];
    if (ended) return { status: 401, json: ended.error === "removed" ? { error: "removed", removedAt: ended.at } : { error: "unlinked", unlinkedAt: ended.at } };
    if (route.feed === "off") return { status: 403, json: { error: "feature_disabled", feature: "shopFeed" } };
    if (route.feed === "missing") return { status: 404, json: { error: "not_found" } };
    if (route.feed === "garbled") return { status: 200, json: { shops: [] } };
    return { status: 200, json: { feed: "on", protocol: "manut-feed.v1" } };
  });
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/shops" && route.gate) await route.gate;
    if (path === FEED_PATH && route.looks) await route.looks;
    return api.fetch(url, init);
  };
  const { sockets, open } = socketOpener();
  const events: HostEvent[] = [];
  async function start() {
    const session = new ApiSession({ origin: opts.origin ?? ORIGIN, fetch, vault });
    const host = new HttpHost({ session, feed: { open } });
    host.subscribe((ev) => events.push(ev));
    const release = host.attach();
    await settled();
    return { host, session, release };
  }
  return {
    api, shops, route, sockets, start, events,
    /** How many times the person's shops were read, each the start of one whole read. */
    reads: () => api.to("GET", "/v1/shops").length,
    looks: () => api.to("GET", FEED_PATH).map((r) => r.bearer),
    /** The socket opened for `shop`, newest last. */
    socketOf: (shop: string) => sockets.filter((s) => shops.tokens.get(s.token ?? "")?.shop === shop).at(-1),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("while the API says the feed is on", () => {
  it("opens a socket for each shop the read shows, owned and helped at alike, each with that shop's own session", async () => {
    const w = world();
    await w.start();
    expect(w.reads()).toBe(1);
    expect(w.looks().sort()).toEqual([shopToken(SHOP_A.id, "owner"), shopToken(SHOP_B.id, "helper")].sort());
    expect(w.sockets).toHaveLength(2);
    for (const socket of w.sockets) expect(socket.url).toBe("wss://dev.manut.xyz/v1/feed");
    expect(w.socketOf(SHOP_A.id)!.token).toBe(shopToken(SHOP_A.id, "owner"));
    expect(w.socketOf(SHOP_B.id)!.token).toBe(shopToken(SHOP_B.id, "helper"));
  });

  it("reads the shops again a second after a ping, and never sooner than FRESH_MS after the last read", async () => {
    const w = world();
    await w.start();
    for (const socket of w.sockets) socket.opened();
    const firstAt = Date.now();
    // Two seconds after the read, a ping waits until FRESH_MS after it.
    await vi.advanceTimersByTimeAsync(2_000);
    w.socketOf(SHOP_A.id)!.says(PING);
    await vi.advanceTimersByTimeAsync(firstAt + FRESH_MS - Date.now() - 100);
    expect(w.reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await settled();
    expect(w.reads()).toBe(2);
    // Long after a read, a ping is read a second later.
    await vi.advanceTimersByTimeAsync(30_000);
    w.socketOf(SHOP_B.id)!.says(PING);
    await vi.advanceTimersByTimeAsync(FEED_DEBOUNCE_MS - 100);
    expect(w.reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    await settled();
    expect(w.reads()).toBe(3);
    // And the minute's read is a minute after that one, as ever.
    const thirdAt = Date.now();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1_000);
    expect(w.reads()).toBe(3);
    await vi.advanceTimersByTimeAsync(thirdAt + POLL_MS - Date.now() + 100);
    await settled();
    expect(w.reads()).toBe(4);
  });

  it("answers pings from several shops, and several from one, with one read", async () => {
    const w = world();
    await w.start();
    for (const socket of w.sockets) socket.opened();
    await vi.advanceTimersByTimeAsync(FRESH_MS);
    w.socketOf(SHOP_A.id)!.says(PING);
    // Later pings ride with the first: none of them puts the read off.
    await vi.advanceTimersByTimeAsync(600);
    w.socketOf(SHOP_B.id)!.says(PING);
    w.socketOf(SHOP_A.id)!.says(PING);
    await vi.advanceTimersByTimeAsync(FEED_DEBOUNCE_MS - 600 + 50);
    await settled();
    expect(w.reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(FRESH_MS);
    expect(w.reads()).toBe(2);
  });

  it("reads once more after a read that was on its way when a ping came, since it may have been asked before the change", async () => {
    const w = world();
    await w.start();
    for (const socket of w.sockets) socket.opened();
    let release: () => void = () => undefined;
    w.route.gate = new Promise<void>((resolve) => (release = resolve));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(w.reads()).toBe(1);
    w.socketOf(SHOP_A.id)!.says(PING);
    w.route.gate = null;
    release();
    await settled();
    expect(w.reads()).toBe(2);
    const secondAt = Date.now();
    await vi.advanceTimersByTimeAsync(secondAt + FRESH_MS - Date.now() + 100);
    await settled();
    expect(w.reads()).toBe(3);
    // Once, and no more: the ping was answered.
    await vi.advanceTimersByTimeAsync(FRESH_MS + 1_000);
    await settled();
    expect(w.reads()).toBe(3);
  });

  it("opens the socket again with the session the look was answered for, once the shop's session was opened again", async () => {
    const w = world([SHOP_A]);
    await w.start();
    expect(w.socketOf(SHOP_A.id)!.token).toBe(shopToken(SHOP_A.id, "owner", 1));
    w.shops.refused.add(shopToken(SHOP_A.id, "owner", 1));
    w.sockets[0]!.drops();
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settled();
    expect(w.sockets).toHaveLength(2);
    expect(w.sockets[1]!.token).toBe(shopToken(SHOP_A.id, "owner", 2));
  });
});

describe("whatever the feed does, the minute's read stands", () => {
  for (const mode of ["off", "missing"] as const) {
    it(`opens no socket while the feed is ${mode}, asks again only an hour later, and reads every minute as before`, async () => {
      const w = world();
      w.route.feed = mode;
      await w.start();
      expect(w.looks()).toHaveLength(2);
      expect(w.sockets).toEqual([]);
      for (let minute = 1; minute <= 3; minute += 1) {
        await vi.advanceTimersByTimeAsync(POLL_MS);
        await settled();
        expect(w.reads()).toBe(1 + minute);
      }
      expect(w.looks()).toHaveLength(2);
      w.route.feed = "on";
      await vi.advanceTimersByTimeAsync(FEED_OFF_MS);
      await settled();
      expect(w.looks()).toHaveLength(4);
      expect(w.sockets).toHaveLength(2);
    });
  }

  it("never takes a 200 it cannot read as the feed being on, and asks again soon", async () => {
    const w = world([SHOP_A]);
    w.route.feed = "garbled";
    await w.start();
    expect(w.sockets).toEqual([]);
    w.route.feed = "on";
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settled();
    expect(w.sockets).toHaveLength(1);
  });

  it("keeps the minute's read while a socket drops, and opens the socket again on its own", async () => {
    const w = world([SHOP_A]);
    await w.start();
    w.sockets[0]!.opened();
    w.sockets[0]!.drops();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(w.reads()).toBe(2);
    expect(w.sockets.length).toBeGreaterThan(1);
  });

  it("follows no feed for an origin the app's CSP gives no socket, and asks nothing about it", async () => {
    const w = world([SHOP_A], { origin: "http://localhost:8787" });
    await w.start();
    expect(w.reads()).toBe(1);
    expect(w.looks()).toEqual([]);
    expect(w.sockets).toEqual([]);
  });

  it("follows no feed for a person in no shop, whose own sign-in is no shop", async () => {
    const w = world([]);
    await w.start();
    expect(w.reads()).toBe(1);
    expect(w.looks()).toEqual([]);
    expect(w.sockets).toEqual([]);
  });

  it("ignores a ping before the first read and while the API cannot be reached", async () => {
    const w = world([SHOP_A]);
    const { host } = await w.start();
    w.sockets[0]!.opened();
    w.api.on("GET", "/v1/shops", "offline");
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(host.link).toBe("offline");
    const before = w.reads();
    w.sockets[0]!.says(PING);
    await vi.advanceTimersByTimeAsync(FEED_DEBOUNCE_MS + 100);
    await settled();
    expect(w.reads()).toBe(before);
  });
});

describe("closing the sockets", () => {
  it("closes every socket when the person signs out, and opens none after", async () => {
    const w = world();
    const { session } = await w.start();
    for (const socket of w.sockets) socket.opened();
    await session.signOut();
    await settled();
    for (const socket of w.sockets) expect(socket.closed).toEqual({ code: 1000, reason: "done" });
    const opened = w.sockets.length;
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS);
    expect(w.sockets).toHaveLength(opened);
  });

  it("closes every socket when the host stops", async () => {
    const w = world();
    const { release } = await w.start();
    release();
    for (const socket of w.sockets) expect(socket.closed).toEqual({ code: 1000, reason: "done" });
  });

  it("closes the socket of a shop the person's place in ended, and keeps the others", async () => {
    const w = world();
    await w.start();
    for (const socket of w.sockets) socket.opened();
    w.shops.ended[SHOP_B.id] = { error: "removed", at: iso(NOW) };
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
    expect(w.socketOf(SHOP_B.id)!.closed).toEqual({ code: 1000, reason: "done" });
    expect(w.socketOf(SHOP_A.id)!.closed).toBeNull();
  });

  it("closes the socket of a shop at once when an answer there finds the person's place ended, outside any read", async () => {
    const w = world([SHOP_A, SHOP_B], { approvals: { [SHOP_B.id]: [approvalJson({ id: "b-reply-1" })] } });
    const { host } = await w.start();
    for (const socket of w.sockets) socket.opened();
    w.api.on("POST", "/v1/approvals/b-reply-1/decision", { status: 401, json: { error: "removed", removedAt: iso(NOW) } });
    const reads = w.reads();
    await host.handle("approval.respond", { bot: TEAM, request_id: `${encodeURIComponent(SHOP_B.id)}/b-reply-1@1`, choice: "once" })
      .catch(() => undefined);
    expect(w.socketOf(SHOP_B.id)!.closed).toEqual({ code: 1000, reason: "done" });
    expect(w.socketOf(SHOP_A.id)!.closed).toBeNull();
    expect(w.reads()).toBe(reads);
  });

  it("says nothing of a look that ended the person's place after the host stopped", async () => {
    const w = world();
    let answer: () => void = () => undefined;
    w.route.looks = new Promise<void>((resolve) => (answer = resolve));
    const { release } = await w.start();
    expect(w.sockets).toEqual([]);
    w.shops.ended[SHOP_B.id] = { error: "removed", at: iso(NOW) };
    release();
    const told = w.events.length;
    w.route.looks = null;
    answer();
    await settled();
    expect(w.events.slice(told)).toEqual([]);
    expect(w.sockets).toEqual([]);
  });

  it("lets a shop go when its look finds the person's place there ended", async () => {
    const w = world();
    const { host } = await w.start();
    w.shops.ended[SHOP_B.id] = { error: "removed", at: iso(NOW) };
    w.socketOf(SHOP_B.id)!.drops();
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settled();
    const shops = (await host.handle("shops.list")) as { left: { id: string; why: string }[] };
    expect(shops.left).toEqual([expect.objectContaining({ id: SHOP_B.id, why: "removed" })]);
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS);
    expect(w.sockets.filter((s) => w.shops.tokens.get(s.token ?? "")?.shop === SHOP_B.id)).toHaveLength(1);
  });
});
