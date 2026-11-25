/// A shop's live feed (docs/pilot-api.md, "The shop's live feed"; December item 61): a WebSocket that tells a shop's
/// connected desktops that something their screens read has changed there, so they read the shop again within seconds
/// instead of at their next one-minute read. Built switched off: until the operator turns `shopFeed` on, the route
/// answers 403 `feature_disabled` and nothing else changes.
///
/// The feed carries no data. Each message is `{ "v": 1, "seq": n }` and says only that something changed; the desktop
/// then reads as it reads each minute, with its own session, so the feed can never show anyone what their session could
/// not read. It decides nothing either: approvals still settle only through approval-core.
///
/// - The Worker's mint (`mintTicket`, `POST /v1/feed/ticket`) takes a shop's session as the approvals list takes it
///   (`callerOf`: an owner's or a helper's), checks the switch, and has the shop's TenantObject keep a one-use ticket for
///   that session. The session travels only in `Authorization`, which Cloudflare's request logs mask by its name.
/// - The upgrade (`openFeed`, `GET /v1/feed`) carries nothing but that ticket. A browser's WebSocket can send no
///   `Authorization` header and a token never goes in a URL, so a page sends the ticket as one entry of the
///   `Sec-WebSocket-Protocol` header, `manut-ticket.<ticket>`, beside `manut-feed.v1`, the one protocol ever answered.
///   Cloudflare's logs record that header as it is (they mask a header only when its name says it holds a secret), so a
///   session there would be written into the account's logs. A ticket written there is worth nothing: the request that
///   wrote it spends it, and it is dead 30 seconds after it was made. The Worker reads the shop from the ticket and passes
///   the object only the SHA-256 of its secret, and the object takes the ticket out before anything else, so it opens one
///   socket at most.
/// - The TenantObject (`ShopFeed`) accepts the socket with the hibernation API, so an idle socket costs no object time,
///   and keeps everything a socket needs in its attachment, never in a field that hibernation would lose. It pings its
///   sockets after each write it takes that a screen reads (a task indexed, a request about to open, an attention item,
///   the routines and the team, the people), and after a task object tells it of a change of its own (feed-touch.ts), at
///   most once a second (`ShopFeed.coalesceMs`).
/// - Limits: `MAX_FEEDS_PER_SESSION` sockets for one session and `ShopFeed.maxPerShop` for one shop, each refusal its own
///   code, and as many unused tickets. A socket lives an hour at most and is then closed with 4000, so its desktop mints a
///   ticket and opens it again, which checks the session and the switch again. Each ping first checks every socket's
///   session and the switch: a socket whose session no longer works is closed with 4401 instead, and every socket with
///   4503 once the switch reads off. Every change to the shop's people pings, so a helper the owner removes or a device
///   that signs out is closed within the second.
///
/// Nothing here logs, so no token, ticket, hash or shop can reach a log from here.

import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { bearer, callerOf, fromBase64url, hasExactly, isShopSession, queryNamesSession, type PeopleEnv } from "./people";
import { shopSessionWorks } from "./people-store";
import { base64url } from "./relay";
import { authCall, tenantStub, type TenantDataEnv } from "./tenant-data";

/// The socket's address. A plain `GET` with no ticket is no longer a look at whether the feed is on: the mint says so.
export const FEED_PATH = "/v1/feed";
/// Where a shop's session mints the ticket that opens its socket.
export const FEED_TICKET_PATH = "/v1/feed/ticket";
/// The one protocol the feed speaks, and the only one it ever answers. A page must offer it beside its ticket, and a
/// browser fails any handshake whose answer names a protocol it did not offer, or none when it offered some.
export const FEED_PROTOCOL = "manut-feed.v1";
/// The protocol entry that carries a ticket: `manut-ticket.<ticket>`. It is read in the Worker and never answered.
export const TICKET_PROTOCOL = "manut-ticket.";
/// The most sockets one session holds at a time. A desktop holds one for each shop session, and one more while it opens a
/// socket again before the API has noticed that the old one dropped. A session holds as many unused tickets at most.
export const MAX_FEEDS_PER_SESSION = 3;

