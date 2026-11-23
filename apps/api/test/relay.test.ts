import {
  createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { relayRoute, verifyHostHello } from "../src/relay";
import { RelayObject } from "../src/relay-object";
import vectors from "./fixtures/relay-v1-vectors.json";
import { sourceWorker } from "./source-worker";

/// Relay protocol v1 (docs/relay-protocol-v1.md), the Worker's half for the Mac: the routes, the
/// kill switch, the upgrade gates and the host socket (A4b). Phone sockets arrive in A4c.
/// Every key, token, nonce and signature here is test-only: the shared vectors' own, or a P-256
/// key generated for one test so that the test gets a relay object of its own.

const bindings = env as unknown as Env;
const HOST = vectors.hostKey.hostID;
const CLOSE = vectors.closeCodes;
const ANSWERS = new Map(vectors.httpErrors.map((answer) => [answer.body.error, answer]));
const encoder = new TextEncoder();

type Message = Record<string, unknown>;
type Outgoing = Message | string | Uint8Array;
type Received = Message | string | ArrayBuffer;
type Closed = { code: number; reason: string };
type Socket = { ws: WebSocket; next(): Promise<Received>; send(value: Outgoing): void; closed: Promise<Closed> };
type HostKey = { hostID: string; key: string; sign(message: string): Promise<string> };
type Stored = {
  hostKey?: string;
  devices?: Record<string, { tokenHash: string }>;
  status?: { state: string; at: number };
  lastHostSeen?: number;
};

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/// A documentation-only IPv6 /64 of its own, as its first four groups.
function randomGroup(): string {
  const [first = 0, second = 0] = crypto.getRandomValues(new Uint16Array(2));
  return `2001:db8:${first.toString(16)}:${second.toString(16)}`;
}

function deviceID(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).toUpperCase().padStart(12, "0")}`;
}

/// The string a Mac signs, built from the vectors' own example, so the Worker and the Swift side
/// cannot drift apart on its format.
function challengeMessage(hostID: string, nonce: string): string {
  return vectors.hostChallenge.message
    .replace(vectors.hostKey.hostID, hostID)
    .replace(vectors.hostChallenge.nonce, nonce);
}

function signer(privateKey: CryptoKey): (message: string) => Promise<string> {
  return async (message) =>
    base64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(message)));
}

async function vectorHost(): Promise<HostKey> {
  const privateKey = await crypto.subtle.importKey("jwk", vectors.hostKey.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { hostID: HOST, key: vectors.hostKey.publicKeyX963, sign: signer(privateKey) };
}

async function freshHost(): Promise<HostKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true,
    ["sign", "verify"])) as CryptoKeyPair;
  const x963 = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { hostID: base64url(await crypto.subtle.digest("SHA-256", x963)), key: base64url(x963), sign: signer(pair.privateKey) };
}

function parse(text: string): Message | string {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Message) : text;
  } catch {
    return text;
  }
}

/// Accepts the client end of a socket, queueing what arrives so no message is missed between awaits.
function wire(ws: WebSocket): Socket {
  const queue: Received[] = [];
  const waiting: ((value: Received) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const value = typeof event.data === "string" ? parse(event.data) : (event.data as ArrayBuffer);
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  const closed = new Promise<Closed>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
  // The runtime's default is Blob, whose bytes arrive only after an await that could reorder them.
  ws.binaryType = "arraybuffer";
  ws.accept();
  return {
    ws,
    closed,
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiting.push(resolve))),
    send: (value) => ws.send(typeof value === "string" || value instanceof Uint8Array ? value : JSON.stringify(value)),
  };
}

/// Opens a relay route through the Worker as the edge would deliver it: from `ip` when given,
/// otherwise from a fresh documentation-only /64, so unrelated tests never share a gate.
function upgrade(hostID: string, role: "socket" | "phone" = "socket", ip?: string): Promise<Response> {
  const url = `https://relay.test/relay/v1/hosts/${hostID}/${role}`;
  if (ip === undefined) return sourceWorker.fetch(url, { headers: { upgrade: "websocket" } });
  return SELF.fetch(url, { headers: { upgrade: "websocket", "cf-connecting-ip": ip } });
}

async function openHost(hostID: string, ip?: string): Promise<Socket> {
  const response = await upgrade(hostID, "socket", ip);
  expect(response.status).toBe(101);
  return wire(response.webSocket!);
}

