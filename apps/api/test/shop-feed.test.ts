import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { BEARER_PROTOCOL, FEED_CLOSE, FEED_PROTOCOL, MAX_FEEDS_PER_SESSION, ShopFeed } from "../src/feed";
import { tenantCall, tenantStub } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  bindings,
  decide,
  invite,
  joinHelper,
  linkedOwner,
  proposeReply,
  setFlags,
  setupShop,
  shopTask,
  stubLine,
  type Shop,
} from "./people-fixtures";
import { sourceWorker } from "./source-worker";

/// The shop's live feed (feed.ts; docs/pilot-api.md, "The shop's live feed"): `GET /v1/feed` with a shop's session, the
/// switch that keeps it off, the sockets the shop's TenantObject accepts with the hibernation API, their limits, a ping
/// after each kind of write the object takes that a screen reads, at most one ping in each `ShopFeed.coalesceMs`, and the
/// ways a socket ends. Every session here is minted through the real routes; every token is the test's own.

type Message = Record<string, unknown> | string;
type Closed = { code: number; reason: string };
type Feed = {
  ws: WebSocket;
  /// The next message, or null when none comes within `ms`.
  next(ms?: number): Promise<Message | null>;
  send(text: string): void;
  closed: Promise<Closed>;
};

/// Accepts the client end of a socket, queueing what arrives so that no message is missed between awaits.
function wire(ws: WebSocket): Feed {
  const queue: Message[] = [];
  const waiting: ((value: Message) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : "";
    let value: Message = text;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A plain text, the keepalive's answer.
    }
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  const closed = new Promise<Closed>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
  ws.accept();
  return {
    ws,
    closed,
    send: (text) => ws.send(text),
    next: (ms = 4_000) => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const at = waiting.indexOf(take);
          if (at >= 0) waiting.splice(at, 1);
          resolve(null);
        }, ms);
        const take = (value: Message) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiting.push(take);
      });
    },
  };
}

/// The upgrade, through the Worker from an address of its own, as the edge delivers it.
function upgrade(headers: Record<string, string>, path = "/v1/feed"): Promise<Response> {
  return sourceWorker.fetch(`https://api.manut.test${path}`, { headers: { upgrade: "websocket", ...headers } });
}

async function openFeed(headers: { authorization: string }): Promise<Feed> {
  const response = await upgrade(headers);
  expect(response.status).toBe(101);
  return wire(response.webSocket!);
}

/// What a refused upgrade or look answered.
async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

const tokenOf = (headers: { authorization: string }) => headers.authorization.slice("Bearer ".length);

const PING = { v: 1, seq: expect.any(Number) };

/// An attention item, stored as the Worker's inbound route stores one: new unless `deliveryId` was delivered before.
async function attention(shop: Shop, deliveryId: string = crypto.randomUUID()): Promise<void> {
  const response = await tenantCall(bindings, shop.tenant, "/attention", { method: "POST",
    headers: { "content-type": "application/json", "x-inbound": "1" },
    body: JSON.stringify({ tenant: shop.tenant, deliveryId, connectionId: "conn-feed", eventType: "Issue.update",
      issueId: "ISS-9" }) });
  expect(response.status).toBe(200);
  // Read, so no request is left open on the object: one would keep it from being evicted.
  await response.text();
}

/// A task in the shop's index, as the create route writes it before it makes the task.
async function indexed(shop: Shop, taskId: string): Promise<void> {
  const response = await tenantCall(bindings, shop.tenant, "/index", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: shop.tenant, taskId }) });
  expect(response.status).toBe(200);
  // Read, so no request is left open on the object: one would keep it from being evicted.
  await response.text();
}

/// The entry of a request about to open on `taskId`, as the task object writes it before it opens one.
async function asked(shop: Shop, taskId: string): Promise<void> {
  const response = await tenantCall(bindings, shop.tenant, "/approvals/asked", { method: "POST",
    headers: { "content-type": "application/json", "x-approvals": "1" },
    body: JSON.stringify({ tenant: shop.tenant, requestId: crypto.randomUUID(), taskId }) });
  expect(response.status).toBe(200);
  // Read, so no request is left open on the object: one would keep it from being evicted.
  await response.text();
}

