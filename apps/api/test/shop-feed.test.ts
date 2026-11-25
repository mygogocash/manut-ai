import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import {
  FEED_CLOSE,
  FEED_PATH,
  FEED_PROTOCOL,
  FEED_TICKET_PATH,
  MAX_FEEDS_PER_SESSION,
  ShopFeed,
  TICKET_PROTOCOL,
} from "../src/feed";
import worker from "../src/index";
import { TaskObject, touchesFeed } from "../src/task-object";
import { tenantCall, tenantStub } from "../src/tenant-data";
import { tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  bindings,
  callWith,
  decide,
  failingWhere,
  invite,
  joinHelper,
  linkedOwner,
  proposeReply,
  setFlags,
  setupShop,
  shopTask,
  stubLine,
  taskStub,
  type Shop,
} from "./people-fixtures";
import { sourceWorker } from "./source-worker";

/// The shop's live feed (feed.ts; docs/pilot-api.md, "The shop's live feed"): `POST /v1/feed/ticket` with a shop's
/// session, the one-use ticket it mints, `GET /v1/feed` with that ticket among its protocols, the switch that keeps it
/// off, the sockets the shop's TenantObject accepts with the hibernation API, their limits, a ping after each kind of
/// write the object takes that a screen reads, at most one ping in each `ShopFeed.coalesceMs`, and the ways a socket
/// ends. Every session here is minted through the real routes; every token and ticket is the test's own.

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
function upgrade(headers: Record<string, string>, path = FEED_PATH): Promise<Response> {
  return sourceWorker.fetch(`https://api.manut.test${path}`, { headers: { upgrade: "websocket", ...headers } });
}

/// The protocols a page offers with a ticket: the feed's, and the ticket's entry.
const offering = (ticket: string) => ({ "sec-websocket-protocol": `${FEED_PROTOCOL}, ${TICKET_PROTOCOL}${ticket}` });

/// What the mint answered a session, read whole.
function mint(headers: { authorization?: string }) {
  return asSession(headers, "POST", FEED_TICKET_PATH, {});
}

/// A ticket minted with a session, as the desktop asks for one.
async function ticketFor(headers: { authorization: string }): Promise<string> {
  const minted = await mint(headers);
  expect(minted.status).toBe(200);
  return minted.body.ticket as string;
}

async function openWith(ticket: string): Promise<Feed> {
  const response = await upgrade(offering(ticket));
  expect(response.status).toBe(101);
  return wire(response.webSocket!);
}

/// A socket opened as the desktop opens one: a ticket minted with the session, then the upgrade with that ticket.
async function openFeed(headers: { authorization: string }): Promise<Feed> {
  return openWith(await ticketFor(headers));
}

/// What a refused upgrade or mint answered.
async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

const UNAUTHORIZED = { status: 401, body: { error: "unauthorized" } };

const tokenOf = (headers: { authorization: string }) => headers.authorization.slice("Bearer ".length);

/// Text in base64url, as a ticket names its shop.
const base64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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

const DEFAULTS = { ticketMs: ShopFeed.ticketMs, coalesceMs: ShopFeed.coalesceMs, maxAgeMs: ShopFeed.maxAgeMs,
  silentMs: ShopFeed.silentMs, maxPerShop: ShopFeed.maxPerShop, switchFreshMs: ShopFeed.switchFreshMs };
const QUIET = TaskObject.feedQuietMs;

beforeEach(async () => {
  expect((await setFlags({ shopFeed: true, officeInbound: true, officeCloud: true, officeExternalWrites: true })).status)
    .toBe(200);
  // Most tests wait for a ping, so it comes at once; the coalescing test sets the real second back.
  ShopFeed.coalesceMs = 50;
});

afterEach(() => {
  Object.assign(ShopFeed, DEFAULTS);
  TaskObject.feedQuietMs = QUIET;
  vi.restoreAllMocks();
});

