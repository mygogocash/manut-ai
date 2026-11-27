import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSH_HOSTS } from "../../../packages/remote-channel/src/push";
import worker, { type Env } from "../src/index";
import { RelayObject } from "../src/relay-object";
import { WEB_PUSH_HOSTS, webPushAddress } from "../src/web-push";
import { sourceWorker } from "./source-worker";

/// Push (item 78d, docs/remote-access.md, "Push"; docs/relay-protocol-v1.md, `webpush` and `push`): the Mac gives one
/// of its own devices a push address on a known push service, and the relay wakes it with a Web Push that carries
/// nothing, signed with VAPID (RFC 8292). Every key here is made for the test, and the push services are a stand-in on
/// the global fetch: nothing leaves workerd.

const bindings = env as unknown as Env;
const encoder = new TextEncoder();
const APPLE = "https://web.push.apple.com/QGuQyavXutnMH8iVgwGGgVwKbd5Wfa1DXQWCeQGAkdaBJgJ1wUtklzp9KgAoWwPbIaHRdQ0v7gkTSDN";
const GOOGLE = "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bHqjZxM0VImWWqDRN7U0a3AycjUf4O-byuxb_wJsKRaKvV";
const MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABjZ3cKtestonly";

type Message = Record<string, unknown>;
type Received = Message | string | ArrayBuffer;
type Socket = { next(): Promise<Received>; send(value: Message | string): void; closed: Promise<{ code: number }> };
type Device = { device: string; token: string; tokenHash: string };
type PushKey = { publicKey: string; privateKey: string; verifier: CryptoKey };
type Stored = { devices?: Record<string, { tokenHash: string; webPush?: string }>; pushes?: { hour: number; count: number } };

afterEach(() => {
  vi.restoreAllMocks();
});

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/// A throwaway Web Push key pair in the form the Wrangler secrets hold it: the 32-byte scalar and the 65-byte point.
async function pushKey(): Promise<PushKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { publicKey: base64url(raw), privateKey: jwk.d!, verifier: pair.publicKey };
}

async function freshHost() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const x963 = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const hostID = base64url(await crypto.subtle.digest("SHA-256", x963));
  const sign = async (message: string) =>
    base64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, encoder.encode(message)));
  return { hostID, key: base64url(x963), sign };
}

function wire(ws: WebSocket): Socket {
  const queue: Received[] = [];
  const waiting: ((value: Received) => void)[] = [];
  ws.addEventListener("message", (event) => {
    let value: Received = event.data as ArrayBuffer;
    if (typeof event.data === "string") {
      try {
        value = JSON.parse(event.data) as Message;
      } catch {
        value = event.data;
      }
    }
    const waiter = waiting.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code }), { once: true });
  });
  ws.binaryType = "arraybuffer";
  ws.accept();
  return {
    closed,
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiting.push(resolve))),
    send: (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value)),
  };
}

async function open(hostID: string, role: "socket" | "phone"): Promise<Socket> {
  const response = await sourceWorker.fetch(`https://relay.test/relay/v1/hosts/${hostID}/${role}`, { headers: { upgrade: "websocket" } });
  expect(response.status).toBe(101);
  return wire(response.webSocket!);
}