const DEFAULTS = { coalesceMs: ShopFeed.coalesceMs, maxAgeMs: ShopFeed.maxAgeMs, silentMs: ShopFeed.silentMs,
  maxPerShop: ShopFeed.maxPerShop, switchFreshMs: ShopFeed.switchFreshMs };

beforeEach(async () => {
  expect((await setFlags({ shopFeed: true, officeInbound: true, officeCloud: true, officeExternalWrites: true })).status)
    .toBe(200);
  // Most tests wait for a ping, so it comes at once; the coalescing test sets the real second back.
  ShopFeed.coalesceMs = 50;
});

afterEach(() => {
  Object.assign(ShopFeed, DEFAULTS);
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("is off by default, and while off the route refuses saying so, the look and the upgrade alike", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    // With no record of the operator's, the environment's default stands, and no environment sets it.
    await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), (_instance, state) =>
      state.storage.delete("flags"));
    const flags = await admin<{ shopFeed?: boolean }>("GET", "/v1/admin/flags");
    expect(flags.body.shopFeed).toBe(false);
    const off = { status: 403, body: { error: "feature_disabled", feature: "shopFeed" } };
    expect(await refusal(await asSessionLook(owner.headers))).toEqual(off);
    expect(await refusal(await upgrade(owner.headers))).toEqual(off);
    expect(await objectSockets(shop)).toBe(0);
  });

  it("is turned on with PUT /v1/admin/flags, and the look then says the feed is on", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const look = await asSessionLook(owner.headers);
    expect(look.status).toBe(200);
    expect(look.headers.get("cache-control")).toBe("no-store");
    expect(await look.json()).toEqual({ feed: "on", protocol: FEED_PROTOCOL });
  });

  it("closes every open socket with 4503 at the first ping after it reads off", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    ShopFeed.switchFreshMs = 0;
    expect((await setFlags({ shopFeed: false })).status).toBe(200);
    await attention(shop);
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.off, reason: "feed_off" });
    expect(await feed.next(200)).toBeNull();
  });
});

/// The desktop's look at whether the feed is on: a plain GET with the shop's session.
function asSessionLook(headers: { authorization: string }): Promise<Response> {
  return sourceWorker.fetch("https://api.manut.test/v1/feed", { headers });
}

/// How many feed sockets the shop's object holds open.
function objectSockets(shop: Shop): Promise<number> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), (_instance, state) =>
    state.getWebSockets("feed").filter((ws) => ws.readyState === WebSocket.OPEN).length);
}

/// The live instance's feed, for what only it can show: whether a ping is waiting to go, and which auth object it asks.
type FeedInside = { timer: unknown; env: { AUTH: DurableObjectNamespace } };
function insideFeed<T>(shop: Shop, look: (feed: FeedInside) => T): Promise<T> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), (instance) =>
    look((instance as unknown as { feed: FeedInside }).feed));
}