/// How many feed sockets the shop's object holds open.
function objectSockets(shop: Shop): Promise<number> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), (_instance, state) =>
    state.getWebSockets("feed").filter((ws) => ws.readyState === WebSocket.OPEN).length);
}

/// The live instance's feed, for what only it can show: whether a ping is waiting to go, which auth object it asks, and
/// the tickets it keeps.
type FeedInside = { timer: unknown; env: { AUTH: DurableObjectNamespace }; tickets: Map<string, unknown> };
function insideFeed<T>(shop: Shop, look: (feed: FeedInside) => T): Promise<T> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), (instance) =>
    look((instance as unknown as { feed: FeedInside }).feed));
}

/// How many tickets the shop's object keeps, used or not yet over.
function objectTickets(shop: Shop): Promise<number> {
  return insideFeed(shop, (feed) => feed.tickets.size);
}

/// An upgrade straight to the Worker, with a TENANT namespace that records the path of every call to a shop's object.
async function upgradeCounting(headers: Record<string, string>): Promise<{ status: number; body: unknown; calls: string[] }> {
  const calls: string[] = [];
  const tenants = bindings.TENANT;
  const counting = { ...bindings, TENANT: {
    idFromName: (name: string) => tenants.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = tenants.get(id);
      return { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new URL(new Request(input, init).url).pathname);
        return stub.fetch(input, init);
      } };
    },
  } as unknown as DurableObjectNamespace };
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.manut.test${FEED_PATH}`,
    { headers: { upgrade: "websocket", ...headers } }), counting, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: await response.json(), calls };
}

describe("the switch", () => {
  it("is off by default, and while off the mint refuses saying so, so no socket can open", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    // With no record of the operator's, the environment's default stands, and no environment sets it.
    await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), (_instance, state) =>
      state.storage.delete("flags"));
    const flags = await admin<{ shopFeed?: boolean }>("GET", "/v1/admin/flags");
    expect(flags.body.shopFeed).toBe(false);
    expect(await mint(owner.headers)).toEqual({ status: 403, body: { error: "feature_disabled", feature: "shopFeed" } });
    expect(await objectTickets(shop)).toBe(0);
    // With no ticket, an upgrade names nobody.
    expect(await refusal(await upgrade({ ...owner.headers, "sec-websocket-protocol": FEED_PROTOCOL }))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(shop)).toBe(0);
  });

  it("is turned on with PUT /v1/admin/flags, and the mint then answers a ticket for 30 seconds that no cache keeps", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const minted = await sourceWorker.fetch(`https://api.manut.test${FEED_TICKET_PATH}`, { method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" }, body: "{}" });
    expect(minted.status).toBe(200);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    const body = (await minted.json()) as { ticket: string };
    expect(body).toEqual({ feed: "on", protocol: FEED_PROTOCOL, ticket: expect.any(String), expiresIn: 30 });
    // The shop, spelled as a shop session spells it, a dot, and 32 random bytes: only characters a protocol entry may hold,
    // and nothing of the session.
    const [named, secret] = body.ticket.split(".");
    expect(named).toBe(base64url(shop.tenant));
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.ticket).not.toContain(tokenOf(owner.headers).split(".").at(-1));
    expect(await ticketFor(owner.headers)).not.toBe(body.ticket);
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

  it("refuses a ticket minted while on once the shop's object has read it off since, and opens one minted after it is back on", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const open = await openFeed(owner.headers);
    const ticket = await ticketFor(owner.headers);
    ShopFeed.switchFreshMs = 0;
    expect((await setFlags({ shopFeed: false })).status).toBe(200);
    await attention(shop);
    expect(await open.closed).toEqual({ code: FEED_CLOSE.off, reason: "feed_off" });
    expect(await refusal(await upgrade(offering(ticket))))
      .toEqual({ status: 403, body: { error: "feature_disabled", feature: "shopFeed" } });
    expect(await objectSockets(shop)).toBe(0);
    // The mint read it on again after the object read it off, and the newer read wins.
    expect((await setFlags({ shopFeed: true })).status).toBe(200);
    await openFeed(owner.headers);
  });
});