function deviceID(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).toUpperCase().padStart(12, "0")}`;
}

async function newDevice(index: number): Promise<Device> {
  const token = crypto.getRandomValues(new Uint8Array(32));
  return { device: deviceID(index), token: base64url(token), tokenHash: base64url(await crypto.subtle.digest("SHA-256", token)) };
}

function relayStub(hostID: string): DurableObjectStub {
  return bindings.RELAY.get(bindings.RELAY.idFromName(`relay:${hostID}`));
}

function stored(hostID: string): Promise<Stored> {
  return runInDurableObject(relayStub(hostID), async (_instance, state) =>
    Object.fromEntries(await state.storage.get(["devices", "pushes"])) as Stored);
}

/// Sets this one relay object's environment, as a deploy with these settings would.
function setEnv(hostID: string, values: Record<string, string>): Promise<void> {
  return runInDurableObject(relayStub(hostID), (instance) => {
    const object = instance as unknown as { env: Record<string, unknown> };
    object.env = { ...object.env, ...values };
  });
}

/// A Mac through its hello on a relay object of its own, with `devices` registered and, when given, the push key set.
async function macWith(devices: Device[], key?: PushKey) {
  const host = await freshHost();
  const mac = await open(host.hostID, "socket");
  const challenge = (await mac.next()) as Message;
  mac.send({ t: "hello", v: 1, key: host.key, sig: await host.sign(`gospark-relay-v1|host|${host.hostID}|${challenge.nonce as string}`) });
  expect(await mac.next()).toMatchObject({ t: "ready" });
  for (const { device, tokenHash } of devices) mac.send({ t: "device", v: 1, id: device, tokenHash });
  await vi.waitFor(async () => expect(Object.keys((await stored(host.hostID)).devices ?? {})).toEqual(devices.map((d) => d.device)));
  if (key) await setEnv(host.hostID, { WEB_PUSH_PUBLIC_KEY: key.publicKey, WEB_PUSH_PRIVATE_KEY: key.privateKey });
  return { host, mac };
}

/// Gives `device` its push address and waits until the relay holds it.
async function givePush(mac: Socket, hostID: string, device: string, endpoint: string): Promise<void> {
  mac.send({ t: "webpush", v: 1, id: device, endpoint });
  await vi.waitFor(async () => expect((await stored(hostID)).devices?.[device]?.webPush).toBe(endpoint));
}

type Sent = { url: string; method: string; headers: Headers; body: Uint8Array };

/// The push services, on the global fetch: each request is kept, and answered with `status` (or what `answer` says).
function pushServices(answer: (url: string) => number = () => 201) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
    return new Response(null, { status: answer(request.url) });
  });
  return sent;
}

/// Reads and checks a VAPID `Authorization` value (RFC 8292 sections 2 and 3) against the key that must have signed it.
async function checkVapid(value: string | null, key: PushKey, endpoint: string): Promise<void> {
  const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(value ?? "");
  expect(match, value ?? "").not.toBeNull();
  const [head, claims, signature] = match![1]!.split(".") as [string, string, string];
  expect(match![2]).toBe(key.publicKey);
  expect(JSON.parse(new TextDecoder().decode(unbase64url(head)))).toEqual({ typ: "JWT", alg: "ES256" });
  const body = JSON.parse(new TextDecoder().decode(unbase64url(claims))) as { aud: string; exp: number; sub: string };
  expect(body.aud).toBe(new URL(endpoint).origin);
  expect(body.sub).toBe("https://api.manut.test");
  const now = Math.floor(Date.now() / 1000);
  expect(body.exp).toBeGreaterThan(now);
  expect(body.exp).toBeLessThanOrEqual(now + 24 * 3600);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.verifier, unbase64url(signature), encoder.encode(`${head}.${claims}`));
  expect(ok).toBe(true);
}

async function health(values: Partial<Env>): Promise<Record<string, unknown>> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request("https://relay.test/v1/health", { headers: { "cf-connecting-ip": "192.0.2.77" } }),
    { ...bindings, ...values } as Env, context);
  await waitOnExecutionContext(context);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("the push key", () => {
  it("is offered in the public health answer only while the relay is on and both halves are set", async () => {
    const key = await pushKey();
    const both = { WEB_PUSH_PUBLIC_KEY: key.publicKey, WEB_PUSH_PRIVATE_KEY: key.privateKey };
    expect((await health({ RELAY_ENABLED: "1", ...both })).webPush).toBe(key.publicKey);
    expect((await health({ RELAY_ENABLED: "0", ...both })).webPush).toBeNull();
    expect((await health({ RELAY_ENABLED: "1", WEB_PUSH_PUBLIC_KEY: key.publicKey })).webPush).toBeNull();
    expect((await health({ RELAY_ENABLED: "1", WEB_PUSH_PRIVATE_KEY: key.privateKey })).webPush).toBeNull();
    expect((await health({ RELAY_ENABLED: "1", ...both, WEB_PUSH_PUBLIC_KEY: key.publicKey.slice(1) })).webPush).toBeNull();
    // The private half never appears in it.
    expect(JSON.stringify(await health({ RELAY_ENABLED: "1", ...both }))).not.toContain(key.privateKey);
  });

  it("takes push addresses on the same three hosts as the phone and the Mac", () => {
    expect(WEB_PUSH_HOSTS).toEqual(PUSH_HOSTS);
    for (const address of [APPLE, GOOGLE, MOZILLA]) expect(webPushAddress(address)).toBe(true);
    for (const address of ["https://example.com/push", "https://fcm.googleapis.com:444/x", "http://web.push.apple.com/x", "https://web.push.apple.com/"]) {
      expect(webPushAddress(address), address).toBe(false);
    }
  });
});

describe("webpush", () => {
  it("keeps only the address for the Mac's own device, takes it away with null, and goes with the device's revoke", async () => {
    const phone = await newDevice(1);
    const { host, mac } = await macWith([phone]);
    await givePush(mac, host.hostID, phone.device, APPLE);
    expect((await stored(host.hostID)).devices).toEqual({ [phone.device]: { tokenHash: phone.tokenHash, webPush: APPLE } });
    mac.send({ t: "webpush", v: 1, id: phone.device, endpoint: null });
    await vi.waitFor(async () => expect((await stored(host.hostID)).devices).toEqual({ [phone.device]: { tokenHash: phone.tokenHash } }));
    await givePush(mac, host.hostID, phone.device, GOOGLE);
    mac.send({ t: "revoke", v: 1, id: phone.device });
    await vi.waitFor(async () => expect((await stored(host.hostID)).devices).toEqual({}));
  });

  it("is refused from a phone, as its hello or after it", async () => {
    const phone = await newDevice(2);
    const { host, mac } = await macWith([phone]);
    const asHello = await open(host.hostID, "phone");
    asHello.send({ t: "webpush", v: 1, id: phone.device, endpoint: APPLE });
    expect((await asHello.closed).code).toBe(4401);
    const after = await open(host.hostID, "phone");
    after.send({ t: "hello", v: 1, device: phone.device, token: phone.token });
    expect(await after.next()).toEqual({ t: "ready", v: 1 });
    expect(await mac.next()).toMatchObject({ t: "open", device: phone.device });
    after.send({ t: "webpush", v: 1, id: phone.device, endpoint: APPLE });
    expect((await after.closed).code).toBe(4400);
    expect((await stored(host.hostID)).devices?.[phone.device]?.webPush).toBeUndefined();
  });

  it("is ignored for a device this Mac did not register, another Mac's included", async () => {
    const theirs = await newDevice(3);
    const mine = await newDevice(4);
    const other = await macWith([theirs]);
    const { host, mac } = await macWith([mine]);
    mac.send({ t: "webpush", v: 1, id: theirs.device, endpoint: APPLE });
    // Messages are read in order, so once the next one is kept the first was read and left nothing.
    await givePush(mac, host.hostID, mine.device, GOOGLE);
    expect(Object.keys((await stored(host.hostID)).devices ?? {})).toEqual([mine.device]);
    expect((await stored(other.host.hostID)).devices).toEqual({ [theirs.device]: { tokenHash: theirs.tokenHash } });
  });

  it("refuses an address that is not on a known push service, and keeps nothing", async () => {
    const phone = await newDevice(5);
    const { host, mac } = await macWith([phone]);
    for (const endpoint of ["https://push.example.com/abc", "https://fcm.googleapis.com.example.com/x", "http://fcm.googleapis.com/fcm/send/x",
      "https://web.push.apple.com:8443/x", "https://user@fcm.googleapis.com/fcm/send/x", "https://169.254.169.254/latest/meta-data"]) {
      mac.send({ t: "webpush", v: 1, id: phone.device, endpoint });
      expect(await mac.next(), endpoint).toEqual({ t: "error", v: 1, code: "push_address" });
    }
    expect((await stored(host.hostID)).devices).toEqual({ [phone.device]: { tokenHash: phone.tokenHash } });
  });

  it("closes the Mac's socket with 4400 when it cannot be read", async () => {
    const phone = await newDevice(6);
    const { mac } = await macWith([phone]);
    mac.send({ t: "webpush", v: 1, id: "not-a-device", endpoint: APPLE });
    expect((await mac.closed).code).toBe(4400);
  });
});

describe("push", () => {
  it("sends each named device one request with no body, signed with VAPID, to its address alone", async () => {
    const key = await pushKey();
    const [one, two, three] = await Promise.all([newDevice(7), newDevice(8), newDevice(9)]);
    const { host, mac } = await macWith([one!, two!, three!], key);
    await givePush(mac, host.hostID, one!.device, APPLE);
    await givePush(mac, host.hostID, two!.device, MOZILLA);
    const sent = pushServices();
    // The third device has no address, and the second is not named.
    mac.send({ t: "push", v: 1, kind: "decision", devices: [one!.device, three!.device] });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const [request] = sent;
    expect(request!.url).toBe(APPLE);
    expect(request!.method).toBe("POST");
    expect(request!.body.byteLength).toBe(0);
    expect(request!.headers.get("ttl")).toBe("3600");
    expect(request!.headers.get("urgency")).toBe("high");
    expect(request!.headers.get("topic")).toBe("manut-mac");
    expect(request!.headers.get("content-encoding")).toBeNull();
    await checkVapid(request!.headers.get("authorization"), key, APPLE);
    // Named by no one, every device with an address is woken.
    mac.send({ t: "push", v: 1, kind: "decision" });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent.slice(1).map((s) => s.url).sort()).toEqual([APPLE, MOZILLA].sort());
    await checkVapid(sent.find((s) => s.url === MOZILLA)!.headers.get("authorization"), key, MOZILLA);
  });

  it("forgets an address the push service says is gone, and tells the Mac", async () => {
    const key = await pushKey();
    const [gone, missing, failing] = await Promise.all([newDevice(10), newDevice(11), newDevice(12)]);
    const { host, mac } = await macWith([gone!, missing!, failing!], key);
    const missingAt = `${GOOGLE}missing`;
    await givePush(mac, host.hostID, gone!.device, APPLE);
    await givePush(mac, host.hostID, missing!.device, missingAt);
    await givePush(mac, host.hostID, failing!.device, MOZILLA);
    const sent = pushServices((url) => (url === APPLE ? 410 : url === missingAt ? 404 : 500));
    mac.send({ t: "push", v: 1, kind: "decision" });
    const told = [await mac.next(), await mac.next()];
    expect(told).toEqual(expect.arrayContaining([
      { t: "webpush", v: 1, id: gone!.device, endpoint: null },
      { t: "webpush", v: 1, id: missing!.device, endpoint: null },
    ]));
    expect(sent).toHaveLength(3);
    const devices = (await stored(host.hostID)).devices!;
    expect(devices[gone!.device]).toEqual({ tokenHash: gone!.tokenHash });
    expect(devices[missing!.device]).toEqual({ tokenHash: missing!.tokenHash });
    // A failure that is not "gone" keeps the address.
    expect(devices[failing!.device]?.webPush).toBe(MOZILLA);
  });

  it("sends at most pushesPerHour a clock hour, and then tells the Mac", async () => {
    const original = RelayObject.pushesPerHour;
    RelayObject.pushesPerHour = 2;
    try {
      const key = await pushKey();
      const phone = await newDevice(13);
      const { host, mac } = await macWith([phone], key);
      await givePush(mac, host.hostID, phone.device, APPLE);
      const sent = pushServices();
      mac.send({ t: "push", v: 1, kind: "decision" });
      mac.send({ t: "push", v: 1, kind: "decision" });
      await vi.waitFor(() => expect(sent).toHaveLength(2));
      mac.send({ t: "push", v: 1, kind: "decision" });
      expect(await mac.next()).toEqual({ t: "error", v: 1, code: "push_limit" });
      expect(sent).toHaveLength(2);
      expect((await stored(host.hostID)).pushes).toEqual({ hour: Math.floor(Date.now() / 3_600_000), count: 2 });
      // The next hour starts afresh.
      await runInDurableObject(relayStub(host.hostID), (_instance, state) => state.storage.put("pushes", { hour: 1, count: 2 }));
      mac.send({ t: "push", v: 1, kind: "decision" });
      await vi.waitFor(() => expect(sent).toHaveLength(3));
    } finally {
      RelayObject.pushesPerHour = original;
    }
  });

  it("sends nothing while no push key is set, and counts nothing", async () => {
    const phone = await newDevice(14);
    const { host, mac } = await macWith([phone]);
    await givePush(mac, host.hostID, phone.device, APPLE);
    const sent = pushServices();
    mac.send({ t: "push", v: 1, kind: "decision" });
    // A message after it, answered, shows the push was read.
    mac.send({ t: "webpush", v: 1, id: phone.device, endpoint: "https://example.com/x" });
    expect(await mac.next()).toEqual({ t: "error", v: 1, code: "push_address" });
    expect(sent).toEqual([]);
    expect((await stored(host.hostID)).pushes).toBeUndefined();
  });

  it("does nothing while the relay is switched off", async () => {
    const key = await pushKey();
    const phone = await newDevice(15);
    const { host, mac } = await macWith([phone], key);
    await givePush(mac, host.hostID, phone.device, APPLE);
    const sent = pushServices();
    await setEnv(host.hostID, { RELAY_ENABLED: "0" });
    mac.send({ t: "push", v: 1, kind: "decision" });
    expect((await mac.closed).code).toBe(4503);
    expect(sent).toEqual([]);
    expect((await stored(host.hostID)).pushes).toBeUndefined();
  });

  it("closes the Mac's socket with 4400 when it cannot be read", async () => {
    for (const bad of [{ kind: "nothing" }, {}, { kind: "decision", devices: "all" }, { kind: "decision", devices: ["x"] },
      { kind: "decision", devices: Array.from({ length: 9 }, (_, i) => deviceID(i)) }]) {
      const phone = await newDevice(16);
      const { mac } = await macWith([phone], await pushKey());
      mac.send({ t: "push", v: 1, ...bad });
      expect((await mac.closed).code, JSON.stringify(bad)).toBe(4400);
    }
  });
});
