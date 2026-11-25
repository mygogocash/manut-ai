/// A shop's live feed (docs/pilot-api.md, "The shop's live feed"; December item 61): a WebSocket that tells a shop's
/// connected desktops that something their screens read has changed there, so they read the shop again within seconds
/// instead of at their next one-minute read. Built switched off: until the operator turns `shopFeed` on, the route
/// answers 403 `feature_disabled` and nothing else changes.
///
/// The feed carries no data. Each message is `{ "v": 1, "seq": n }` and says only that something changed; the desktop
/// then reads as it reads each minute, with its own session, so the feed can never show anyone what their session could
/// not read. It decides nothing either: approvals still settle only through approval-core.
///
/// - The Worker (`feedRoute`) takes a shop's session as the approvals list takes it (`callerOf`: an owner's or a
///   helper's), checks the switch, and hands the upgrade to the shop's TenantObject. A browser's WebSocket can send no
///   `Authorization` header, and a token never goes in a URL, so a page sends its session as one entry of the
///   `Sec-WebSocket-Protocol` header, `manut-bearer.<token>`, beside `manut-feed.v1`, the one protocol ever answered. The
///   Worker reads it and passes the object only the token's hash, the role and the shop.
/// - The TenantObject (`ShopFeed`) accepts the socket with the hibernation API, so an idle socket costs no object time,
///   and keeps everything a socket needs in its attachment, never in a field that hibernation would lose. It pings its
///   sockets after each write it takes that a screen reads (a task indexed, a request about to open, an attention item,
///   the routines and the team, the people), and after a task object tells it of a change of its own (`touchFeed`), at
///   most once a second (`ShopFeed.coalesceMs`).
/// - Limits: `MAX_FEEDS_PER_SESSION` sockets for one session and `ShopFeed.maxPerShop` for one shop, each refusal its own
///   code. A socket lives an hour at most and is then closed with 4000, so its desktop opens it again, which checks the
///   session and the switch again. A socket whose session no longer works is closed with 4401, and every socket with 4503
///   once the switch reads off.
///
/// Nothing here logs, so no token, hash or shop can reach a log.

import { sha256Hex } from "./auth";
import { isValidTenant } from "./companies";
import { callerOf, isShopSession, queryNamesSession, type PeopleEnv } from "./people";
import { shopSessionWorks } from "./people-store";
import { authCall, tenantCall, tenantStub, type TenantDataEnv } from "./tenant-data";

export const FEED_PATH = "/v1/feed";
/// The one protocol the feed speaks, and the only one it ever answers. A client that offers protocols must offer this
/// one, and a browser fails any handshake whose answer names a protocol it did not offer, or none when it offered some.
export const FEED_PROTOCOL = "manut-feed.v1";
/// The protocol entry that carries a page's shop session: `manut-bearer.<token>`. A shop session's token is base64url and
/// hex joined by dots, all characters a protocol entry may hold. The entry is read in the Worker and goes nowhere else:
/// it is never answered, never passed to the object and never logged.
export const BEARER_PROTOCOL = "manut-bearer.";
/// The most sockets one session holds at a time. A desktop holds one for each shop session, and one more while it opens a
/// socket again before the API has noticed that the old one dropped.
export const MAX_FEEDS_PER_SESSION = 3;

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

const FEED_TAG = "feed";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const sessionTag = (session: string) => `session:${session}`;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

/// The protocols a handshake offers, in order. An empty entry is not one.
function offeredProtocols(request: Request): string[] {
  const header = request.headers.get("sec-websocket-protocol");
  return header ? header.split(",").map((one) => one.trim()).filter((one) => one.length > 0) : [];
}

/// The bearer a request carries: its `Authorization` header, which a program sends, else the `manut-bearer.` protocol
/// entry a page's handshake sends.
function bearerOf(request: Request, offered: readonly string[]): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
  const entry = offered.find((one) => one.startsWith(BEARER_PROTOCOL));
  return entry ? entry.slice(BEARER_PROTOCOL.length) : "";
}

export type FeedFlags = () => Promise<{ shopFeed: boolean }>;