describe("who may mint a ticket", () => {
  it("refuses no session, the operator key and a person's own sign-in, in the approvals list's own words", async () => {
    expect(await mint({})).toEqual(UNAUTHORIZED);
    expect(await mint({ authorization: "Bearer test-key" })).toEqual(UNAUTHORIZED);
    expect(await mint({ authorization: "Bearer mos1.not-a-shop.0000" })).toEqual(UNAUTHORIZED);
    // A person's own sign-in has a tenant but no shop, as the shop's routes answer it.
    const own = await tenantSession("apple:feed-person");
    expect(await mint(own)).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("refuses anything but POST, a query that names the shop, the tenant or the role, any body but {}, and a body that does not say it is JSON", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    expect(await asSession(owner.headers, "GET", FEED_TICKET_PATH)).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    for (const query of ["shop", "tenant", "role"]) {
      expect(await asSession(owner.headers, "POST", `${FEED_TICKET_PATH}?${query}=${encodeURIComponent(shop.tenant)}`, {}), query)
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    for (const body of [{ role: "owner" }, { shop: shop.tenant }, [], "on"]) {
      expect(await asSession(owner.headers, "POST", FEED_TICKET_PATH, body), JSON.stringify(body))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await asSession(owner.headers, "POST", FEED_TICKET_PATH)).toEqual({ status: 400, body: { error: "invalid_json" } });
    // A body sent as anything but JSON is refused at the Worker's front door, as for every POST: a page on another site can
    // make a browser send one of these without asking first.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const sent = await sourceWorker.fetch(`https://api.manut.test${FEED_TICKET_PATH}`, { method: "POST",
        headers: { ...owner.headers, "content-type": type }, body: "{}" });
      expect(await refusal(sent), type).toEqual({ status: 415, body: { error: "json_required" } });
    }
    expect(await objectTickets(shop)).toBe(0);
  });

  it("refuses a removed helper and an unlinked owner as the approvals list does, and closes their sockets within the second", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const helperFeed = await openFeed(helper.headers);
    const ownerFeed = await openFeed(owner.headers);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id })).status).toBe(200);
    expect(await helperFeed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
    // The owner stays, and hears that the shop's people changed.
    expect(await ownerFeed.next()).toEqual(PING);
    expect(await mint(helper.headers)).toEqual({ status: 401, body: { error: "removed", removedAt: expect.any(String) } });
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect(await ownerFeed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
    expect(await mint(owner.headers)).toEqual({ status: 401, body: { error: "unlinked", unlinkedAt: expect.any(String) } });
  });

  it("answers 503 when the shop's object cannot keep the ticket, failing or down", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    for (const throws of [false, true]) {
      const failing = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/feed/ticket", throws);
      expect(await callWith(failing, FEED_TICKET_PATH, { method: "POST", headers: owner.headers, body: {} }), String(throws))
        .toEqual({ status: 503, body: { error: "feed_unavailable" } });
    }
  });

  it("takes a helper's session, whose socket hears what waits at the shop it helps at", async () => {
    const line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
    const shop = await setupShop();
    const helper = await joinHelper(shop);
    const feed = await openFeed(helper.headers);
    await proposeReply(shop, "Your order ships tomorrow");
    expect(await feed.next()).toEqual(PING);
    expect(line.pushes()).toBe(0);
  });

  it("closes the socket of a device that signs out of the shop", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    expect((await asSession(owner.headers, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.sessionEnded, reason: "session_ended" });
  });
});