const MAX_BODY_BYTES = 16 * 1024;
/// A ticket as the mint writes it: the shop in base64url, a dot, and the secret, 32 random bytes in base64url. The shop is
/// spelled as a shop session spells it (people.ts), since a tenant may hold characters, such as `:`, that a protocol entry
/// may not (RFC 6455 takes its entries as RFC 2616 tokens), and the dot cannot appear in either part.
const TICKET = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/// Why the object closed a socket, in the range RFC 6455 leaves to applications, as the relay's codes are
/// (relay-object.ts). The desktop opens the feed again at once after `renew`, waits an hour after `off`, and otherwise
/// backs off and asks again; every one of them leaves its one-minute read as it was.
export const FEED_CLOSE = {
  /// The socket's hour is over: open it again now, which checks the session and the switch again.
  renew: 4000,
  /// The client sent something other than the keepalive.
  badRequest: 4400,
  /// Its session no longer works: signed out, run out, removed by the owner, or unlinked by the operator.
  sessionEnded: 4401,
  /// It sent no keepalive for `ShopFeed.silentMs` while its session or its shop needed the place it held.
  silent: 4408,
  /// The shop's data was deleted.
  shopDeleted: 4410,
  /// The switch reads off.
  off: 4503,
} as const;

/// What one socket carries across hibernation: whose session holds it (the SHA-256 of the token, as the shop's people
/// record keeps it), as what role, for which shop, when it was accepted and when its hour is over (Unix milliseconds).
type FeedAttachment = { tenant: string; session: string; role: "owner" | "helper"; at: number; until: number };

/// A ticket the shop's object keeps until it is used or its time is over, by the SHA-256 of its secret: the shop, whose
/// session minted it (the SHA-256 of the token) and as what role, when it was kept, which is just after the mint read the
/// switch as on, and when it ends (Unix milliseconds).
type Ticket = { tenant: string; session: string; role: "owner" | "helper"; at: number; until: number };

const FEED_TAG = "feed";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const sessionTag = (session: string) => `session:${session}`;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// The protocols a handshake offers, in order. An empty entry is not one.
function offeredProtocols(request: Request): string[] {
  const header = request.headers.get("sec-websocket-protocol");
  return header ? header.split(",").map((one) => one.trim()).filter((one) => one.length > 0) : [];
}

/// The ticket a handshake offers in its `manut-ticket.` entry, as the shop it names and its secret; null for none, and for
/// one that names no shop, so nothing that could not be a ticket ever wakes a shop's object.
function ticketOf(offered: readonly string[]): { shop: string; secret: string } | null {
  const entry = offered.find((one) => one.startsWith(TICKET_PROTOCOL));
  const match = entry ? TICKET.exec(entry.slice(TICKET_PROTOCOL.length)) : null;
  const shop = match ? fromBase64url(match[1]!) : null;
  return match && shop !== null && isValidTenant(shop) ? { shop, secret: match[2]! } : null;
}

export type FeedFlags = () => Promise<{ shopFeed: boolean }>;

/// `POST /v1/feed/ticket` and `GET /v1/feed` (docs/pilot-api.md, "The shop's live feed"). Answers null for any other path.
export async function feedRoute(request: Request, url: URL, env: PeopleEnv, flags: FeedFlags): Promise<Response | null> {
  if (url.pathname === FEED_TICKET_PATH) return mintTicket(request, url, env, flags);
  if (url.pathname === FEED_PATH) return openFeed(request, url, env);
  return null;
}

/// `POST /v1/feed/ticket` with exactly `{}`: a ticket that opens one socket of the session's own shop's feed within
/// `ShopFeed.ticketMs`, answered with `cache-control: no-store`. In the order every session route keeps: who is asking
/// first (the approvals list's own refusals, then 404 for a bearer that is no shop session, since a person's own sign-in
/// has no shop), then the method, the query, the body and the switch. A body that does not say it is JSON never gets
/// here: the Worker's front door answers it 415 (`jsonBodyRefusal` in index.ts), as it does for every POST.
async function mintTicket(request: Request, url: URL, env: PeopleEnv, flags: FeedFlags): Promise<Response> {
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  const token = bearer(request);
  if (!isShopSession(token)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  // The session names the shop and the role. Nothing in the body may, so a body with any field is refused.
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || !hasExactly(parsed.value, [])) return json({ error: "invalid_request" }, 400);
  if (!(await flags()).shopFeed) return json({ error: "feature_disabled", feature: "shopFeed" }, 403);
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  // The object keeps only hashes, of the session as its people record keeps it and of the ticket's secret.
  const kept = await tenantStub(env, caller.shop).fetch(new Request("https://tenant/feed/ticket", { method: "POST",
    headers: { "x-feed": "1", "x-feed-tenant": caller.shop, "x-feed-role": caller.role,
      "x-feed-session": await sha256Hex(token), "x-feed-ticket": await sha256Hex(secret) } })).catch(() => null);
  // The shop's tickets are at their limit: its refusal, with when to try again, is the answer.
  if (kept?.status === 429) return kept;
  await kept?.body?.cancel();
  if (!kept?.ok) return json({ error: "feed_unavailable" }, 503);
  const ticket = `${base64url(new TextEncoder().encode(caller.shop))}.${secret}`;
  return json({ feed: "on", protocol: FEED_PROTOCOL, ticket, expiresIn: Math.floor(ShopFeed.ticketMs / 1000) }, 200,
    { "cache-control": "no-store" });
}