describe("who may open it", () => {
  it("refuses no session, the operator key and a person's own sign-in, in the approvals list's own words", async () => {
    expect(await refusal(await upgrade({}))).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await refusal(await upgrade({ authorization: "Bearer test-key" }))).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    expect(await refusal(await upgrade({ authorization: "Bearer mos1.not-a-shop.0000" }))).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    // A person's own sign-in has a tenant but no shop, as the shop's routes answer it.
    const own = await tenantSession("apple:feed-person");
    expect(await refusal(await upgrade(own))).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("refuses anything but GET, and a query that names the shop, the tenant or the role", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const posted = await sourceWorker.fetch("https://api.manut.test/v1/feed", { method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" }, body: "{}" });
    expect(await refusal(posted)).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    for (const query of ["shop", "tenant", "role"]) {
      expect(await refusal(await upgrade(owner.headers, `/v1/feed?${query}=${encodeURIComponent(shop.tenant)}`)))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
  });

  it("takes a page's session from its protocol entry, answers only manut-feed.v1, and never echoes the bearer", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const response = await upgrade({ "sec-websocket-protocol": `${FEED_PROTOCOL}, ${BEARER_PROTOCOL}${tokenOf(owner.headers)}` });
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe(FEED_PROTOCOL);
    const feed = wire(response.webSocket!);
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
    // A client that offers protocols must offer the feed's; one with no protocol at all, a program's, gets none back.
    const other = await upgrade({ "sec-websocket-protocol": `chat.v2, ${BEARER_PROTOCOL}${tokenOf(owner.headers)}` });
    expect(await refusal(other)).toEqual({ status: 400, body: { error: "invalid_request" } });
    const program = await upgrade(owner.headers);
    expect(program.status).toBe(101);
    expect(program.headers.get("sec-websocket-protocol")).toBeNull();
  });

  it("gives a session its own shop's feed and no other's", async () => {
    const mali = await setupShop("Baan Mali");
    const noi = await setupShop("Ran Pa Noi");
    const owner = await linkedOwner(mali);
    const feed = await openFeed(owner.headers);
    await attention(noi);
    await shopTask(noi.tenant);
    expect(await feed.next(600)).toBeNull();
    await attention(mali);
    expect(await feed.next()).toEqual(PING);
  });

  it("takes a helper's session, which hears what waits at the shop it helps at", async () => {
    const line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
    const shop = await setupShop();
    const helper = await joinHelper(shop);
    const feed = await openFeed(helper.headers);
    await proposeReply(shop, "Your order ships tomorrow");
    expect(await feed.next()).toEqual(PING);
    expect(line.pushes()).toBe(0);
  });

  it("refuses a removed helper and an unlinked owner as the approvals list does, and closes their sockets at once", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const helperFeed = await openFeed(helper.headers);
    const ownerFeed = await openFeed(owner.headers);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id })).status).toBe(200);
    expect(await helperFeed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
    // The owner stays, and hears that the shop's people changed.
    expect(await ownerFeed.next()).toEqual(PING);
    const removed = await refusal(await upgrade(helper.headers));
    expect(removed).toEqual({ status: 401, body: { error: "removed", removedAt: expect.any(String) } });
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect(await ownerFeed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
    expect(await refusal(await upgrade(owner.headers))).toEqual({ status: 401,
      body: { error: "unlinked", unlinkedAt: expect.any(String) } });
  });

  it("is refused by the object itself for a session its people record does not hold, whoever hands it over", async () => {
    const shop = await setupShop();
    const handed = (role: string, session: string) => tenantCall(bindings, shop.tenant, "/feed", { headers: {
      upgrade: "websocket", "x-feed": "1", "x-feed-tenant": shop.tenant, "x-feed-role": role, "x-feed-session": session } });
    expect(await refusal(await handed("owner", "0".repeat(64)))).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await refusal(await handed("operator", "0".repeat(64)))).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await refusal(await handed("owner", "not-a-hash"))).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await objectSockets(shop)).toBe(0);
  });

  it("closes the socket of a device that signs out of the shop", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    expect((await asSession(owner.headers, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
  });
});

describe("limits", () => {
  it(`holds ${MAX_FEEDS_PER_SESSION} sockets for one session, refuses the next with feed_session_full, and frees a place when one closes`, async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feeds = [];
    for (let i = 0; i < MAX_FEEDS_PER_SESSION; i += 1) feeds.push(await openFeed(owner.headers));
    const full = await upgrade(owner.headers);
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("60");
    expect(await full.json()).toEqual({ error: "feed_session_full" });
    // Another session of the same shop has places of its own.
    const helper = await joinHelper(shop);
    await openFeed(helper.headers);
    // A socket the desktop closes gives its place back once the object hears it closed, as the relay's tests wait for it.
    feeds[0]!.ws.close(1000, "done");
    await vi.waitFor(async () => expect(await objectSockets(shop)).toBe(MAX_FEEDS_PER_SESSION), { timeout: 5_000 });
    await openFeed(owner.headers);
  }, 20_000);

  it("holds ShopFeed.maxPerShop sockets for the shop, all its sessions together, and refuses the next with feed_shop_full", async () => {
    ShopFeed.maxPerShop = 3;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    await openFeed(owner.headers);
    await openFeed(owner.headers);
    await openFeed(helper.headers);
    const full = await upgrade(helper.headers);
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("60");
    expect(await full.json()).toEqual({ error: "feed_shop_full" });
  }, 20_000);

  it("takes a silent socket's place for its session, and never one that keeps its keepalive", async () => {
    ShopFeed.silentMs = 1_500;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const kept = await openFeed(owner.headers);
    const quiet = [await openFeed(owner.headers), await openFeed(owner.headers)];
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // The runtime answers the keepalive without the object, and notes when it did.
    kept.send("ping");
    expect(await kept.next()).toBe("pong");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await openFeed(owner.headers);
    for (const feed of quiet) expect(await feed.closed).toEqual({ code: FEED_CLOSE.silent, reason: "silent" });
    await attention(shop);
    expect(await kept.next()).toEqual(PING);
  }, 20_000);
});