/// `GET /v1/feed` (docs/pilot-api.md, "The shop's live feed"). Answers null for any other path. In the order every session
/// route keeps: who is asking first (the approvals list's own refusals, then 404 for a bearer that is no shop session,
/// since a person's own sign-in has no shop), then the method, the query and the switch. Then a plain `GET` is the
/// desktop's look at whether the feed is on (200), and an upgrade is handed to the shop's TenantObject, which answers 101
/// or its own refusal (`ShopFeed.accept`).
export async function feedRoute(request: Request, url: URL, env: PeopleEnv, flags: FeedFlags): Promise<Response | null> {
  if (url.pathname !== FEED_PATH) return null;
  const offered = offeredProtocols(request);
  const token = bearerOf(request, offered);
  // The bearer reaches `callerOf` as the header it reads, so the feed takes exactly the sessions the approvals list takes
  // and refuses the others in the same words.
  const caller = await callerOf(new Request(request.url, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  if (caller instanceof Response) return caller;
  if (!isShopSession(token)) return json({ error: "not_found" }, 404);
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  if (!(await flags()).shopFeed) return json({ error: "feature_disabled", feature: "shopFeed" }, 403);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ feed: "on", protocol: FEED_PROTOCOL }, 200, { "cache-control": "no-store" });
  }
  if (offered.length > 0 && !offered.includes(FEED_PROTOCOL)) return json({ error: "invalid_request" }, 400);
  // A request built here, never the client's: the object sees the upgrade, the shop, the role and the token's hash, and
  // nothing the client sent can reach it.
  const headers = new Headers({
    upgrade: "websocket",
    "x-feed": "1",
    "x-feed-tenant": caller.shop,
    "x-feed-role": caller.role,
    "x-feed-session": await sha256Hex(token),
  });
  if (offered.length > 0) headers.set("x-feed-protocol", FEED_PROTOCOL);
  return tenantStub(env, caller.shop).fetch(new Request("https://tenant/feed", { headers }));
}

/// A task object telling its shop's TenantObject that something its screens read changed in the task (task-object.ts):
/// one call to the shop's object, which pings within a second. Answers how many sockets the shop has open, so a task
/// object of a shop nobody follows can stay quiet a while, or null when the object could not be told; nothing waits on
/// it and nothing fails with it, since the desktop's one-minute read stands whatever the feed does.
export async function touchFeed(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<number | null> {
  if (!isValidTenant(tenant)) return null;
  try {
    const response = await tenantCall(env, tenant, "/feed/touch", { method: "POST", headers: { "x-feed": "1" } });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = (await response.json()) as { listening?: unknown };
    return typeof body.listening === "number" ? body.listening : null;
  } catch {
    return null;
  }
}

/// How long a task object stays quiet after its shop said nobody follows it: a desktop that connects meanwhile sees that
/// task's changes at its next one-minute read, as it would without the feed.
export const FEED_QUIET_MS = 60_000;

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
/// and the last read of the switch, each of which a fresh instance simply starts again.
export class ShopFeed {
  /// Static so tests can shorten them, as the relay's are.
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

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: FeedObjectEnv,
  ) {}

  /// The feed's open sockets, all of them or one session's.
  private sockets(tag = FEED_TAG): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /// `GET /feed` from the Worker (`feedRoute`), which has already checked the session and the switch: the upgrade
  /// accepted as a hibernatable socket, or the refusal. The session is checked here once more against the shop's people
  /// record, in case it ended in between. A socket past its hour never holds a place, and when a session or the shop is at
  /// its limit, sockets that went silent give theirs up before anyone is refused.
  accept(request: Request): Response {
    const tenant = request.headers.get("x-feed-tenant") ?? "";
    const session = request.headers.get("x-feed-session") ?? "";
    const role = request.headers.get("x-feed-role");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !isValidTenant(tenant) ||
        !SHA256_HEX.test(session) || (role !== "owner" && role !== "helper")) {
      return json({ error: "invalid_request" }, 400);
    }
    const now = Date.now();
    if (!shopSessionWorks(this.ctx.storage.kv, tenant, session, now)) return json({ error: "unauthorized" }, 401);
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
    // The Worker hands an upgrade over only while the switch reads on, so that read stands for the next minute.
    this.switch = { on: true, at: now };
    const protocol: Record<string, string> = request.headers.get("x-feed-protocol") === FEED_PROTOCOL
      ? { "sec-websocket-protocol": FEED_PROTOCOL } : {};
    return new Response(null, { status: 101, webSocket: client, headers: protocol });
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

  /// The shop's people record changed: every socket whose session no longer works is closed now, so a helper the owner
  /// removed, a device that signed out of the shop and an account the operator unlinked hear nothing more.
  dropEnded(): void {
    const now = Date.now();
    const kv = this.ctx.storage.kv;
    for (const ws of this.sockets()) {
      const { tenant, session } = attachmentOf(ws);
      if (!shopSessionWorks(kv, tenant, session, now)) end(ws, FEED_CLOSE.sessionEnded, "session_ended");
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