async function challengeOf(socket: Socket): Promise<string> {
  const challenge = (await socket.next()) as Message;
  expect(challenge).toEqual({ t: "challenge", v: 1, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  return challenge.nonce as string;
}

async function hello(host: HostKey, nonce: string): Promise<Message> {
  return { t: "hello", v: 1, key: host.key, sig: await host.sign(challengeMessage(host.hostID, nonce)) };
}

async function authenticate(socket: Socket, host: HostKey): Promise<Received> {
  socket.send(await hello(host, await challengeOf(socket)));
  return socket.next();
}

function relayStub(hostID: string): DurableObjectStub {
  return bindings.RELAY.get(bindings.RELAY.idFromName(`relay:${hostID}`));
}

function stored(hostID: string): Promise<Stored> {
  return runInDurableObject(relayStub(hostID), async (_instance, state) =>
    Object.fromEntries(await state.storage.get(["hostKey", "devices", "status", "lastHostSeen"])) as Stored);
}

async function expectAnswer(response: Response, error: string): Promise<void> {
  const answer = ANSWERS.get(error)!;
  expect(response.status).toBe(answer.status);
  expect(await response.json()).toEqual(answer.body);
  if ("retryAfter" in answer) expect(response.headers.get("retry-after")).toBe(answer.retryAfter);
}

type Device = { device: string; token: string; tokenHash: string };

/// The vectors' device: the phone's `hello` example carries the token whose hash the `device`
/// example registers, so a phone that gets in proves the Worker hashes the token as Swift does.
const VECTOR_DEVICE: Device = vectors.deviceToken;

/// A test-only device with a fresh 32-byte token.
async function newDevice(index: number): Promise<Device> {
  const token = crypto.getRandomValues(new Uint8Array(32));
  return { device: deviceID(index), token: base64url(token), tokenHash: base64url(await crypto.subtle.digest("SHA-256", token)) };
}

function phoneHello(device: Device): Message {
  return { t: "hello", v: 1, device: device.device, token: device.token };
}

async function openPhone(hostID: string, ip?: string): Promise<Socket> {
  const response = await upgrade(hostID, "phone", ip);
  expect(response.status).toBe(101);
  return wire(response.webSocket!);
}

/// An authenticated Mac socket whose devices the relay has stored.
async function hostWithDevices(host: HostKey, devices: Device[] = [VECTOR_DEVICE]): Promise<Socket> {
  const mac = await openHost(host.hostID);
  await authenticate(mac, host);
  for (const { device, tokenHash } of devices) mac.send({ t: "device", v: 1, id: device, tokenHash });
  await vi.waitFor(async () =>
    expect(Object.keys((await stored(host.hostID)).devices ?? {})).toEqual(devices.map(({ device }) => device)));
  return mac;
}

/// A phone through to its Mac: the phone gets `ready`, and the Mac `open` for its stream.
async function connectPhone(mac: Socket, hostID: string, device: Device = VECTOR_DEVICE) {
  const phone = await openPhone(hostID);
  phone.send(phoneHello(device));
  expect(await phone.next()).toEqual({ t: "ready", v: 1 });
  const open = (await mac.next()) as Message;
  expect(open).toEqual({ t: "open", v: 1, stream: expect.any(Number), device: device.device });
  return { phone, stream: open.stream as number };
}

/// A stream frame built here, independently of the relay: 4 big-endian bytes, then the payload.
function frame(stream: number, payload: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(4 + payload.length);
  new DataView(bytes.buffer).setUint32(0, stream);
  bytes.set(payload, 4);
  return bytes;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function socketCount(hostID: string): Promise<number> {
  return runInDurableObject(relayStub(hostID), (_instance, state) => state.getWebSockets().length);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// A UTC date as the relay names its byte counts: `usage:<YYYY-MM-DD>`.
function utcDay(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/// Turns the kill switch off for one object, as a redeploy without RELAY_ENABLED would.
function switchOff(hostID: string): Promise<void> {
  return runInDurableObject(relayStub(hostID), (instance) => {
    const object = instance as unknown as { env: Record<string, unknown> };
    object.env = { ...object.env, RELAY_ENABLED: "0" };
  });
}

type Forwarded = { object: string; url: string; headers: Headers };

/// The Worker with recording limiters and a recording RELAY namespace, for route tests that must
/// show what reaches the object, and that nothing does.
function routeFixture(allow = true) {
  const keys: [string, string][] = [];
  const forwarded: Forwarded[] = [];
  const limiter = (binding: string) => ({
    limit: async ({ key }: { key: string }) => {
      keys.push([binding, key]);
      return { success: allow };
    },
  }) as RateLimit;
  const relay = {
    idFromName: (name: string) => name,
    get: (object: string) => ({
      fetch: async (request: Request) => {
        forwarded.push({ object, url: request.url, headers: request.headers });
        return Response.json({ fixture: true });
      },
    }),
  };
  const target: Env = {
    ...bindings,
    RELAY_ENABLED: "1",
    RELAY: relay as unknown as DurableObjectNamespace,
    RELAY_HOST_LIMITER: limiter("RELAY_HOST_LIMITER"),
    RELAY_PHONE_LIMITER: limiter("RELAY_PHONE_LIMITER"),
  };
  return { target, keys, forwarded };
}

type SendOptions = { method?: string; ip?: string | null; upgrade?: boolean; headers?: Record<string, string> };

async function send(target: Env, path: string, options: SendOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.upgrade !== false) headers.set("upgrade", "websocket");
  if (options.ip !== null) headers.set("cf-connecting-ip", options.ip ?? "192.0.2.41");
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://relay.test${path}`,
    { method: options.method ?? "GET", headers }), target, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("relay routes", () => {
  it("refuses relay routes unless RELAY_ENABLED is 1", async () => {
    for (const value of [undefined, "", "0", "true", "1 "]) {
      const fixture = routeFixture();
      if (value === undefined) delete fixture.target.RELAY_ENABLED;
      else fixture.target.RELAY_ENABLED = value;
      for (const path of [`/relay/v1/hosts/${HOST}/socket`, `/relay/v1/hosts/${HOST}/phone`, "/relay/v1/elsewhere"]) {
        await expectAnswer(await send(fixture.target, path), "relay_disabled");
      }
      expect(fixture.forwarded).toEqual([]);
    }
  });

  it("rejects a malformed host id with 400", async () => {
    const fixture = routeFixture();
    // Too short, too long, outside base64url, the right length with a percent-escape, and empty.
    for (const id of [HOST.slice(1), `${HOST}A`, `${HOST.slice(1)}+`, `${HOST.slice(1)}.`, `${HOST.slice(3)}%2F`, ""]) {
      await expectAnswer(await send(fixture.target, `/relay/v1/hosts/${id}/socket`), "invalid_host_id");
    }
    expect(fixture.forwarded).toEqual([]);
  });

  it("requires a WebSocket upgrade (426)", async () => {
    const fixture = routeFixture();
    const path = `/relay/v1/hosts/${HOST}/socket`;
    await expectAnswer(await send(fixture.target, path, { upgrade: false }), "upgrade_required");
    await expectAnswer(await send(fixture.target, path, { method: "POST" }), "upgrade_required");
    await expectAnswer(await send(fixture.target, path, { upgrade: false, headers: { upgrade: "h2c" } }),
      "upgrade_required");
    expect(fixture.forwarded).toEqual([]);
  });

  it("answers 404 for any other path under /relay/", async () => {
    const fixture = routeFixture();
    for (const path of ["/relay/", `/relay/v2/hosts/${HOST}/socket`, `/relay/v1/hosts/${HOST}/mac`,
      `/relay/v1/hosts/${HOST}/socket/extra`, `/relay/v1/host/${HOST}/phone`]) {
      await expectAnswer(await send(fixture.target, path), "not_found");
    }
    expect(fixture.forwarded).toEqual([]);
  });

  it("forwards an upgrade to the host's own object with a digest of its source group, and nothing else", async () => {
    const fixture = routeFixture();
    const other = (await freshHost()).hostID;
    const answers = [
      await send(fixture.target, `/relay/v1/hosts/${HOST}/socket`, { ip: "2001:db8:51:1::1",
        headers: { authorization: "Bearer fixture-token", "x-forwarded-for": "203.0.113.9" } }),
      await send(fixture.target, `/relay/v1/hosts/${HOST}/phone`, { ip: "2001:db8:51:1:ffff::2" }),
      await send(fixture.target, `/relay/v1/hosts/${HOST}/socket`, { ip: "2001:db8:51:2::1" }),
      await send(fixture.target, `/relay/v1/hosts/${other}/socket`, { ip: "2001:db8:51:1::1" }),
    ];
    for (const answer of answers) expect(await answer.json()).toEqual({ fixture: true });
    expect(fixture.forwarded.map(({ object, url }) => [object, url])).toEqual([
      [`relay:${HOST}`, "https://relay/host"],
      [`relay:${HOST}`, "https://relay/phone"],
      [`relay:${HOST}`, "https://relay/host"],
      [`relay:${other}`, "https://relay/host"],
    ]);
    const [first, sameGroup, otherGroup, otherHost] = fixture.forwarded.map(({ headers }) => headers);
    expect([...first!.keys()].sort()).toEqual(["upgrade", "x-relay-host-id", "x-relay-source"]);
    expect(first!.get("upgrade")).toBe("websocket");
    expect(first!.get("x-relay-host-id")).toBe(HOST);
    // One /64 is one source group. The object is handed a digest of it, never the address, and the
    // digest differs between Macs, so one address cannot be followed from object to object.
    const source = first!.get("x-relay-source");
    expect(source).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sameGroup!.get("x-relay-source")).toBe(source);
    expect(otherGroup!.get("x-relay-source")).not.toBe(source);
    expect(otherHost!.get("x-relay-source")).not.toBe(source);
  });

  it("the relay limiters key IPv6 by its /64 prefix", async () => {
    const fixture = routeFixture();
    const sources = [
      ["socket", "2001:db8:aa:bb::1"],
      ["socket", "2001:DB8:AA:BB:FFFF:FFFF:FFFF:FFFF"],
      ["phone", "2001:db8:aa:cc:0:0:0:1"],
      ["phone", "2001:0db8:00aa:00cc::"],
      ["socket", "198.51.100.7"],
      ["phone", "::ffff:198.51.100.7"],
    ] as const;
    for (const [role, ip] of sources) await send(fixture.target, `/relay/v1/hosts/${HOST}/${role}`, { ip });
    expect(fixture.keys).toEqual([
      ["RELAY_HOST_LIMITER", "2001:db8:aa:bb::/64"],
      ["RELAY_HOST_LIMITER", "2001:db8:aa:bb::/64"],
      ["RELAY_PHONE_LIMITER", "2001:db8:aa:cc::/64"],
      ["RELAY_PHONE_LIMITER", "2001:db8:aa:cc::/64"],
      ["RELAY_HOST_LIMITER", "198.51.100.7"],
      ["RELAY_PHONE_LIMITER", "198.51.100.7"],
    ]);
  });

  it("fails closed without a limiter or a readable source address", async () => {
    const path = `/relay/v1/hosts/${HOST}/socket`;
    for (const ip of [null, "", "not-an-address", "198.51.100.256", "fe80::1%en0", "2001:db8::1::2"]) {
      const fixture = routeFixture();
      const response = await send(fixture.target, path, { ip });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "rate_limit_unavailable" });
      expect(fixture.keys).toEqual([]);
      expect(fixture.forwarded).toEqual([]);
    }
    for (const [role, binding] of [["socket", "RELAY_HOST_LIMITER"], ["phone", "RELAY_PHONE_LIMITER"]] as const) {
      const fixture = routeFixture();
      delete fixture.target[binding];
      const response = await send(fixture.target, `/relay/v1/hosts/${HOST}/${role}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "rate_limit_unavailable" });
      expect(fixture.forwarded).toEqual([]);
    }
    // The route itself opens nothing without a source group, even if it ever ran without the gate.
    const fixture = routeFixture();
    const url = new URL(`https://relay.test/relay/v1/hosts/${HOST}/socket`);
    const ungated = await relayRoute(new Request(url, { headers: { upgrade: "websocket" } }), url, fixture.target);
    expect(ungated?.status).toBe(503);
    expect(fixture.forwarded).toEqual([]);
  });

  it("a denied upgrade gets 429", async () => {
    const fixture = routeFixture(false);
    // The gate runs before the kill switch, so a spent gate answers even while the relay is off.
    delete fixture.target.RELAY_ENABLED;
    for (const role of ["socket", "phone"]) {
      await expectAnswer(await send(fixture.target, `/relay/v1/hosts/${HOST}/${role}`), "rate_limited");
    }
    expect(fixture.keys.map(([binding]) => binding)).toEqual(["RELAY_HOST_LIMITER", "RELAY_PHONE_LIMITER"]);
    expect(fixture.forwarded).toEqual([]);
  });

  it.each([["socket", 10], ["phone", 60]] as const)(
    "the real workerd limiter for %s upgrades allows %i a minute from one /64", async (role, limit) => {
      const path = `/relay/v1/hosts/${HOST}/${role}`;
      // The real limiter counts in windows of its period, so a run that crosses into the next window starts
      // counting again and lets one more through. A run whose last request is let through is therefore run once
      // more from a fresh /64; two runs a second or so long cannot both cross a 60-second boundary.
      for (let attempt = 1; ; attempt++) {
        const group = randomGroup();
        // Every address differs inside one /64. None asks to upgrade, so no socket opens.
        for (let index = 1; index <= limit; index++) {
          expect((await send(bindings, path, { ip: `${group}::${index.toString(16)}`, upgrade: false })).status).toBe(426);
        }
        const last = await send(bindings, path, { ip: `${group}::ffff`, upgrade: false });
        if (last.status === 426 && attempt === 1) {
          await last.arrayBuffer();
          continue;
        }
        await expectAnswer(last, "rate_limited");
        break;
      }
      expect((await send(bindings, path, { ip: `${randomGroup()}::1`, upgrade: false })).status).toBe(426);
    });
});

describe("relay host socket", () => {
  it("verifies the vectors' hello, and nothing that differs from it", async () => {
    const { hostID, publicKeyX963: key } = vectors.hostKey;
    const { nonce, signature } = vectors.hostChallenge;
    expect(await verifyHostHello(hostID, nonce, key, signature)).toBe(true);
    expect(await verifyHostHello(hostID, nonce, key, `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`))
      .toBe(false);
    expect(await verifyHostHello(hostID, `${nonce.startsWith("A") ? "B" : "A"}${nonce.slice(1)}`, key, signature))
      .toBe(false);
    expect(await verifyHostHello((await freshHost()).hostID, nonce, key, signature)).toBe(false);
    expect(await verifyHostHello(hostID, nonce, `${key}A`, signature)).toBe(false);
    expect(await verifyHostHello(hostID, nonce, key, "")).toBe(false);
  });

  it("sends a challenge, then ready after a valid hello", async () => {
    const socket = await openHost(HOST);
    expect(await authenticate(socket, await vectorHost())).toEqual({ t: "ready", v: 1, devices: [] });
    socket.ws.close(1000);
  });

  // Covers: GS-41-AC04
  it("refuses a hello whose key does not hash to the host id (4401)", async () => {
    const impostor = await freshHost();
    const socket = await openHost(HOST);
    const nonce = await challengeOf(socket);
    // A valid signature by another key, over this Mac's own string, still does not open its door.
    socket.send({ t: "hello", v: 1, key: impostor.key, sig: await impostor.sign(challengeMessage(HOST, nonce)) });
    expect((await socket.closed).code).toBe(CLOSE.unauthenticated);
  });

  it("refuses a bad signature (4401)", async () => {
    const host = await vectorHost();
    const other = (await freshHost()).hostID;
    const signatures = [
      (nonce: string) => host.sign(challengeMessage(HOST, `${nonce.startsWith("A") ? "B" : "A"}${nonce.slice(1)}`)),
      (nonce: string) => host.sign(challengeMessage(other, nonce)),
      async () => "",
      async () => "not base64url",
    ];
    for (const sign of signatures) {
      const socket = await openHost(HOST);
      const nonce = await challengeOf(socket);
      socket.send({ t: "hello", v: 1, key: host.key, sig: await sign(nonce) });
      expect((await socket.closed).code).toBe(CLOSE.unauthenticated);
    }
  });

  // Covers: GS-42-AC02
  it("a hello replayed on a new connection is refused", async () => {
    const host = await vectorHost();
    const first = await openHost(HOST);
    const recorded = await hello(host, await challengeOf(first));
    first.send(recorded);
    expect(await first.next()).toEqual({ t: "ready", v: 1, devices: [] });
    // Each socket has its own nonce, so neither that hello nor the vectors' recorded one opens another.
    for (const replayed of [recorded, vectors.messages.hostOutbound[0]!]) {
      const socket = await openHost(HOST);
      await challengeOf(socket);
      socket.send(replayed);
      expect((await socket.closed).code).toBe(CLOSE.unauthenticated);
    }
    first.ws.close(1000);
  });

  it("closes an unauthenticated socket after the timeout", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const original = RelayObject.authTimeoutMs;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let authed: Socket;
    try {
      // This socket authenticates in time, then outlives its own deadline while alarms run.
      RelayObject.authTimeoutMs = 300;
      authed = await openHost(host.hostID);
      expect(await authenticate(authed, host)).toEqual({ t: "ready", v: 1, devices: [] });
      await pause(400);
      await runDurableObjectAlarm(stub);
      RelayObject.authTimeoutMs = 20;
      const pending = await openHost(host.hostID);
      await challengeOf(pending);
      await pause(40);
      // The alarm may already have run by itself: either way this socket is past its deadline.
      await runDurableObjectAlarm(stub);
      expect((await pending.closed).code).toBe(CLOSE.unauthenticated);
    } finally {
      RelayObject.authTimeoutMs = original;
    }
    // A socket that authenticated in time is never timed out.
    authed.send({ t: "status", v: 1, state: "available", at: 1 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "available", at: 1 }));
    expect(authed.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("the alarm runs at the earliest pending deadline, then at the next", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const alarmTime = () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    const original = RelayObject.authTimeoutMs;
    let early: Socket;
    let late: Socket;
    try {
      late = await openHost(host.hostID);
      await challengeOf(late);
      RelayObject.authTimeoutMs = 300;
      early = await openHost(host.hostID);
      await challengeOf(early);
      RelayObject.authTimeoutMs = original;
      await challengeOf(await openHost(host.hostID));
    } finally {
      RelayObject.authTimeoutMs = original;
    }
    const deadlines = await runInDurableObject(stub, (_instance, state) => state.getWebSockets()
      .map((ws) => (ws.deserializeAttachment() as { deadline: number }).deadline)
      .sort((a, b) => a - b));
    // A sooner deadline moves the alarm earlier, and a later one never moves it back.
    expect(await alarmTime()).toBe(deadlines[0]);
    expect((await early.closed).code).toBe(CLOSE.unauthenticated);
    // With that socket gone, the alarm waits for the next deadline instead of none.
    await vi.waitFor(async () => expect(await alarmTime()).toBe(deadlines[1]));
    expect(late.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("only an authenticated Mac moves lastHostSeen", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    // A socket that never proves itself is not the Mac: neither an alarm nor its close counts.
    const pending = await openHost(host.hostID);
    await challengeOf(pending);
    await runDurableObjectAlarm(stub);
    pending.ws.close(1000);
    await vi.waitFor(async () =>
      expect(await runInDurableObject(stub, (_instance, state) => state.getWebSockets().length)).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await stored(host.hostID)).lastHostSeen).toBeUndefined();
  });

  it("a second authenticated host replaces the first with 4409", async () => {
    const host = await freshHost();
    const first = await openHost(host.hostID);
    await authenticate(first, host);
    const second = await openHost(host.hostID);
    const nonce = await challengeOf(second);
    // A socket that has not authenticated replaces nothing.
    first.send({ t: "status", v: 1, state: "available", at: 1 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "available", at: 1 }));
    second.send(await hello(host, nonce));
    expect(await second.next()).toEqual({ t: "ready", v: 1, devices: [] });
    expect((await first.closed).code).toBe(CLOSE.replaced);
    second.send({ t: "status", v: 1, state: "paused", at: 2 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "paused", at: 2 }));
  });

  it("caps registered devices at 8 with error device_limit", async () => {
    const host = await freshHost();
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    const ids = Array.from({ length: 9 }, (_, index) => deviceID(index));
    const { tokenHash } = vectors.deviceToken;
    const replacement = base64url(await crypto.subtle.digest("SHA-256", encoder.encode("another test-only token")));
    for (const id of ids) socket.send({ t: "device", v: 1, id, tokenHash });
    expect(await socket.next()).toEqual(vectors.messages.hostInbound[4]);
    expect(Object.keys((await stored(host.hostID)).devices ?? {})).toEqual(ids.slice(0, 8));
    // At the cap a registered device can still change its hash, and a revoke frees a place.
    socket.send({ t: "device", v: 1, id: ids[0], tokenHash: replacement });
    socket.send({ t: "revoke", v: 1, id: ids[1] });
    socket.send({ t: "device", v: 1, id: ids[8], tokenHash });
    const registered = [ids[0]!, ...ids.slice(2, 9)];
    await vi.waitFor(async () => expect(Object.keys((await stored(host.hostID)).devices ?? {})).toEqual(registered));
    expect((await stored(host.hostID)).devices?.[ids[0]!]).toEqual({ tokenHash: replacement });
    // The next hello is told the registered ids, never their hashes.
    expect(await authenticate(await openHost(host.hostID), host)).toEqual({ t: "ready", v: 1, devices: registered });
  });

  it("device registers or replaces a token hash; revoke deletes the device and ignores an unknown id", async () => {
    const host = await freshHost();
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    const { device, tokenHash } = vectors.deviceToken;
    const replacement = base64url(await crypto.subtle.digest("SHA-256", encoder.encode("another test-only token")));
    const devices = async () => (await stored(host.hostID)).devices;
    socket.send(vectors.messages.hostOutbound[1]!);
    await vi.waitFor(async () => expect(await devices()).toEqual({ [device]: { tokenHash } }));
    socket.send({ t: "device", v: 1, id: device, tokenHash: replacement });
    await vi.waitFor(async () => expect(await devices()).toEqual({ [device]: { tokenHash: replacement } }));
    socket.send({ t: "revoke", v: 1, id: deviceID(0) });
    socket.send(vectors.messages.hostOutbound[2]!);
    await vi.waitFor(async () => expect(await devices()).toEqual({}));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("stores status and lastHostSeen", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const before = Math.floor(Date.now() / 1000);
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    const seen = await stored(host.hostID);
    expect(seen.hostKey).toBe(host.key);
    expect(seen.lastHostSeen).toBeGreaterThanOrEqual(before);
    expect(seen.lastHostSeen).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    socket.send(vectors.messages.hostOutbound[3]!);
    await vi.waitFor(async () =>
      expect((await stored(host.hostID)).status).toEqual({ state: "paused", at: 1789000000 }));
    // The relay last saw the Mac at its hello, at each alarm while its socket is open, and when it closed.
    const forget = () => runInDurableObject(stub, (_instance, state) => state.storage.put("lastHostSeen", 1));
    await forget();
    const pending = await openHost(host.hostID);
    await challengeOf(pending);
    await runDurableObjectAlarm(stub);
    expect((await stored(host.hostID)).lastHostSeen).toBeGreaterThanOrEqual(before);
    await forget();
    socket.ws.close(1000);
    await vi.waitFor(async () => expect((await stored(host.hostID)).lastHostSeen).toBeGreaterThanOrEqual(before));
  });

  it("a fifth unauthenticated socket from one source group is refused; an object holds at most sixteen", async () => {
    const host = await freshHost();
    const group = randomGroup();
    const sockets: Socket[] = [];
    for (let index = 1; index <= 4; index++) sockets.push(await openHost(host.hostID, `${group}::${index}`));
    // Another address in the same /64 is the same source group.
    await expectAnswer(await upgrade(host.hostID, "socket", `${group}::5`), "rate_limited");
    for (let others = 0; others < 3; others++) {
      const next = randomGroup();
      for (let index = 1; index <= 4; index++) sockets.push(await openHost(host.hostID, `${next}::${index}`));
    }
    expect(sockets).toHaveLength(16);
    await expectAnswer(await upgrade(host.hostID, "socket", `${randomGroup()}::1`), "rate_limited");
    // Only unauthenticated sockets count: once one proves itself, its group may open another.
    expect(await authenticate(sockets[0]!, host)).toEqual({ t: "ready", v: 1, devices: [] });
    const reopened = await upgrade(host.hostID, "socket", `${group}::6`);
    expect(reopened.status).toBe(101);
    reopened.webSocket!.accept();
  });

  it("until ready the Mac may send only hello, besides keepalives", async () => {
    const host = await freshHost();
    const firsts: ((nonce: string) => Promise<Outgoing>)[] = [
      async () => ({ t: "status", v: 1, state: "available", at: 1 }),
      async () => new Uint8Array([0, 0, 0, 1, 9]),
      async () => "not json",
      async (nonce) => ({ ...(await hello(host, nonce)), v: 2 }),
      async (nonce) => {
        const { sig: _sig, ...unsigned } = await hello(host, nonce);
        return unsigned;
      },
    ];
    for (const first of firsts) {
      const socket = await openHost(host.hostID);
      socket.send(await first(await challengeOf(socket)));
      expect((await socket.closed).code).toBe(CLOSE.unauthenticated);
    }
    // ping and pong are keepalives, never a first message.
    const socket = await openHost(host.hostID);
    const nonce = await challengeOf(socket);
    socket.send("ping");
    expect(await socket.next()).toBe("pong");
    socket.send("pong");
    socket.send(await hello(host, nonce));
    expect(await socket.next()).toEqual({ t: "ready", v: 1, devices: [] });
  });

  it("after ready it ignores what it does not know, and closes with 4400 on what it cannot read", async () => {
    const host = await freshHost();
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    const ignored: Outgoing[] = [
      { t: "later", v: 1 },
      { t: "status", v: 2, state: "offline" },
      { t: "status", state: "offline", at: 1 },
      "not json",
      "[1,2]",
      "pong",
      // A close for a stream that is not open, then push and pushToken, which wait for A7.
      vectors.messages.hostOutbound[4]!,
      vectors.messages.hostOutbound[5]!,
      vectors.messages.hostOutbound[6]!,
      vectors.messages.hostOutbound[7]!,
      // A stream frame for a stream that is not open is dropped.
      new Uint8Array([0, 0, 0, 1, 9]),
    ];
    for (const message of ignored) socket.send(message);
    socket.send({ t: "status", v: 1, state: "sleeping", at: 5 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "sleeping", at: 5 }));
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);

    const { device, tokenHash } = vectors.deviceToken;
    const unreadable: Outgoing[] = [
      { t: "status", v: 1, state: "offline", at: 1 },
      { t: "status", v: 1, state: "paused" },
      { t: "status", v: 1, state: "paused", at: 1.5 },
      { t: "status", v: 1, state: "paused", at: "1789000000" },
      { t: "device", v: 1, id: device.toLowerCase(), tokenHash },
      { t: "device", v: 1, id: device, tokenHash: tokenHash.slice(1) },
      { t: "device", v: 1, tokenHash },
      { t: "revoke", v: 1, id: "not-a-device" },
      { t: "close", v: 1 },
      { t: "close", v: 1, stream: -1 },
      { t: "close", v: 1, stream: 4294967296 },
      { t: "close", v: 1, stream: 1.5 },
      // A stream frame shorter than its 4-byte stream number.
      new Uint8Array([0, 0, 1]),
    ];
    for (const message of unreadable) {
      const next = await openHost(host.hostID);
      await authenticate(next, host);
      next.send(message);
      expect((await next.closed).code).toBe(CLOSE.badRequest);
    }
    const after = await stored(host.hostID);
    expect(after.status).toEqual({ state: "sleeping", at: 5 });
    expect(after.devices ?? {}).toEqual({});
  });

  it("acts on nothing that arrives after the relay closed the socket", async () => {
    const host = await freshHost();
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    const { device, tokenHash } = vectors.deviceToken;
    // Sent together, so the last two are already on their way when the first closes the socket.
    socket.send({ t: "device", v: 1, id: device.toLowerCase(), tokenHash });
    socket.send({ t: "device", v: 1, id: device, tokenHash });
    socket.send({ t: "status", v: 1, state: "available", at: 9 });
    expect((await socket.closed).code).toBe(CLOSE.badRequest);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await stored(host.hostID);
    expect(after.devices).toBeUndefined();
    expect(after.status).toBeUndefined();
  });

  it("closes an open socket with 4503 once the relay is switched off", async () => {
    const host = await freshHost();
    const socket = await openHost(host.hostID);
    await authenticate(socket, host);
    await runInDurableObject(relayStub(host.hostID), (instance) => {
      const object = instance as unknown as { env: Record<string, unknown> };
      object.env = { ...object.env, RELAY_ENABLED: "0" };
    });
    socket.send({ t: "status", v: 1, state: "available", at: 1 });
    expect((await socket.closed).code).toBe(CLOSE.disabled);
    expect((await stored(host.hostID)).status).toBeUndefined();
  });

  it("a socket keeps its challenge and its authentication across hibernation", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const socket = await openHost(host.hostID);
    const nonce = await challengeOf(socket);
    await evictDurableObject(stub);
    socket.send(await hello(host, nonce));
    expect(await socket.next()).toEqual({ t: "ready", v: 1, devices: [] });
    await evictDurableObject(stub);
    socket.send({ t: "status", v: 1, state: "available", at: 3 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "available", at: 3 }));
  });
});