/// `GET /v1/feed` with `Upgrade: websocket` and the ticket among its protocols (`manut-feed.v1, manut-ticket.<ticket>`):
/// the socket, or the refusal. The ticket is who is asking, so it is read first, and only the shop's object can say
/// whether it keeps it. Nothing else names anyone: an `Authorization` header opens no socket, and a program mints a ticket
/// as the desktop does. Every request that carries a ticket hands it to the object, which takes it out before it answers
/// anything, so a ticket that reached a log was spent by the request that put it there, even one refused here for its
/// method, its query or its protocols. The object's own refusal of the ticket comes first; this route's comes after.
async function openFeed(request: Request, url: URL, env: PeopleEnv): Promise<Response> {
  const offered = offeredProtocols(request);
  const ticket = ticketOf(offered);
  if (!ticket) return json({ error: "unauthorized" }, 401);
  const refusal = request.method !== "GET" ? json({ error: "method_not_allowed" }, 405)
    : request.headers.get("upgrade")?.toLowerCase() !== "websocket" || queryNamesSession(url) ||
        !offered.includes(FEED_PROTOCOL) ? json({ error: "invalid_request" }, 400)
      : null;
  // A request built here, never the client's: the object sees the ticket's hash, and the upgrade only when this route
  // would let the socket open, so that without it the object takes the ticket out and opens nothing.
  const headers = new Headers({ "x-feed": "1", "x-feed-ticket": await sha256Hex(ticket.secret) });
  if (!refusal) headers.set("upgrade", "websocket");
  const answer = await tenantStub(env, ticket.shop).fetch(new Request("https://tenant/feed", { headers }));
  if (!refusal || answer.status === 401) return answer;
  await answer.body?.cancel();
  return refusal;
}

type FeedObjectEnv = Pick<TenantDataEnv, "AUTH"> & { SHOP_FEED?: string };

/// Whether the feed is switched on: the operator's dynamic record over the environment's default, the same rule as
/// index.ts's `featureFlags`, for the one switch the object needs. It runs inside the TenantObject, where index.ts is not,
/// as routines.ts's `runFlags` runs inside the schedule object. A record that cannot be read falls back to the default,
/// which is off in every environment.
async function switchedOn(env: FeedObjectEnv): Promise<boolean> {
  const fallback = env.SHOP_FEED === "1";
  try {
    const response = await authCall(env, "/flags");
    if (!response.ok) {
      await response.body?.cancel();
      return fallback;
    }
    const dynamic = (await response.json()) as { shopFeed?: unknown };
    return typeof dynamic.shopFeed === "boolean" ? dynamic.shopFeed : fallback;
  } catch {
    return fallback;
  }
}

function attachmentOf(ws: WebSocket): FeedAttachment {
  return ws.deserializeAttachment() as FeedAttachment;
}

/// Closes a socket that is still open. One that is already closing is left to finish.
function end(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.close(code, reason);
  } catch {
    // A socket the client dropped at the same moment needs no close of its own.
  }
}