describe("pings", () => {
  it("come after each kind of write the shop's object takes that a screen reads", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const taskId = await shopTask(shop.tenant);
    const feed = await openFeed(owner.headers);
    // Each write is made as the one caller that makes it does, straight to the object, so no other write rides along.
    const writes: [string, () => Promise<unknown>][] = [
      ["a task indexed", () => indexed(shop, `feed-task-${crypto.randomUUID()}`)],
      ["a request about to open", () => asked(shop, taskId)],
      ["an attention item", () => attention(shop)],
      ["the team paused", async () => expect((await asSession(owner.headers, "POST", "/v1/team/pause", {})).status).toBe(200)],
      ["a helper invited", async () =>
        expect((await invite(shop, "Beam", { kind: "email", address: `beam-${crypto.randomUUID()}@baanmali.example` })).status)
          .toBe(200)],
    ];
    for (const [what, write] of writes) {
      await write();
      expect(await feed.next(), what).toEqual(PING);
      expect(await feed.next(300), what).toBeNull();
    }
  }, 30_000);

  it("never come from a write that changed nothing: a task indexed again, or a delivery seen before", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const taskId = `feed-task-${crypto.randomUUID()}`;
    await indexed(shop, taskId);
    const deliveryId = crypto.randomUUID();
    await attention(shop, deliveryId);
    const feed = await openFeed(owner.headers);
    await indexed(shop, taskId);
    await attention(shop, deliveryId);
    expect(await feed.next(600)).toBeNull();
  });

  it("never come from a read, so the reads a ping sets off never set off another", async () => {
    stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    await proposeReply(shop, "Your parcel left today");
    // Declined, so the next read of the open requests finds it settled and tells the lookup (`/approvals/learned`).
    const declined = await proposeReply(shop, "We are out of the red one");
    expect((await decide(owner.headers, declined.actionId, { optionId: "decline", seenRevision: 1 })).status).toBe(200);
    const feed = await openFeed(owner.headers);
    while (await feed.next(300)) { /* what the decision itself took */ }
    // Everything the desktop reads each minute with its session, each of which checks the session first.
    for (const path of ["/v1/approvals?state=open", "/v1/approvals?state=recent", "/v1/tasks", "/v1/schedules",
      "/v1/inbound/attention", "/v1/routines", "/v1/people/devices", "/v1/feed"]) {
      expect((await asSession(owner.headers, "GET", path)).status, path).toBe(200);
    }
    expect(await feed.next(600)).toBeNull();
  }, 20_000);

  it("cost a shop nobody follows nothing: a write leaves no ping waiting", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    await attention(shop);
    expect(await insideFeed(shop, (feed) => feed.timer)).toBeNull();
    ShopFeed.coalesceMs = 5_000;
    await openFeed(owner.headers);
    await attention(shop);
    expect(await insideFeed(shop, (feed) => feed.timer)).not.toBeNull();
  });

  it("read the switch at most once in ShopFeed.switchFreshMs, the upgrade's read counting as the first", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    const asked: string[] = [];
    await insideFeed(shop, (inside) => {
      const auth = inside.env.AUTH;
      inside.env = { ...inside.env, AUTH: {
        idFromName: (name: string) => auth.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = auth.get(id);
          return { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            asked.push(new URL(new Request(input, init).url).pathname);
            return stub.fetch(input, init);
          } };
        },
      } as unknown as DurableObjectNamespace };
    });
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
    expect(asked).toEqual([]);
    ShopFeed.switchFreshMs = 0;
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
    expect(asked).toEqual(["/flags"]);
  });

  it("are not sent to a socket whose session ran out, which is closed with 4401 instead", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    const hash = await sha256Hex(tokenOf(owner.headers));
    // Its 30 days pass with nothing written to the people record, so only the ping's own check can see it.
    await runInDurableObject(tenantStub(bindings, shop.tenant), (_instance, state) => {
      const key = `people:${encodeURIComponent(shop.tenant)}`;
      const record = state.storage.kv.get<{ ownerSessions: Record<string, { expiresAt: number }> }>(key)!;
      record.ownerSessions[hash]!.expiresAt = Date.now() - 1;
      state.storage.kv.put(key, record);
    });
    await attention(shop);
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
    expect(await feed.next(100)).toBeNull();
  });

  it("are coalesced to at most one a second, and each carries a larger seq", async () => {
    ShopFeed.coalesceMs = 1_000;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    for (let i = 0; i < 5; i += 1) await attention(shop);
    const first = (await feed.next(3_000)) as { v: number; seq: number };
    const firstAt = Date.now();
    expect(first).toEqual(PING);
    expect(await feed.next(500)).toBeNull();
    await attention(shop);
    await shopTask(shop.tenant);
    const second = (await feed.next(3_000)) as { v: number; seq: number };
    expect(second).toEqual(PING);
    expect(Date.now() - firstAt).toBeGreaterThanOrEqual(950);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(await feed.next(1_300)).toBeNull();
  }, 20_000);

  it("reach a socket the object hibernated, and the keepalive is answered while it sleeps", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    const stub = tenantStub(bindings, shop.tenant);
    // Evicting tears the instance down and keeps the socket open, as hibernation does.
    await evictDurableObject(stub);
    feed.send("ping");
    expect(await feed.next()).toBe("pong");
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
    await evictDurableObject(stub);
    await shopTask(shop.tenant);
    expect(await feed.next()).toEqual(PING);
  }, 20_000);
});