describe("relay phone socket", () => {
  it("a registered phone gets ready and the host gets open{stream, device}", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const phone = await openPhone(host.hostID);
    phone.send(vectors.messages.phoneOutbound[0]!);
    expect(await phone.next()).toEqual(vectors.messages.phoneInbound[0]);
    const open = (await mac.next()) as Message;
    expect(open).toEqual({ t: "open", v: 1, stream: expect.any(Number), device: VECTOR_DEVICE.device });
    expect(Number.isInteger(open.stream) && (open.stream as number) >= 0 && (open.stream as number) <= 0xffffffff)
      .toBe(true);
  });

  // Covers: GS-41-AC04
  it("a wrong token is refused with 4401 and the host hears nothing", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { device, token } = VECTOR_DEVICE;
    const refused: Message[] = [
      { t: "hello", v: 1, device, token: base64url(crypto.getRandomValues(new Uint8Array(32))) },
      { t: "hello", v: 1, device: deviceID(7), token },
      { t: "hello", v: 1, device: device.toLowerCase(), token },
      { t: "hello", v: 1, device, token: base64url(new Uint8Array(31)) },
      { t: "hello", v: 1, device, token: `${token}=` },
    ];
    for (const hello of refused) {
      const phone = await openPhone(host.hostID);
      phone.send(hello);
      expect((await phone.closed).code).toBe(CLOSE.unauthenticated);
    }
    // The first thing the Mac hears is the next good phone's open.
    await connectPhone(mac, host.hostID);
  });

  it("phone binary reaches the host with its stream prefix; host frames reach the phone without it", async () => {
    const [example] = vectors.streamFrames;
    expect(hex(frame(example!.stream, [9, 8]))).toBe(example!.frame);
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone, stream } = await connectPhone(mac, host.hostID);
    phone.send(new Uint8Array([9, 8]));
    expect(hex((await mac.next()) as ArrayBuffer)).toBe(hex(frame(stream, [9, 8])));
    mac.send(frame(stream, [1, 2, 3]));
    expect(hex((await phone.next()) as ArrayBuffer)).toBe("010203");
    // A frame may carry nothing.
    mac.send(frame(stream, []));
    expect(((await phone.next()) as ArrayBuffer).byteLength).toBe(0);
  });

  it("a message over 65,536 bytes is refused with 4413", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone, stream } = await connectPhone(mac, host.hostID);
    // 65,532 bytes from a phone arrive as one 65,536-byte frame, and a 65,536-byte frame reaches it.
    phone.send(new Uint8Array(65_532));
    expect(((await mac.next()) as ArrayBuffer).byteLength).toBe(65_536);
    mac.send(frame(stream, new Uint8Array(65_532).fill(7)));
    expect(((await phone.next()) as ArrayBuffer).byteLength).toBe(65_532);
    phone.send(new Uint8Array(65_533));
    expect((await phone.closed).code).toBe(CLOSE.tooLarge);
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream, reason: "too_large" });
    mac.send(new Uint8Array(65_537));
    expect((await mac.closed).code).toBe(CLOSE.tooLarge);
    const text = await openHost(host.hostID);
    await authenticate(text, host);
    text.send("x".repeat(65_537));
    expect((await text.closed).code).toBe(CLOSE.tooLarge);
  });

  // Covers: GS-44-AC01, GS-12-AC03
  it("with no host socket a phone gets host{offline, at: lastHostSeen} and 4404", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    mac.ws.close(1000);
    await vi.waitFor(async () => expect(await socketCount(host.hostID)).toBe(0));
    const phone = await openPhone(host.hostID);
    phone.send(vectors.messages.phoneOutbound[0]!);
    const told = (await phone.next()) as Message;
    expect((await phone.closed).code).toBe(CLOSE.hostUnavailable);
    expect(told).toEqual({ t: "host", v: 1, state: "offline", at: (await stored(host.hostID)).lastHostSeen });
  });

  it("after status paused a phone gets host{paused}", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    mac.send(vectors.messages.hostOutbound[3]!);
    await vi.waitFor(async () => expect((await stored(host.hostID)).status?.state).toBe("paused"));
    for (const macOpen of [true, false]) {
      if (!macOpen) {
        mac.ws.close(1000);
        await vi.waitFor(async () => expect(await socketCount(host.hostID)).toBe(0));
      }
      // Paused explains itself whether or not the Mac's socket is still open.
      const phone = await openPhone(host.hostID);
      phone.send(vectors.messages.phoneOutbound[0]!);
      expect(await phone.next()).toEqual(vectors.messages.phoneInbound[3]);
      expect((await phone.closed).code).toBe(CLOSE.hostUnavailable);
    }
  });

  it("a ninth phone socket is refused", async () => {
    const host = await freshHost();
    const mac = await openHost(host.hostID);
    await authenticate(mac, host);
    const devices = await Promise.all(Array.from({ length: 9 }, (_, index) => newDevice(index)));
    // The Mac can register only eight devices, so the ninth is written into storage directly.
    await runInDurableObject(relayStub(host.hostID), (_instance, state) => state.storage.put("devices",
      Object.fromEntries(devices.map(({ device, tokenHash }) => [device, { tokenHash }]))));
    for (const device of devices.slice(0, 8)) await connectPhone(mac, host.hostID, device);
    const ninth = await openPhone(host.hostID);
    ninth.send(phoneHello(devices[8]!));
    expect((await ninth.closed).code).toBe(CLOSE.overBudget);
  });

  it("a device's second socket replaces its first with 4409", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const first = await connectPhone(mac, host.hostID);
    const second = await openPhone(host.hostID);
    second.send(phoneHello(VECTOR_DEVICE));
    expect((await first.phone.closed).code).toBe(CLOSE.replaced);
    // The Mac hears the old stream close before the new one opens.
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream: first.stream, reason: "replaced" });
    const open = (await mac.next()) as Message;
    expect(open).toEqual({ t: "open", v: 1, stream: expect.any(Number), device: VECTOR_DEVICE.device });
    expect(open.stream).not.toBe(first.stream);
    expect(await second.next()).toEqual({ t: "ready", v: 1 });
  });

  it("closing a phone socket tells the host close{stream}; host close{stream} closes the phone", async () => {
    const host = await freshHost();
    const devices = [await newDevice(1), await newDevice(2)];
    const mac = await hostWithDevices(host, devices);
    const first = await connectPhone(mac, host.hostID, devices[0]);
    const second = await connectPhone(mac, host.hostID, devices[1]);
    first.phone.ws.close(1000);
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream: first.stream, reason: "closed" });
    mac.send({ t: "close", v: 1, stream: second.stream });
    expect((await second.phone.closed).code).toBe(1000);
    // The Mac's own close is not echoed back: the next thing it hears is the next phone's open.
    await connectPhone(mac, host.hostID, devices[0]);
  });

  // Covers: GS-02-AC04
  it("revoke closes that device's socket with 4403 and refuses its token", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone, stream } = await connectPhone(mac, host.hostID);
    mac.send(vectors.messages.hostOutbound[2]!);
    expect((await phone.closed).code).toBe(CLOSE.revoked);
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream, reason: "revoked" });
    const again = await openPhone(host.hostID);
    again.send(vectors.messages.phoneOutbound[0]!);
    expect((await again.closed).code).toBe(CLOSE.unauthenticated);
  });

  it("over the daily budget closes streams with 4429 and refuses new ones until the next UTC day", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const original = RelayObject.dailyBudgetBytes;
    RelayObject.dailyBudgetBytes = 64 * 1024;
    try {
      const mac = await hostWithDevices(host);
      const { phone, stream } = await connectPhone(mac, host.hostID);
      phone.send(new Uint8Array(32 * 1024));
      expect(((await mac.next()) as ArrayBuffer).byteLength).toBe(32 * 1024 + 4);
      phone.send(new Uint8Array(32 * 1024));
      expect((await phone.closed).code).toBe(CLOSE.overBudget);
      expect(await mac.next()).toEqual({ t: "close", v: 1, stream, reason: "over_budget" });
      // The Mac's socket stays open, but no phone gets in for the rest of the UTC day.
      mac.send({ t: "status", v: 1, state: "available", at: 4 });
      await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "available", at: 4 }));
      const refused = await openPhone(host.hostID);
      refused.send(vectors.messages.phoneOutbound[0]!);
      expect((await refused.closed).code).toBe(CLOSE.overBudget);
      // The count belongs to today's UTC date. Once that is yesterday, phones get in again.
      await runInDurableObject(stub, async (_instance, state) => {
        const used = await state.storage.get<number>(`usage:${utcDay()}`);
        expect(used).toBeGreaterThanOrEqual(64 * 1024);
        await state.storage.delete(`usage:${utcDay()}`);
        await state.storage.put(`usage:${utcDay(1)}`, used);
      });
      await evictDurableObject(stub);
      await connectPhone(mac, host.hostID);
    } finally {
      RelayObject.dailyBudgetBytes = original;
    }
  });

  it("bytes from sockets that never authenticate do not count against the budget", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const original = RelayObject.dailyBudgetBytes;
    RelayObject.dailyBudgetBytes = 64 * 1024;
    try {
      // A probe of a host id no Mac has used leaves nothing behind, not even a byte count.
      const probe = await openPhone(host.hostID);
      probe.send("x".repeat(60 * 1024));
      expect((await probe.closed).code).toBe(CLOSE.unauthenticated);
      await runDurableObjectAlarm(stub);
      expect(await runInDurableObject(stub, async (_instance, state) =>
        ({ keys: [...(await state.storage.list()).keys()], alarm: await state.storage.getAlarm() })))
        .toEqual({ keys: [], alarm: null });
      // Strangers send more than the whole day's budget, and the Mac's own phone still gets in.
      const mac = await hostWithDevices(host);
      const junk: [Outgoing, number][] = [
        [new Uint8Array(60 * 1024), CLOSE.unauthenticated],
        ["y".repeat(60 * 1024), CLOSE.unauthenticated],
        [new Uint8Array(70 * 1024), CLOSE.tooLarge],
      ];
      for (const [message, code] of junk) {
        const stranger = await openPhone(host.hostID);
        stranger.send(message);
        expect((await stranger.closed).code).toBe(code);
      }
      await connectPhone(mac, host.hostID);
    } finally {
      RelayObject.dailyBudgetBytes = original;
    }
  });

  it("the alarm deletes storage 30 days after the last host hello", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    const mac = await hostWithDevices(host);
    mac.send({ t: "status", v: 1, state: "available", at: 1 });
    await vi.waitFor(async () => expect((await stored(host.hostID)).status).toEqual({ state: "available", at: 1 }));
    const forget = () => runInDurableObject(stub, (_instance, state) =>
      state.storage.put("lastHostSeen", Math.floor(Date.now() / 1000) - 120));
    const original = RelayObject.idleRetentionMs;
    RelayObject.idleRetentionMs = 60_000;
    try {
      // Last seen at a hello older than the window, but still connected: everything stays.
      await forget();
      await runDurableObjectAlarm(stub);
      expect((await stored(host.hostID)).devices).toEqual({ [VECTOR_DEVICE.device]: { tokenHash: VECTOR_DEVICE.tokenHash } });
      // Its socket closing counts as being seen, so the alarm right after keeps everything too.
      mac.ws.close(1000);
      await vi.waitFor(async () => expect(await socketCount(host.hostID)).toBe(0));
      await pause(50);
      await runDurableObjectAlarm(stub);
      expect((await stored(host.hostID)).devices).toBeDefined();
      // No socket, and last seen longer ago than the window: the object forgets the Mac.
      await forget();
      await runDurableObjectAlarm(stub);
      const left = await runInDurableObject(stub, async (_instance, state) =>
        ({ keys: [...(await state.storage.list()).keys()], alarm: await state.storage.getAlarm() }));
      expect(left).toEqual({ keys: [], alarm: null });
    } finally {
      RelayObject.idleRetentionMs = original;
    }
  });

  // Covers: GS-41-AC06
  it("status off closes every phone socket with host{off}", async () => {
    const host = await freshHost();
    const devices = [await newDevice(1), await newDevice(2)];
    const mac = await hostWithDevices(host, devices);
    const phones = [await connectPhone(mac, host.hostID, devices[0]), await connectPhone(mac, host.hostID, devices[1])];
    mac.send({ t: "status", v: 1, state: "off", at: 1789000100 });
    for (const { phone } of phones) {
      expect(await phone.next()).toEqual({ t: "host", v: 1, state: "off", at: 1789000100 });
      expect((await phone.closed).code).toBe(CLOSE.hostUnavailable);
    }
    const closes = [await mac.next(), await mac.next()];
    expect(closes).toEqual(expect.arrayContaining(
      phones.map(({ stream }) => ({ t: "close", v: 1, stream, reason: "off" }))));
  });

  // Covers: GS-42-AC06, GS-21-AC05
  it("logs nothing containing keys, tokens or frame bytes", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    try {
      const host = await freshHost();
      const mac = await openHost(host.hostID);
      const nonce = await challengeOf(mac);
      const signed = await hello(host, nonce);
      mac.send(signed);
      await mac.next();
      mac.send({ t: "device", v: 1, id: VECTOR_DEVICE.device, tokenHash: VECTOR_DEVICE.tokenHash });
      await vi.waitFor(async () => expect((await stored(host.hostID)).devices).toBeDefined());
      const { phone, stream } = await connectPhone(mac, host.hostID);
      const secret = encoder.encode("frame-bytes-that-never-reach-a-log");
      phone.send(secret);
      await mac.next();
      mac.send(frame(stream, secret));
      await phone.next();
      phone.send("not a frame");
      await mac.next();
      mac.send(vectors.messages.hostOutbound[2]!);
      mac.ws.close(1000);
      await vi.waitFor(async () => expect(await socketCount(host.hostID)).toBe(0));
      const calls = spies.flatMap((spy) => spy.mock.calls);
      const logged = calls.map((args) => args.map((arg) => String(arg)).join(" ")).join("\n");
      for (const value of [host.key, signed.sig as string, nonce, VECTOR_DEVICE.token, VECTOR_DEVICE.tokenHash,
        "frame-bytes-that-never-reach-a-log"]) {
        expect(logged).not.toContain(value);
      }
      expect(calls.flat().some((arg) => arg instanceof ArrayBuffer || ArrayBuffer.isView(arg))).toBe(false);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("a host connected longer than the retention window keeps its storage", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    await hostWithDevices(host);
    const original = RelayObject.idleRetentionMs;
    RelayObject.idleRetentionMs = 1;
    try {
      await runInDurableObject(stub, (_instance, state) => state.storage.put("lastHostSeen", 1));
      await runDurableObjectAlarm(stub);
      const after = await stored(host.hostID);
      expect(after.devices).toEqual({ [VECTOR_DEVICE.device]: { tokenHash: VECTOR_DEVICE.tokenHash } });
      // While its socket is open the alarm counts the Mac as seen now.
      expect(after.lastHostSeen).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5);
    } finally {
      RelayObject.idleRetentionMs = original;
    }
  });

  it("the alarm prunes usage records older than two days", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    await authenticate(await openHost(host.hostID), host);
    await runInDurableObject(stub, (_instance, state) => state.storage.put(Object.fromEntries(
      [0, 1, 2, 3, 10].map((daysAgo) => [`usage:${utcDay(daysAgo)}`, 100]))));
    await runDurableObjectAlarm(stub);
    const kept = await runInDurableObject(stub, async (_instance, state) =>
      [...(await state.storage.list({ prefix: "usage:" })).keys()]);
    expect(kept).toEqual([2, 1, 0].map((daysAgo) => `usage:${utcDay(daysAgo)}`));
  });

  it("when the Mac's socket closes, each phone hears why and closes with 4404", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone } = await connectPhone(mac, host.hostID);
    mac.ws.close(1000);
    const told = (await phone.next()) as Message;
    expect((await phone.closed).code).toBe(CLOSE.hostUnavailable);
    expect(told).toEqual({ t: "host", v: 1, state: "offline", at: (await stored(host.hostID)).lastHostSeen });
  });

  it("a second authenticated host also closes the phones that streamed through the first with 4409", async () => {
    const host = await freshHost();
    const first = await hostWithDevices(host);
    const { phone } = await connectPhone(first, host.hostID);
    const second = await openHost(host.hostID);
    expect(await authenticate(second, host)).toEqual({ t: "ready", v: 1, devices: [VECTOR_DEVICE.device] });
    expect((await first.closed).code).toBe(CLOSE.replaced);
    expect((await phone.closed).code).toBe(CLOSE.replaced);
    // The phone comes back through the new socket, which never heard of the old stream.
    await connectPhone(second, host.hostID);
  });

  it("a new token hash for a device closes its socket with 4403", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone, stream } = await connectPhone(mac, host.hostID);
    // The same hash again changes nothing.
    mac.send(vectors.messages.hostOutbound[1]!);
    phone.send(new Uint8Array([5]));
    expect(hex((await mac.next()) as ArrayBuffer)).toBe(hex(frame(stream, [5])));
    const replacement = await newDevice(0);
    mac.send({ t: "device", v: 1, id: VECTOR_DEVICE.device, tokenHash: replacement.tokenHash });
    expect((await phone.closed).code).toBe(CLOSE.revoked);
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream, reason: "revoked" });
    const old = await openPhone(host.hostID);
    old.send(vectors.messages.phoneOutbound[0]!);
    expect((await old.closed).code).toBe(CLOSE.unauthenticated);
  });

  it("until ready a phone may send only its hello, and after ready only binary", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const firsts: Outgoing[] = [
      new Uint8Array([1, 2, 3]),
      "not json",
      { t: "ready", v: 1 },
      { ...vectors.messages.phoneOutbound[0]!, v: 2 },
    ];
    for (const first of firsts) {
      const phone = await openPhone(host.hostID);
      phone.send(first);
      expect((await phone.closed).code).toBe(CLOSE.unauthenticated);
    }
    // ping and pong are keepalives, never a first message, and still answered after ready.
    const phone = await openPhone(host.hostID);
    phone.send("ping");
    expect(await phone.next()).toBe("pong");
    phone.send("pong");
    phone.send(vectors.messages.phoneOutbound[0]!);
    expect(await phone.next()).toEqual({ t: "ready", v: 1 });
    const { stream } = (await mac.next()) as { stream: number };
    phone.send("ping");
    expect(await phone.next()).toBe("pong");
    phone.send({ t: "hello", v: 1 });
    expect((await phone.closed).code).toBe(CLOSE.badRequest);
    expect(await mac.next()).toEqual({ t: "close", v: 1, stream, reason: "closed" });
  });

  it("phone and Mac sockets share the unauthenticated caps", async () => {
    const host = await freshHost();
    const group = randomGroup();
    await openHost(host.hostID, `${group}::1`);
    await openHost(host.hostID, `${group}::2`);
    await openPhone(host.hostID, `${group}::3`);
    await openPhone(host.hostID, `${group}::4`);
    await expectAnswer(await upgrade(host.hostID, "phone", `${group}::5`), "rate_limited");
    await expectAnswer(await upgrade(host.hostID, "socket", `${group}::6`), "rate_limited");
  });

  it("an idle socket is closed with 4503 at the next alarm once the relay is switched off", async () => {
    const host = await freshHost();
    const mac = await hostWithDevices(host);
    const { phone } = await connectPhone(mac, host.hostID);
    const pending = await openPhone(host.hostID);
    await switchOff(host.hostID);
    await runDurableObjectAlarm(relayStub(host.hostID));
    for (const socket of [mac, phone, pending]) expect((await socket.closed).code).toBe(CLOSE.disabled);
  });

  it("a hello after its deadline is refused even before the alarm runs", async () => {
    const host = await freshHost();
    const stub = relayStub(host.hostID);
    await hostWithDevices(host);
    const original = RelayObject.authTimeoutMs;
    RelayObject.authTimeoutMs = 30;
    try {
      const lateMac = await openHost(host.hostID);
      const nonce = await challengeOf(lateMac);
      const latePhone = await openPhone(host.hostID);
      // With the alarm gone, only the hello's own check can refuse these.
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      await pause(60);
      lateMac.send(await hello(host, nonce));
      expect((await lateMac.closed).code).toBe(CLOSE.unauthenticated);
      latePhone.send(vectors.messages.phoneOutbound[0]!);
      expect((await latePhone.closed).code).toBe(CLOSE.unauthenticated);
    } finally {
      RelayObject.authTimeoutMs = original;
    }
  });
});