/// The sockets of one shop's live feed, inside its TenantObject (tenant-object.ts). It holds no state a socket needs
/// beyond what hibernation keeps (the attachments), only what makes pings cheaper: the coalescing timer, the last `seq`
/// and the last read of the switch, each of which a fresh instance simply starts again; and the tickets not yet used.
export class ShopFeed {
  /// Static so tests can shorten them, as the relay's are.
  /// How long a ticket opens a socket after it is minted. The desktop opens its socket as soon as the mint answers, so a
  /// ticket is used within a second; this bounds what one that was never used is worth.
  static ticketMs = 30_000;
  /// Pings are coalesced to at most one in this long: a write schedules the ping, and every write until it is sent rides
  /// with it, so a burst of writes is one ping and one read.
  static coalesceMs = 1_000;
  /// A socket's longest life. Then it is closed with 4000 and its desktop opens it again, which checks the session and
  /// the switch again, so a switch turned off reaches even a shop where nothing is written within the hour.
  static maxAgeMs = 60 * 60_000;
  /// A socket that sent no keepalive for this long gives up its place when its session or its shop is at the limit. A
  /// window the system has put to sleep can delay a desktop's keepalive by minutes, so this is generous.
  static silentMs = 10 * 60_000;
  /// The most sockets one shop holds, all its sessions together.
  static maxPerShop = 50;
  /// How long a read of the switch is used before it is read again, so a busy shop asks the auth object at most once a
  /// minute, and a switch turned off stops every busy shop's pings within a minute.
  static switchFreshMs = 60_000;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private switch: { on: boolean; at: number } | null = null;
  /// The tickets minted and not yet used, by the SHA-256 of their secret, oldest first. In memory and never in storage: a
  /// ticket lives seconds, so nothing durable is written for it and nothing is left to sweep after a restart. A ticket
  /// this instance loses (evicted, or a deploy) is refused as unknown, which costs its desktop one retry with backoff.
  private readonly tickets = new Map<string, Ticket>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: FeedObjectEnv,
  ) {}

  /// The feed's open sockets, all of them or one session's.
  private sockets(tag = FEED_TAG): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /// `POST /feed/ticket` from the Worker's mint (`mintTicket`), which has checked the session and the switch: keeps the
  /// ticket for `ticketMs`. One session holds at most `MAX_FEEDS_PER_SESSION` unused tickets, as it holds at most that
  /// many sockets: its next ticket takes the place of its oldest, so however fast one session mints it never holds more,
  /// and never takes another's place. The shop holds at most `maxPerShop`, as many as the sockets it may hold, and
  /// refuses the next until one is used or over; tickets past their time are dropped first.
  keep(request: Request): Response {
    const tenant = request.headers.get("x-feed-tenant") ?? "";
    const session = request.headers.get("x-feed-session") ?? "";
    const role = request.headers.get("x-feed-role");
    const hash = request.headers.get("x-feed-ticket") ?? "";
    if (!isValidTenant(tenant) || !SHA256_HEX.test(session) || !SHA256_HEX.test(hash) ||
        (role !== "owner" && role !== "helper")) {
      return json({ error: "invalid_request" }, 400);
    }
    const now = Date.now();
    this.dropOver(now);
    const own = [...this.tickets].filter(([, held]) => held.session === session);
    if (own.length >= MAX_FEEDS_PER_SESSION) this.tickets.delete(own[0]![0]);
    if (this.tickets.size >= ShopFeed.maxPerShop) {
      return json({ error: "feed_shop_full" }, 429, { "retry-after": String(Math.ceil(ShopFeed.ticketMs / 1000)) });
    }
    this.tickets.set(hash, { tenant, session, role, at: now, until: now + ShopFeed.ticketMs });
    return json({ kept: true });
  }

  /// Drops every ticket whose time is over.
  private dropOver(now: number): void {
    for (const [hash, ticket] of this.tickets) if (ticket.until <= now) this.tickets.delete(hash);
  }

  /// `GET /feed` from the Worker (`openFeed`): the upgrade accepted as a hibernatable socket, or the refusal. The ticket is
  /// taken out before anything else, so it opens one socket at most, whatever is answered. Then it must be one this object
  /// keeps, within its time, for a session that still works now: its people record is read again, since the session may
  /// have ended after the mint. A request the Worker sends without the upgrade only spends its ticket. A socket past its
  /// hour never holds a place, and when a session or the shop is at its limit, sockets that went silent give theirs up
  /// before anyone is refused.
  accept(request: Request): Response {
    const hash = request.headers.get("x-feed-ticket") ?? "";
    if (!SHA256_HEX.test(hash)) return json({ error: "invalid_request" }, 400);
    const now = Date.now();
    this.dropOver(now);
    const ticket = this.tickets.get(hash);
    this.tickets.delete(hash);
    if (!ticket || !shopSessionWorks(this.ctx.storage.kv, ticket.tenant, ticket.session, now)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "invalid_request" }, 400);
    // The mint read the switch as on just before the ticket was kept. A read here that is newer wins, so a ticket minted
    // before the switch was turned off opens nothing once this object has read it off, and the mint's read never stands
    // for a moment later than it was made.
    const read = this.switch !== null && this.switch.at >= ticket.at ? this.switch : { on: true, at: ticket.at };
    if (!read.on) return json({ error: "feature_disabled", feature: "shopFeed" }, 403);
    this.switch = read;
    const { tenant, session, role } = ticket;
    this.renew(now);
    if (this.full(this.sockets(sessionTag(session)), MAX_FEEDS_PER_SESSION, now)) {
      return json({ error: "feed_session_full" }, 429, { "retry-after": "60" });
    }
    if (this.full(this.sockets(), ShopFeed.maxPerShop, now)) {
      return json({ error: "feed_shop_full" }, 429, { "retry-after": "60" });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [FEED_TAG, sessionTag(session)]);
    server.serializeAttachment({ tenant, session, role, at: now, until: now + ShopFeed.maxAgeMs } satisfies FeedAttachment);
    // The Worker hands an upgrade over only when the page offered the feed's protocol, and the answer names it and
    // nothing else: never the ticket.
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": FEED_PROTOCOL } });
  }

  /// Whether `sockets` already fill `limit` places, once the ones that went silent have given theirs up.
  private full(sockets: WebSocket[], limit: number, now: number): boolean {
    if (sockets.length < limit) return false;
    for (const ws of sockets) if (this.silent(ws, now)) end(ws, FEED_CLOSE.silent, "silent");
    return sockets.filter((ws) => ws.readyState === WebSocket.OPEN).length >= limit;
  }

  /// Whether a socket has said nothing for `silentMs`: no keepalive answered since then, and accepted before then. The
  /// runtime answers the keepalive itself (tenant-object.ts), so this reads when it last did.
  private silent(ws: WebSocket, now: number): boolean {
    const heard = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(attachmentOf(ws).at, heard) <= now - ShopFeed.silentMs;
  }

  /// Something the shop's screens read changed: every open socket is pinged within `coalesceMs`, unless a ping is already
  /// on its way, which then carries this change too. Answers how many sockets are open. With none open it does nothing,
  /// so a shop nobody follows, and every shop while the switch is off, pays nothing for the writes it takes.
  touch(): number {
    const listening = this.sockets().length;
    if (listening > 0 && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.ping().catch(() => undefined);
      }, ShopFeed.coalesceMs);
    }
    return listening;
  }

  /// Sends the ping to every socket that may still have it: the switch must read on (read again at most once a minute),
  /// the socket's hour must not be over, and its session must still work. Any other socket is closed instead, with why.
  private async ping(): Promise<void> {
    if (this.sockets().length === 0) return;
    const now = Date.now();
    if (this.switch === null || now - this.switch.at >= ShopFeed.switchFreshMs) {
      this.switch = { on: await switchedOn(this.env), at: now };
    }
    const on = this.switch.on;
    // Only ever grows, across instances too: a fresh instance starts from the clock, and pings are a second apart.
    const seq = (this.seq = Math.max(this.seq + 1, now));
    const message = JSON.stringify({ v: 1, seq });
    const kv = this.ctx.storage.kv;
    for (const ws of this.sockets()) {
      const { tenant, session, until } = attachmentOf(ws);
      if (!on) end(ws, FEED_CLOSE.off, "feed_off");
      else if (until <= now) end(ws, FEED_CLOSE.renew, "renew");
      else if (!shopSessionWorks(kv, tenant, session, now)) end(ws, FEED_CLOSE.sessionEnded, "session_ended");
      else {
        try {
          ws.send(message);
        } catch {
          // A socket that dropped as the ping went out is the runtime's to close.
        }
      }
    }
  }

  /// The shop's data was deleted: every socket is closed, and its desktop learns from its next read that the shop is gone.
  closeAll(code: number, reason: string): void {
    for (const ws of this.sockets()) end(ws, code, reason);
  }

  /// A client sent something other than the keepalive, which the runtime answers without waking the object. The socket is
  /// closed rather than read, so a client cannot keep the object awake by talking to it.
  refuse(ws: WebSocket): void {
    end(ws, FEED_CLOSE.badRequest, "bad_request");
  }

  // The object's alarm (tenant-object.ts `jobs`) closes each socket whose hour is over.

  /// When the next socket's hour is over, or null with none open.
  nextRenewAt(): number | null {
    let soonest: number | null = null;
    for (const ws of this.sockets()) {
      const { until } = attachmentOf(ws);
      if (soonest === null || until < soonest) soonest = until;
    }
    return soonest;
  }

  renewDue(now: number): boolean {
    return this.sockets().some((ws) => attachmentOf(ws).until <= now);
  }

  /// Closes with 4000 every socket whose hour is over, so its desktop opens it again.
  renew(now: number): void {
    for (const ws of this.sockets()) if (attachmentOf(ws).until <= now) end(ws, FEED_CLOSE.renew, "renew");
  }
}