describe("how a socket ends", () => {
  it("is closed with 4000 when its hour is over, by the object's alarm or instead of a ping", async () => {
    ShopFeed.maxAgeMs = 200;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const stub = tenantStub(bindings, shop.tenant);
    const byAlarm = await openFeed(owner.headers);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await byAlarm.closed).toEqual({ code: FEED_CLOSE.renew, reason: "renew" });
    const byPing = await openFeed(owner.headers);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await attention(shop);
    expect(await byPing.closed).toEqual({ code: FEED_CLOSE.renew, reason: "renew" });
    expect(await byPing.next(100)).toBeNull();
    // A socket past its hour never holds a place: a session's full set of them gives way to its next socket.
    const old = [];
    for (let i = 0; i < MAX_FEEDS_PER_SESSION; i += 1) old.push(await openFeed(owner.headers));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await openFeed(owner.headers);
    for (const feed of old) expect(await feed.closed).toEqual({ code: FEED_CLOSE.renew, reason: "renew" });
  }, 20_000);

  it("is closed with 4410 when the shop's data is deleted", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    const wiped = await tenantCall(bindings, shop.tenant, "/tenant-wipe", { method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" }, body: JSON.stringify({ tenant: shop.tenant }) });
    expect(wiped.status).toBe(200);
    await wiped.text();
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.shopDeleted, reason: "shop_deleted" });
  });

  it("is closed with 4400 when the client says anything but the keepalive", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    feed.send(JSON.stringify({ t: "subscribe" }));
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.badRequest, reason: "bad_request" });
  });

  it("is never reached through the object's own paths without the Worker's header", async () => {
    const shop = await setupShop();
    const touched = await tenantCall(bindings, shop.tenant, "/feed/touch", { method: "POST" });
    expect(await refusal(touched)).toEqual({ status: 403, body: { error: "forbidden" } });
    const opened = await tenantCall(bindings, shop.tenant, "/feed", { headers: { upgrade: "websocket" } });
    expect(await refusal(opened)).toEqual({ status: 403, body: { error: "forbidden" } });
  });
});