describe("a ticket", () => {
  it("opens one socket, and never a second", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const ticket = await ticketFor(owner.headers);
    const feed = await openWith(ticket);
    expect(await refusal(await upgrade(offering(ticket)))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(shop)).toBe(1);
    expect(await objectTickets(shop)).toBe(0);
    await attention(shop);
    expect(await feed.next()).toEqual(PING);
  });

  it("is all an upgrade is taken on: answered with manut-feed.v1 alone, never echoed, and a session in Authorization opens nothing", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const response = await upgrade(offering(await ticketFor(owner.headers)));
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe(FEED_PROTOCOL);
    wire(response.webSocket!);
    // A program's upgrade with the shop's session as its bearer, with protocols and without: nobody.
    expect(await refusal(await upgrade(owner.headers))).toEqual(UNAUTHORIZED);
    expect(await refusal(await upgrade({ ...owner.headers, "sec-websocket-protocol": FEED_PROTOCOL }))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(shop)).toBe(1);
  });

  it("is spent by a request refused for its method, its upgrade, its query or its protocols, and a spent one is refused before any of those", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    // A POST is sent without `Upgrade`: workerd hands the Worker any request that asks to upgrade as a GET.
    const refused: [string, (ticket: string) => Promise<Response>, { status: number; body: unknown }][] = [
      ["a POST", (ticket) => sourceWorker.fetch(`https://api.manut.test${FEED_PATH}`, { method: "POST", headers: offering(ticket) }),
        { status: 405, body: { error: "method_not_allowed" } }],
      ["no upgrade", (ticket) => sourceWorker.fetch(`https://api.manut.test${FEED_PATH}`, { headers: offering(ticket) }),
        { status: 400, body: { error: "invalid_request" } }],
      ["a query naming the shop", (ticket) => upgrade(offering(ticket), `${FEED_PATH}?shop=${encodeURIComponent(shop.tenant)}`),
        { status: 400, body: { error: "invalid_request" } }],
      ["protocols without the feed's", (ticket) => upgrade({ "sec-websocket-protocol": `chat.v2, ${TICKET_PROTOCOL}${ticket}` }),
        { status: 400, body: { error: "invalid_request" } }],
    ];
    for (const [what, send, answer] of refused) {
      const ticket = await ticketFor(owner.headers);
      expect(await refusal(await send(ticket)), what).toEqual(answer);
      // What reached a log with that request opens nothing now, and says so before anything else.
      expect(await refusal(await upgrade(offering(ticket))), what).toEqual(UNAUTHORIZED);
      expect(await refusal(await send(ticket)), what).toEqual(UNAUTHORIZED);
    }
    expect(await objectSockets(shop)).toBe(0);
  });

  it("is refused once its time is over", async () => {
    ShopFeed.ticketMs = 300;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const ticket = await ticketFor(owner.headers);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await refusal(await upgrade(offering(ticket)))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(shop)).toBe(0);
    // One minted now still opens.
    ShopFeed.ticketMs = DEFAULTS.ticketMs;
    await openFeed(owner.headers);
  });

  it("for one shop opens nothing at another, even with the other's name on it, and hears only its own", async () => {
    const mali = await setupShop("Baan Mali");
    const noi = await setupShop("Ran Pa Noi");
    const owner = await linkedOwner(mali);
    const ticket = await ticketFor(owner.headers);
    const renamed = `${base64url(noi.tenant)}.${ticket.split(".")[1]!}`;
    expect(await refusal(await upgrade(offering(renamed)))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(noi)).toBe(0);
    // It was never the other shop's to spend: it still opens its own shop's feed, which hears nothing of the other's.
    const feed = await openWith(ticket);
    await attention(noi);
    await shopTask(noi.tenant);
    expect(await feed.next(600)).toBeNull();
    await attention(mali);
    expect(await feed.next()).toEqual(PING);
  });

  it("is refused when its session ended between the mint and the open: signed out, or a helper removed", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const ownerTicket = await ticketFor(owner.headers);
    const helperTicket = await ticketFor(helper.headers);
    expect((await asSession(owner.headers, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id })).status).toBe(200);
    expect(await refusal(await upgrade(offering(ownerTicket)))).toEqual(UNAUTHORIZED);
    expect(await refusal(await upgrade(offering(helperTicket)))).toEqual(UNAUTHORIZED);
    expect(await objectSockets(shop)).toBe(0);
  });

  it("lives in the object's memory only: one the object lost is refused as unknown, and the next one minted opens", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const ticket = await ticketFor(owner.headers);
    await evictDurableObject(tenantStub(bindings, shop.tenant));
    expect(await refusal(await upgrade(offering(ticket)))).toEqual(UNAUTHORIZED);
    await openFeed(owner.headers);
  });

  it("must name a shop: anything else is refused before any shop's object is asked, and a shop session is never one", async () => {
    const secret = "A".repeat(43);
    const owner = `mos1.${base64url("pilot:feed-nobody")}.${"0".repeat(64)}`;
    const junk: [string, Record<string, string>][] = [
      ["no protocols", {}],
      ["no ticket", { "sec-websocket-protocol": FEED_PROTOCOL }],
      ["an empty ticket", offering("")],
      ["no dot", offering(base64url("pilot:feed-nobody"))],
      ["no secret", offering(`${base64url("pilot:feed-nobody")}.`)],
      ["no shop", offering(`.${secret}`)],
      // "YWJ" is a spelling of "ab" that base64url never writes: a shop is named one way only.
      ["a shop spelled two ways", offering(`YWJ.${secret}`)],
      ["a shop longer than a tenant may be", offering(`${base64url("s".repeat(257))}.${secret}`)],
      ["a shop session", offering(owner)],
    ];
    for (const [what, headers] of junk) {
      expect(await upgradeCounting(headers), what).toEqual({ ...UNAUTHORIZED, calls: [] });
    }
    // One that names a shop goes to that shop's object, which alone can say it keeps no such ticket.
    expect(await upgradeCounting(offering(`${base64url("pilot:feed-nobody")}.${secret}`))).toEqual({ ...UNAUTHORIZED, calls: ["/feed"] });
    expect(await upgradeCounting(offering(`${base64url("ab")}.${secret}`))).toEqual({ ...UNAUTHORIZED, calls: ["/feed"] });
  });

  it(`is kept at most ${MAX_FEEDS_PER_SESSION} to a session: a new one takes the place of its oldest, and never another session's`, async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const helperTicket = await ticketFor(helper.headers);
    const tickets: string[] = [];
    for (let i = 0; i <= MAX_FEEDS_PER_SESSION; i += 1) tickets.push(await ticketFor(owner.headers));
    expect(await objectTickets(shop)).toBe(MAX_FEEDS_PER_SESSION + 1);
    expect(await refusal(await upgrade(offering(tickets[0]!)))).toEqual(UNAUTHORIZED);
    for (const ticket of tickets.slice(1)) await openWith(ticket);
    await openWith(helperTicket);
  }, 20_000);

  it("is kept at most ShopFeed.maxPerShop to a shop, all its sessions together, refusing the next until one is over", async () => {
    ShopFeed.maxPerShop = 2;
    ShopFeed.ticketMs = 2_000;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const another = await joinHelper(shop, "Beam");
    await ticketFor(owner.headers);
    await ticketFor(helper.headers);
    const full = await sourceWorker.fetch(`https://api.manut.test${FEED_TICKET_PATH}`, { method: "POST",
      headers: { ...another.headers, "content-type": "application/json" }, body: "{}" });
    expect(full.status).toBe(429);
    expect(full.headers.get("retry-after")).toBe("2");
    expect(await full.json()).toEqual({ error: "feed_shop_full" });
    // Tickets past their time are dropped as the next one is kept, and give their places up.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const ticket = await ticketFor(another.headers);
    expect(await objectTickets(shop)).toBe(1);
    await openWith(ticket);
  }, 20_000);
});

