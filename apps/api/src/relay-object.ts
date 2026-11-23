import { DurableObject } from "cloudflare:workers";
import { base64UrlDecode } from "./auth";
import { RELAY_DIGEST, base64url, relayEnabled, verifyHostHello } from "./relay";

/// One Mac's relay, named `relay:<hostID>` (docs/relay-protocol-v1.md). It holds the Mac's socket
/// (its challenge and hello, its devices and its status) and up to eight phone sockets, and
/// forwards opaque binary frames between them without reading one. It also keeps the day's byte
/// budget and forgets the Mac once it has been gone long enough.
///
/// Sockets hibernate between messages, so everything a socket needs lives in its attachment and
/// never in a field of this instance. Storage keeps only what the threat model's section 6 lists:
/// `hostKey`, `devices`, `status`, `lastHostSeen` and `usage:<YYYY-MM-DD>`. The object logs
/// nothing, so no key, token, nonce, signature or frame can reach a log.

type Presence = "available" | "paused" | "sleeping" | "off";

/// What a socket carries across hibernation. `nonce`, `host` and `source` exist only until the
/// socket authenticates.
type Attachment = {
  role: "host" | "phone";
  authed: boolean;
  /// When a socket that has not authenticated is closed with 4401, in Unix milliseconds.
  deadline: number;
  /// The challenge this socket was sent. It is good for this socket alone.
  nonce?: string;
  /// The host id from the route, which the hello's key must hash to.
  host?: string;
  /// The Worker's digest of the upgrade's source group, never the address itself.
  source?: string;
  /// A phone's stream number, chosen at the upgrade so the socket carries its `stream:<n>` tag.
  stream?: number;
  /// A phone's device id, once its hello proves it.
  device?: string;
  /// A Mac socket closed because a newer one authenticated. Its phones were closed with it.
  replaced?: boolean;
  /// A phone the relay closed itself, after telling the Mac whatever the Mac needed to hear.
  ended?: boolean;
};

type Devices = Record<string, { tokenHash: string; pushToken?: string; pushEnv?: string }>;
type Status = { state: Presence; at: number };
type Usage = { day: string; stored: number; unflushed: number };

/// Close codes, under their Swift names in `RemoteRelayCloseCode`, plus the normal close.
const CLOSE = {
  normal: 1000,
  badRequest: 4400,
  unauthenticated: 4401,
  revoked: 4403,
  hostUnavailable: 4404,
  replaced: 4409,
  tooLarge: 4413,
  overBudget: 4429,
  disabled: 4503,
} as const;

/// Spec section 9. Provisional until the owner sets final values (D12, gate G9).
const MAX_DEVICES = 8;
const MAX_PHONES = 8;
const MAX_PENDING = 16;
const MAX_PENDING_PER_SOURCE = 4;
/// Every hop carries at most 65,536 bytes per message. The relay adds or strips a 4-byte stream
/// number, so a phone may send at most 65,532.
const MAX_MESSAGE_BYTES = 65_536;
const STREAM_HEADER_BYTES = 4;
const MAX_PAYLOAD_BYTES = MAX_MESSAGE_BYTES - STREAM_HEADER_BYTES;
/// The day's byte count is written at least this often (plan A4c), and at each alarm.
const USAGE_FLUSH_BYTES = 1 << 20;
/// How often the alarm sweeps while the object holds a socket or any storage: it notices the kill
/// switch, refreshes `lastHostSeen`, writes and prunes byte counts, and forgets an idle Mac.
const SWEEP_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/// A device id exactly as Swift writes a UUID: upper case, 8-4-4-4-12.
const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const PRESENCE: ReadonlySet<string> = new Set<Presence>(["available", "paused", "sleeping", "off"]);

type RelayEnv = { RELAY_ENABLED?: string };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/// The UTC date a byte count belongs to.
function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/// A message's size in bytes, or null when it is over `limit`. UTF-8 never takes fewer bytes than
/// UTF-16 code units, so an oversized text is refused without encoding it.
function sizeWithin(message: string | ArrayBuffer, limit: number): number | null {
  if (typeof message !== "string") return message.byteLength > limit ? null : message.byteLength;
  if (message.length > limit) return null;
  const bytes = new TextEncoder().encode(message).byteLength;
  return bytes > limit ? null : bytes;
}