describe("the shop's object itself", () => {
  it("keeps only a ticket the Worker hands it whole, and opens only a ticket it keeps for a session its people hold", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const session = await sha256Hex(tokenOf(owner.headers));
    const keep = (headers: Record<string, string>) => tenantCall(bindings, shop.tenant, "/feed/ticket", { method: "POST",
      headers: { "x-feed": "1", "x-feed-tenant": shop.tenant, "x-feed-role": "owner", "x-feed-session": session,
        "x-feed-ticket": "1".repeat(64), ...headers } });
    const open = (hash: string) => tenantCall(bindings, shop.tenant, "/feed",
      { headers: { upgrade: "websocket", "x-feed": "1", "x-feed-ticket": hash } });
    const bad: [string, Record<string, string>][] = [["no tenant", { "x-feed-tenant": "" }],
      ["a role no session has", { "x-feed-role": "operator" }], ["no role", { "x-feed-role": "" }],
      ["a session that is no hash", { "x-feed-session": "not-a-hash" }], ["a ticket that is no hash", { "x-feed-ticket": "1" }]];
    for (const [what, headers] of bad) {
      expect(await refusal(await keep(headers)), what).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await objectTickets(shop)).toBe(0);
    expect(await refusal(await open("not-a-hash"))).toEqual({ status: 400, body: { error: "invalid_request" } });
    // A ticket it never kept is nobody's.
    expect(await refusal(await open("0".repeat(64)))).toEqual(UNAUTHORIZED);
    // One kept for a session its people record does not hold opens nothing.
    expect(await refusal(await keep({ "x-feed-session": "2".repeat(64), "x-feed-ticket": "3".repeat(64) })))
      .toEqual({ status: 200, body: { kept: true } });
    expect(await refusal(await open("3".repeat(64)))).toEqual(UNAUTHORIZED);
    // One kept for the owner's own session opens, as the Worker's would.
    expect((await refusal(await keep({ "x-feed-ticket": "4".repeat(64) }))).status).toBe(200);
    const opened = await open("4".repeat(64));
    expect(opened.status).toBe(101);
    wire(opened.webSocket!);
    expect(await objectSockets(shop)).toBe(1);
  });

  it("is never reached through its own paths without the Worker's header", async () => {
    const shop = await setupShop();
    const touched = await tenantCall(bindings, shop.tenant, "/feed/touch", { method: "POST" });
    expect(await refusal(touched)).toEqual({ status: 403, body: { error: "forbidden" } });
    const kept = await tenantCall(bindings, shop.tenant, "/feed/ticket", { method: "POST" });
    expect(await refusal(kept)).toEqual({ status: 403, body: { error: "forbidden" } });
    const opened = await tenantCall(bindings, shop.tenant, "/feed", { headers: { upgrade: "websocket" } });
    expect(await refusal(opened)).toEqual({ status: 403, body: { error: "forbidden" } });
  });
});

describe("limits", () => {
  it(`holds ${MAX_FEEDS_PER_SESSION} sockets for one session, refuses the next with feed_session_full, and frees a place when one closes`, async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feeds = [];
    for (let i = 0; i < MAX_FEEDS_PER_SESSION; i += 1) feeds.push(await openFeed(owner.headers));
    const full = await upgrade(offering(await ticketFor(owner.headers)));
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
    const full = await upgrade(offering(await ticketFor(helper.headers)));
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

  it("never come from a read, nor from a ticket minted, so the reads a ping sets off never set off another", async () => {
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
      "/v1/inbound/attention", "/v1/routines", "/v1/people/devices"]) {
      expect((await asSession(owner.headers, "GET", path)).status, path).toBe(200);
    }
    // And the ticket the desktop mints each time it opens a socket, a write the object keeps in memory only.
    expect((await mint(owner.headers)).status).toBe(200);
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

  it("read the switch at most once in ShopFeed.switchFreshMs, the mint's read counting as the first", async () => {
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

  it("read the switch as off when its record cannot be read, and close every socket with 4503 rather than ping", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const feed = await openFeed(owner.headers);
    ShopFeed.switchFreshMs = 0;
    await insideFeed(shop, (inside) => {
      const auth = inside.env.AUTH;
      inside.env = { ...inside.env, AUTH: {
        idFromName: (name: string) => auth.idFromName(name),
        get: () => ({ fetch: async () => Response.json({ error: "fixture" }, { status: 500 }) }),
      } as unknown as DurableObjectNamespace };
    });
    await attention(shop);
    expect(await feed.next(1_000)).toBeNull();
    expect(await feed.closed).toEqual({ code: FEED_CLOSE.off, reason: "feed_off" });
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

  it("leave a new shop's object with nothing of its making open, so it can hibernate at once", async () => {
    const made = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name: "Khao Hom", ownerName: "Fon" });
    expect(made.status).toBe(200);
    // An answer the Worker left unread would hold the object until the runtime gave up on it, seconds later.
    const evicted = await Promise.race([evictDurableObject(tenantStub(bindings, made.body.tenant)).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500))]);
    expect(evicted).toBe(true);
  });

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

/// A queued task of the shop's, as the create route leaves one: in the index, then made.
async function queuedTask(shop: Shop, taskId: string): Promise<void> {
  await indexed(shop, taskId);
  const made = await trustedTaskPut(taskId, { id: taskId, title: "Answer the parcel question", objective: "Reply to the customer",
    state: "queued", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, shop.tenant);
  expect(made.status).toBe(200);
  await made.text();
}

/// A call to the task object as the job flow makes it, read whole: its status and its body.
async function onTask(shop: Shop, taskId: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await taskStub(taskId).fetch(new Request(`https://task${path}`, { method: "POST",
    headers: { "content-type": "application/json", "x-tenant": shop.tenant }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("a task's own changes", () => {
  it("ping when the task itself changes, a run is claimed, its draft is kept and it finishes, and never for its progress", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const taskId = `feed-task-${crypto.randomUUID()}`;
    await indexed(shop, taskId);
    const feed = await openFeed(owner.headers);
    const made = await trustedTaskPut(taskId, { id: taskId, title: "Answer the parcel question", objective: "Reply to the customer",
      state: "queued", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, shop.tenant);
    expect(made.status).toBe(200);
    await made.text();
    expect(await feed.next(), "the task made").toEqual(PING);
    const claimed = await onTask(shop, taskId, "/attempts", { executorId: "exec-1", inputRevision: "rev-1" });
    expect(claimed.status).toBe(200);
    expect(await feed.next(), "a run claimed").toEqual(PING);
    const { id, fence } = claimed.body as { id: string; fence: number };
    expect((await onTask(shop, taskId, `/attempts/${id}/heartbeat`, { fence })).status).toBe(200);
    expect(await feed.next(600), "a heartbeat").toBeNull();
    expect((await onTask(shop, taskId, `/attempts/${id}/draft`, { fence, draft: { member: "nam", job: "reply", text: "It ships today." } }))
      .status).toBe(200);
    expect(await feed.next(), "a draft").toEqual(PING);
    // A write the task refused changed nothing, and tells nobody.
    expect((await onTask(shop, taskId, `/attempts/${id}/draft`, { fence, draft: { member: "nam", job: "reply", text: "Again." } }))
      .status).toBe(409);
    expect(await feed.next(600), "a refused draft").toBeNull();
    expect((await onTask(shop, taskId, `/attempts/${id}/finish`, { fence, outcome: "done" })).status).toBe(200);
    expect(await feed.next(), "a run finished").toEqual(PING);
  }, 20_000);

  it("ping when a request is decided, from the request's own task", async () => {
    // The reply's task told its shop when it was proposed, before anyone followed, and would stay quiet for a minute; the
    // quiet is the next test's, so here it is none.
    TaskObject.feedQuietMs = 0;
    stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const reply = await proposeReply(shop, "We open at nine");
    const feed = await openFeed(owner.headers);
    expect((await decide(owner.headers, reply.actionId, { optionId: "decline", seenRevision: 1 })).status).toBe(200);
    expect(await feed.next()).toEqual(PING);
  });

  it("come from exactly the task routes that change what the shop's list shows", () => {
    const touching: [string, string][] = [["PUT", "/"], ["POST", "/commands"], ["POST", "/attempts"], ["POST", "/attempts/sweep"],
      ["POST", "/attempts/a1/finish"], ["POST", "/attempts/a1/end"], ["POST", "/attempts/a1/ask"], ["POST", "/attempts/a1/ask-submit"],
      ["POST", "/attempts/a1/ask-books"], ["POST", "/attempts/a1/draft"], ["POST", "/actions"], ["POST", "/actions/x1/decision"],
      ["POST", "/actions/x1/begin"], ["POST", "/actions/x1/settle"], ["POST", "/requests/r1/decision"]];
    const quiet: [string, string][] = [["GET", "/"], ["GET", "/listing"], ["GET", "/requests"], ["GET", "/requests/r1"],
      ["POST", "/attempts/a1/heartbeat"], ["POST", "/attempts/a1/steps"], ["POST", "/attempts/a1/events"],
      ["POST", "/attempts/a1/outpost-events"], ["POST", "/prune"], ["DELETE", "/wipe"], ["POST", "/detach-company"],
      ["PUT", "/attempts"], ["POST", "/attempts/a1/draft/extra"], ["POST", "/requests/r1"]];
    for (const [method, path] of touching) expect(touchesFeed(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of quiet) expect(touchesFeed(method, path), `${method} ${path}`).toBe(false);
  });

  it("cost a shop nobody follows one call from a busy task, and then nothing for TaskObject.feedQuietMs", async () => {
    TaskObject.feedQuietMs = 1_500;
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const taskId = `feed-task-${crypto.randomUUID()}`;
    // Every call the task object makes to its shop's object, by path, and how many of its touches were answered.
    const calls: string[] = [];
    let answered = 0;
    await runInDurableObject(taskStub(taskId), (instance) => {
      const holder = instance as unknown as { env: Record<string, unknown> };
      const tenants = holder.env.TENANT as DurableObjectNamespace;
      holder.env = { ...holder.env, TENANT: {
        idFromName: (name: string) => tenants.idFromName(name),
        get: (objectId: DurableObjectId) => {
          const stub = tenants.get(objectId);
          return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            calls.push(path);
            const response = await stub.fetch(request);
            if (path === "/feed/touch") answered += 1;
            return response;
          } };
        },
      } as unknown as DurableObjectNamespace };
    });
    const touches = () => calls.filter((path) => path === "/feed/touch").length;
    await queuedTask(shop, taskId);
    // Quiet from when the shop answered that nobody follows it: a write before that answer would still tell it.
    await vi.waitFor(() => expect(answered).toBe(1));
    const claimed = await onTask(shop, taskId, "/attempts", { executorId: "exec-1", inputRevision: "rev-1" });
    const { id, fence } = claimed.body as { id: string; fence: number };
    const feed = await openFeed(owner.headers);
    expect((await onTask(shop, taskId, `/attempts/${id}/draft`, { fence, draft: { member: "nam", job: "reply", text: "Soon." } })).status)
      .toBe(200);
    expect(await feed.next(400)).toBeNull();
    expect(touches()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await onTask(shop, taskId, `/attempts/${id}/finish`, { fence, outcome: "done" })).status).toBe(200);
    expect(await feed.next()).toEqual(PING);
    expect(touches()).toBe(2);
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
});