function attachmentOf(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function readObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class RelayObject extends DurableObject {
  /// Static so tests can shorten them.
  static authTimeoutMs = 10_000;
  static dailyBudgetBytes = 1 << 30;
  static idleRetentionMs = 30 * DAY_MS;

  /// Today's byte count: what storage holds, and what arrived since it was written. It goes with
  /// the instance, so the count is approximate by design (section 9).
  private usage: Usage | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The runtime answers the text keepalive itself, so it never wakes the object (section 11).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get relayEnv(): RelayEnv {
    return this.env as unknown as RelayEnv;
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/host" || pathname === "/phone") return this.accept(request, pathname === "/host" ? "host" : "phone");
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Messages already on their way when the relay closed a socket (4400, 4401, 4409) are
    // dropped: a closed door changes nothing, not even the presence a replaced Mac last sent.
    if (ws.readyState !== WebSocket.OPEN) return;
    const attachment = attachmentOf(ws);
    // A relay that finds itself switched off while a socket is open closes it (section 9).
    if (!relayEnabled(this.relayEnv)) return this.end(ws, CLOSE.disabled, "disabled");
    // A message the relay could not forward within 65,536 bytes closes its socket before anything
    // reads or counts it (section 9).
    const size = sizeWithin(message, attachment.role === "host" ? MAX_MESSAGE_BYTES : MAX_PAYLOAD_BYTES);
    if (size === null) return this.end(ws, CLOSE.tooLarge, "too_large");
    if (attachment.authed) {
      // Only the Mac's and its phones' messages count against the day's budget, so a stranger who
      // knows the host id cannot spend it. A spent budget closes every stream and turns phones away
      // until the next UTC day, while the Mac's socket stays.
      if (await this.count(size)) {
        this.endPhones(CLOSE.overBudget, "over_budget");
        if (attachment.role === "phone") return;
      }
    } else if (attachment.role === "phone" && (await this.count(0))) {
      // Counting nothing reads whether today is spent: then a new phone's hello gets 4429 before
      // its token is read.
      return this.end(ws, CLOSE.overBudget, "over_budget");
    }
    // `ping` is answered without waking the object; a `pong` is skipped the same way.
    if (message === "pong") return;
    if (attachment.role === "phone") return this.fromPhone(ws, attachment, message);
    if (!attachment.authed) return this.hostHello(ws, attachment, message);
    if (typeof message === "string") return this.hostMessage(ws, message);
    this.hostFrame(ws, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = attachmentOf(ws);
    if (!attachment.authed) return;
    if (attachment.role === "phone") {
      // A phone that closed by itself: the Mac hears that its stream ended (section 6).
      if (!attachment.ended) this.tellHost({ t: "close", v: 1, stream: attachment.stream, reason: "closed" });
      return;
    }
    await this.ctx.storage.put("lastHostSeen", nowSeconds());
    // A replaced socket's phones went with it, and once another Mac socket is live the phones
    // that remain joined through that one.
    if (attachment.replaced || this.liveHost()) return;
    const told = await this.whyUnavailable();
    for (const phone of this.livePhones()) this.turnAway(phone, told, "unavailable", false);
  }

  /// Closes with 4401 every socket that did not authenticate in time, closes everything with 4503
  /// once the relay is switched off, notes that the relay saw the Mac while its socket is open,
  /// writes and prunes byte counts, and forgets a Mac gone longer than the retention window.
  override async alarm(): Promise<void> {
    const now = Date.now();
    const enabled = relayEnabled(this.relayEnv);
    let next: number | null = null;
    let hostOpen = false;
    const open = this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
    for (const ws of open) {
      const { role, authed, deadline } = attachmentOf(ws);
      if (!enabled) {
        // Hibernated sockets outlive a redeploy and a keepalive never wakes the object, so an idle
        // socket learns here that the relay is off.
        this.end(ws, CLOSE.disabled, "disabled", false);
      } else if (authed) {
        if (role === "host") hostOpen = true;
      } else if (deadline <= now) {
        ws.close(CLOSE.unauthenticated, "unauthenticated");
      } else {
        next = Math.min(next ?? deadline, deadline);
      }
    }
    if (hostOpen) await this.ctx.storage.put("lastHostSeen", Math.floor(now / 1000));
    await this.flushUsage();
    await this.pruneUsage(now);
    if (!hostOpen && (await this.forgotten(now))) {
      await this.ctx.storage.deleteAll();
      this.usage = null;
      return;
    }
    if (open.length > 0 || (await this.ctx.storage.list({ limit: 1 })).size > 0) {
      next = Math.min(next ?? now + SWEEP_MS, now + SWEEP_MS);
    }
    if (next !== null) await this.alarmBy(next);
  }

  /// Section 5 and 6: the Mac's socket gets a fresh nonce to sign. A phone speaks first, and its
  /// stream number is chosen now so its socket can carry the `stream:<n>` tag.
  private async accept(request: Request, role: "host" | "phone"): Promise<Response> {
    const source = request.headers.get("x-relay-source") ?? "";
    if (!this.admits(source)) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const deadline = Date.now() + RelayObject.authTimeoutMs;
    if (role === "host") {
      const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({
        role, authed: false, deadline, nonce, host: request.headers.get("x-relay-host-id") ?? "", source,
      } satisfies Attachment);
      server.send(JSON.stringify({ t: "challenge", v: 1, nonce }));
    } else {
      const stream = this.freeStream();
      this.ctx.acceptWebSocket(server, ["phone", `stream:${stream}`]);
      server.serializeAttachment({ role, authed: false, deadline, source, stream } satisfies Attachment);
    }
    await this.alarmBy(deadline);
    return new Response(null, { status: 101, webSocket: client });
  }

  /// Section 9: at most 16 sockets wait to authenticate, Mac and phone sockets together, and at
  /// most 4 of them from one source group, so one network cannot hold every door of a Mac.
  private admits(source: string): boolean {
    let pending = 0;
    let fromSource = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws);
      if (ws.readyState !== WebSocket.OPEN || attachment.authed) continue;
      pending++;
      if (attachment.source === source) fromSource++;
    }
    return pending < MAX_PENDING && fromSource < MAX_PENDING_PER_SOURCE;
  }

  /// A random 32-bit stream number that no socket of this object carries (section 7).
  private freeStream(): number {
    for (;;) {
      const [stream = 0] = crypto.getRandomValues(new Uint32Array(1));
      if (this.ctx.getWebSockets(`stream:${stream}`).length === 0) return stream;
    }
  }

  private async alarmBy(time: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > time) await this.ctx.storage.setAlarm(time);
  }

  /// The Mac's authenticated socket, if one is open.
  private liveHost(): WebSocket | undefined {
    return this.ctx.getWebSockets("host").find((ws) => ws.readyState === WebSocket.OPEN && attachmentOf(ws).authed);
  }

  /// Every phone that has a stream open.
  private livePhones(): WebSocket[] {
    return this.ctx.getWebSockets("phone").filter((ws) => ws.readyState === WebSocket.OPEN && attachmentOf(ws).authed);
  }

  private phoneOn(stream: number): WebSocket | undefined {
    return this.ctx.getWebSockets(`stream:${stream}`)
      .find((ws) => ws.readyState === WebSocket.OPEN && attachmentOf(ws).authed);
  }

  private tellHost(message: Record<string, unknown>): void {
    this.liveHost()?.send(JSON.stringify(message));
  }

  /// Closes a socket. A phone with a stream is reported to the Mac first, with the reason, unless
  /// the Mac asked for the close itself, and is marked so that its close is not reported twice.
  private end(ws: WebSocket, code: number, reason: string, tellHost = true): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const attachment = attachmentOf(ws);
    if (attachment.role === "phone") {
      ws.serializeAttachment({ ...attachment, ended: true } satisfies Attachment);
      if (tellHost && attachment.authed) this.tellHost({ t: "close", v: 1, stream: attachment.stream, reason });
    }
    ws.close(code, reason);
  }

  private endPhones(code: number, reason: string, tellHost = true): void {
    for (const phone of this.livePhones()) this.end(phone, code, reason, tellHost);
  }

  private endDevice(device: string, code: number, reason: string): void {
    for (const phone of this.livePhones()) if (attachmentOf(phone).device === device) this.end(phone, code, reason);
  }

  /// Section 8: a phone the Mac cannot take hears why, just before its socket closes with 4404.
  private turnAway(ws: WebSocket, told: Record<string, unknown>, reason: string, tellHost: boolean): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(told));
    this.end(ws, CLOSE.hostUnavailable, reason, tellHost);
  }

  /// The `host` message of section 8: a paused, sleeping or off Mac says so with the time of that
  /// status; otherwise the Mac is offline, with when the relay last saw it, if it ever has.
  private async whyUnavailable(): Promise<Record<string, unknown>> {
    const { status, lastHostSeen } = Object.fromEntries(await this.ctx.storage.get(["status", "lastHostSeen"])) as
      { status?: Status; lastHostSeen?: number };
    if (status !== undefined && status.state !== "available") return { t: "host", v: 1, state: status.state, at: status.at };
    return lastHostSeen === undefined
      ? { t: "host", v: 1, state: "offline" }
      : { t: "host", v: 1, state: "offline", at: lastHostSeen };
  }

  /// Adds a message to today's count and says whether the day's budget is spent. The count is
  /// written every 1 MiB, at each alarm, and as soon as the budget is spent, so that a refusal
  /// outlives the instance.
  private async count(bytes: number): Promise<boolean> {
    const day = utcDay(Date.now());
    let usage = this.usage;
    if (usage?.day !== day) {
      await this.flushUsage();
      usage = { day, stored: (await this.ctx.storage.get<number>(`usage:${day}`)) ?? 0, unflushed: 0 };
      this.usage = usage;
    }
    const wasSpent = usage.stored + usage.unflushed >= RelayObject.dailyBudgetBytes;
    usage.unflushed += bytes;
    const spent = usage.stored + usage.unflushed >= RelayObject.dailyBudgetBytes;
    if (usage.unflushed >= USAGE_FLUSH_BYTES || (spent && !wasSpent)) await this.flushUsage();
    return spent;
  }

  private async flushUsage(): Promise<void> {
    const usage = this.usage;
    if (usage === null || usage.unflushed === 0) return;
    usage.stored += usage.unflushed;
    usage.unflushed = 0;
    await this.ctx.storage.put(`usage:${usage.day}`, usage.stored);
  }

  /// Byte counts older than two days go: today's, yesterday's and the day before's stay.
  private async pruneUsage(now: number): Promise<void> {
    const stale = await this.ctx.storage.list({ prefix: "usage:", end: `usage:${utcDay(now - 2 * DAY_MS)}`, limit: 128 });
    if (stale.size > 0) await this.ctx.storage.delete([...stale.keys()]);
  }

  /// Section 9: the object forgets the Mac once the relay last saw it, at its hello, when its
  /// socket closed or at an alarm while it was open, longer ago than the retention window.
  private async forgotten(now: number): Promise<boolean> {
    const lastHostSeen = await this.ctx.storage.get<number>("lastHostSeen");
    return lastHostSeen !== undefined && now - lastHostSeen * 1000 > RelayObject.idleRetentionMs;
  }

  /// Until `ready`, the Mac may send only a valid `hello` (section 5). Anything else is 4401.
  private async hostHello(ws: WebSocket, pending: Attachment, message: string | ArrayBuffer): Promise<void> {
    const hello = typeof message === "string" ? readObject(message) : null;
    const key = hello?.t === "hello" && hello.v === 1 && typeof hello.key === "string" ? hello.key : null;
    const sig = typeof hello?.sig === "string" ? hello.sig : null;
    if (key === null || sig === null || Date.now() > pending.deadline ||
        !(await verifyHostHello(pending.host ?? "", pending.nonce ?? "", key, sig))) {
      return ws.close(CLOSE.unauthenticated, "unauthenticated");
    }
    // Checking the signature awaited, so the deadline may have closed this socket meanwhile, or an
    // earlier hello on it may have finished first.
    if (ws.readyState !== WebSocket.OPEN || attachmentOf(ws).authed) return;
    for (const other of this.ctx.getWebSockets("host")) {
      if (other === ws || other.readyState !== WebSocket.OPEN || !attachmentOf(other).authed) continue;
      other.serializeAttachment({ ...attachmentOf(other), replaced: true } satisfies Attachment);
      other.close(CLOSE.replaced, "replaced");
    }
    // Every phone streamed through an earlier Mac socket, which this one never heard of (section 5).
    this.endPhones(CLOSE.replaced, "replaced", false);
    ws.serializeAttachment({ role: "host", authed: true, deadline: pending.deadline } satisfies Attachment);
    await this.ctx.storage.put({ hostKey: key, lastHostSeen: nowSeconds() });
    const devices = (await this.ctx.storage.get<Devices>("devices")) ?? {};
    ws.send(JSON.stringify({ t: "ready", v: 1, devices: Object.keys(devices) }));
    await this.alarmBy(Date.now() + SWEEP_MS);
  }

  /// After `ready`, unknown types and versions are ignored, so a newer Mac can talk to an older
  /// relay, and a message the relay knows but cannot read closes the socket with 4400.
  private async hostMessage(ws: WebSocket, text: string): Promise<void> {
    const message = readObject(text);
    if (message?.v !== 1) return;
    switch (message.t) {
      case "device":
        return this.registerDevice(ws, message);
      case "revoke":
        return this.revokeDevice(ws, message);
      case "status":
        return this.recordStatus(ws, message);
      case "close":
        return this.closeStream(ws, message);
      default:
        // `push` and `pushToken` wait for push support (A7).
        return;
    }
  }

  /// A stream frame from the Mac: its payload goes to the phone on that stream, without the stream
  /// number. A frame for a stream that is not open is dropped (section 7).
  private hostFrame(ws: WebSocket, frame: ArrayBuffer): void {
    if (frame.byteLength < STREAM_HEADER_BYTES) return ws.close(CLOSE.badRequest, "bad_request");
    this.phoneOn(new DataView(frame).getUint32(0))?.send(frame.slice(STREAM_HEADER_BYTES));
  }

  /// The Mac ends one stream: that phone's socket closes with 1000, and nothing echoes back.
  private closeStream(ws: WebSocket, message: Record<string, unknown>): void {
    const { stream } = message;
    if (typeof stream !== "number" || !Number.isInteger(stream) || stream < 0 || stream > 0xffff_ffff) {
      return ws.close(CLOSE.badRequest, "bad_request");
    }
    const phone = this.phoneOn(stream);
    if (phone) this.end(phone, CLOSE.normal, "closed", false);
  }

  /// Registers a device or replaces its token hash. A ninth device is not registered, and a new
  /// hash closes the device's socket with 4403, since its old token no longer opens the door.
  private async registerDevice(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    const { id, tokenHash } = message;
    if (typeof id !== "string" || !DEVICE_ID.test(id) || typeof tokenHash !== "string" || !RELAY_DIGEST.test(tokenHash)) {
      return ws.close(CLOSE.badRequest, "bad_request");
    }
    const devices = (await this.ctx.storage.get<Devices>("devices")) ?? {};
    const known = devices[id];
    if (known?.tokenHash === tokenHash) return;
    if (!known && Object.keys(devices).length >= MAX_DEVICES) {
      ws.send(JSON.stringify({ t: "error", v: 1, code: "device_limit" }));
      return;
    }
    devices[id] = { ...known, tokenHash };
    await this.ctx.storage.put("devices", devices);
    if (known) this.endDevice(id, CLOSE.revoked, "revoked");
  }

  /// Forgets a device with its token hash and closes its socket with 4403. The relay keeps no
  /// record of revoked devices, and an unknown id is ignored.
  private async revokeDevice(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    const { id } = message;
    if (typeof id !== "string" || !DEVICE_ID.test(id)) return ws.close(CLOSE.badRequest, "bad_request");
    const devices = (await this.ctx.storage.get<Devices>("devices")) ?? {};
    if (!(id in devices)) return;
    delete devices[id];
    await this.ctx.storage.put("devices", devices);
    this.endDevice(id, CLOSE.revoked, "revoked");
  }

  /// Records the Mac's presence. The Mac never sends `offline`, the relay's word for no Mac socket.
  /// `at` is informational, so any whole number is read. `off` also turns every phone away.
  private async recordStatus(ws: WebSocket, message: Record<string, unknown>): Promise<void> {
    const { state, at } = message;
    if (typeof state !== "string" || !PRESENCE.has(state) || typeof at !== "number" || !Number.isSafeInteger(at)) {
      return ws.close(CLOSE.badRequest, "bad_request");
    }
    await this.ctx.storage.put("status", { state, at });
    if (state === "off") {
      for (const phone of this.livePhones()) this.turnAway(phone, { t: "host", v: 1, state, at }, "off", true);
    }
  }

  /// Section 6: a phone's first message is its hello, and anything else is 4401. Binary flows once
  /// it is through, and a text message after that, other than the keepalive, is 4400.
  private async fromPhone(ws: WebSocket, attachment: Attachment, message: string | ArrayBuffer): Promise<void> {
    if (!attachment.authed) return this.phoneHello(ws, attachment, message);
    if (typeof message === "string") return this.end(ws, CLOSE.badRequest, "closed");
    const host = this.liveHost();
    if (host === undefined || attachment.stream === undefined) return;
    const frame = new Uint8Array(STREAM_HEADER_BYTES + message.byteLength);
    new DataView(frame.buffer).setUint32(0, attachment.stream);
    frame.set(new Uint8Array(message), STREAM_HEADER_BYTES);
    host.send(frame);
  }

  /// A device the Mac registered, with the token whose hash it registered, gets its stream: the Mac
  /// hears `open`, then the phone `ready`. A refusal is 4401, and the Mac hears nothing (GS-41-AC04).
  private async phoneHello(ws: WebSocket, pending: Attachment, message: string | ArrayBuffer): Promise<void> {
    const hello = typeof message === "string" ? readObject(message) : null;
    const device = hello?.t === "hello" && hello.v === 1 && typeof hello.device === "string" &&
      DEVICE_ID.test(hello.device) ? hello.device : null;
    const token = typeof hello?.token === "string" ? hello.token : null;
    if (device === null || token === null || Date.now() > pending.deadline || !(await this.tokenOpens(device, token))) {
      return ws.close(CLOSE.unauthenticated, "unauthenticated");
    }
    const status = await this.ctx.storage.get<Status>("status");
    const told = await this.whyUnavailable();
    // The checks awaited, so the deadline may have closed this socket meanwhile.
    if (ws.readyState !== WebSocket.OPEN || attachmentOf(ws).authed || pending.stream === undefined) return;
    if (this.livePhones().filter((phone) => attachmentOf(phone).device !== device).length >= MAX_PHONES) {
      return ws.close(CLOSE.overBudget, "phone_limit");
    }
    const host = this.liveHost();
    if (host === undefined || (status !== undefined && status.state !== "available")) {
      return this.turnAway(ws, told, "unavailable", false);
    }
    // One socket per device: the older one closes, and the Mac hears so before the new stream opens.
    this.endDevice(device, CLOSE.replaced, "replaced");
    ws.serializeAttachment({
      role: "phone", authed: true, deadline: pending.deadline, stream: pending.stream, device,
    } satisfies Attachment);
    host.send(JSON.stringify({ t: "open", v: 1, stream: pending.stream, device }));
    ws.send(JSON.stringify({ t: "ready", v: 1 }));
  }

  /// Whether the SHA-256 of the 32 token bytes, not of their text, is the hash the Mac registered
  /// for this device, compared in constant time (section 6).
  private async tokenOpens(device: string, token: string): Promise<boolean> {
    const registered = (await this.ctx.storage.get<Devices>("devices"))?.[device]?.tokenHash;
    if (registered === undefined) return false;
    try {
      const bytes = base64UrlDecode(token);
      const expected = base64UrlDecode(registered);
      if (bytes.byteLength !== 32 || expected.byteLength !== 32) return false;
      return crypto.subtle.timingSafeEqual(await crypto.subtle.digest("SHA-256", bytes), expected);
    } catch {
      return false;
    }
  }
}
