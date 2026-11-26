import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { RemoteMac } from "../../desktop/src/remote/host";
import { memoryKeyring } from "../../desktop/src/remote/keys";
import type { RelaySocket } from "../../desktop/src/remote/link";
import { FakeChats, PLAIN } from "../../desktop/src/remote/testkit/chats";
import { type PhoneSocket, TestPhone } from "../../desktop/src/remote/testkit/phone";

/// The Mac's side of reaching it from a phone (item 78b, apps/desktop/src/remote/), run against the REAL relay object in
/// workerd: the Mac is the desktop's own RemoteMac, with a keyring in memory and chats a test controls, and the phone is
/// built from `@manut/remote-channel` and a stand-in passkey (testkit/phone.ts). They pair through the relay, open a
/// session through it, and do each of the six requests. Every message either side sent or received through the relay
/// is kept, and none may carry a chat's words, an ask's, the phone's name or any key in a form anyone can read.
///
/// Every key here is made for the test. The relay is on in the test configuration (wrangler.test.json).

const ORIGIN = "https://dev.manut.xyz";
const RP = { id: "dev.manut.xyz", origin: ORIGIN };

type Carried = { side: "mac" | "phone"; way: "sent" | "received"; data: string | Uint8Array };

/// A documentation-only IPv6 /64 of its own for each socket, so no test meets another's upgrade limit.
function source(): string {
  const [a = 0, b = 0, c = 0, d = 0] = crypto.getRandomValues(new Uint16Array(4));
  return `2001:db8:${a.toString(16)}:${b.toString(16)}:${c.toString(16)}::${d.toString(16)}`;
}

/// A workerd client socket as the shape the Mac's link and the test phone take, keeping every message it carried.
function socketTo(path: string, side: Carried["side"], carried: Carried[]): RelaySocket & PhoneSocket {
  let ws: WebSocket | null = null;
  const waiting: (string | Uint8Array)[] = [];
  let closed = false;
  const socket: RelaySocket & PhoneSocket = {
    binaryType: "arraybuffer",
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      carried.push({ side, way: "sent", data: typeof data === "string" ? data : data.slice() });
      if (ws) ws.send(data as string | Uint8Array<ArrayBuffer>);
      else waiting.push(data);
    },
    close(code, reason) {
      closed = true;
      try {
        ws?.close(code ?? 1000, reason ?? "");
      } catch {
        // Already closed.
      }
    },
  };
  void SELF.fetch(`https://relay.test${path}`, { headers: { upgrade: "websocket", "cf-connecting-ip": source() } }).then((response) => {
    const client = response.webSocket;
    if (!client) {
      socket.onclose?.({ code: 1006, reason: "" });
      return;
    }
    ws = client;
    client.binaryType = "arraybuffer";
    client.accept();
    client.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      carried.push({ side, way: "received", data: typeof data === "string" ? data : data.slice() });
      socket.onmessage?.({ data: typeof data === "string" ? data : data.slice().buffer });
    });
    client.addEventListener("close", (event) => socket.onclose?.({ code: event.code, reason: event.reason }));
    if (closed) client.close(1000, "");
    for (const data of waiting.splice(0)) client.send(data as string | Uint8Array<ArrayBuffer>);
  });
  return socket;
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const toB64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/// A Mac on the real relay, switched on and through its hello.
async function macOnRelay(carried: Carried[] = []) {
  const keyring = memoryKeyring();
  const chats = new FakeChats();
  const remote = new RemoteMac({
    keyring,
    origin: ORIGIN,
    connect: (url) => socketTo(new URL(url.replace(/^wss:/, "https:")).pathname, "mac", carried),
    probe: async () => "on",
    chats,
    actions: chats.actions,
    now: () => Date.now(),
  });
  await remote.turnOn();
  await vi.waitFor(() => expect(remote.snapshot().link).toBe("ready"), { timeout: 5_000 });
  return { remote, keyring, chats, carried };
}

/// Dials the relay as a phone with `device` and `token`, and says how the relay answered: `ready`, or its close code.
async function dialAs(hostId: string, device: string, token: string): Promise<string | number> {
  const socket = socketTo(`/relay/v1/hosts/${hostId}/phone`, "phone", []);
  const answer = new Promise<string | number>((resolve) => {
    socket.onmessage = (event) => resolve(typeof event.data === "string" ? (JSON.parse(event.data) as { t: string }).t : "binary");
    socket.onclose = (event) => resolve(event.code);
  });
  socket.send(JSON.stringify({ t: "hello", v: 1, device, token }));
  const result = await answer;
  socket.close(1000, "");
  return result;
}

describe("the Mac and a phone through the real relay", () => {
  it("pair, open a session and do each of the six requests, and no readable word or key crosses the relay", async () => {
    const { remote, keyring, chats, carried } = await macOnRelay();

    // Pairing: the code through the relay's one-use door, the four digits typed at the Mac, the passkey back.
    const phone = new TestPhone({ name: "Somchai's iPhone", connect: (host) => socketTo(`/relay/v1/hosts/${host}/phone`, "phone", carried) });
    expect(await remote.startPairing()).toBe(true);
    const view = remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    let pairingSecret: Uint8Array | null = null;
    const outcome = await phone.pair(view.link, (code) => remote.typeCode(code), { rp: RP, before: (offer) => (pairingSecret = offer.secret.slice()) });
    expect(outcome).toBe("paired");
    expect(remote.snapshot().phones.map((p) => p.name)).toEqual(["Somchai's iPhone"]);
    expect(remote.snapshot().pairing).toEqual({ phase: "paired", name: "Somchai's iPhone" });

    // A session with K, and the six requests.
    const session = await phone.connect();
    await vi.waitFor(() => expect(remote.snapshot().phones[0]?.connected).toBe(true), { timeout: 5_000 });
    const list = await session.request({ t: "list" });
    expect(list).toMatchObject({ t: "chats", chats: [{ chat: "buddy", title: PLAIN.title, state: "needs_you" }, { chat: "kit", state: "done" }] });
    const opened = await session.request({ t: "open", chat: "buddy" });
    expect(opened.t).toBe("chat");
    const chat = opened.view as { messages: { text: string }[]; asks: { id: string; revision: number; command?: string }[]; step: string };
    expect(chat.messages.map((m) => m.text)).toEqual([PLAIN.message, PLAIN.reply]);
    expect(chat.asks.find((a) => a.id === "req-1")?.command).toBe(PLAIN.command);
    const caught = await session.request({ t: "catchup", chat: "buddy", cursor: opened.cursor });
    expect(caught).toMatchObject({ t: "events", events: [] });
    expect(await phone.allow(session, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
    // An answer to a question needs Face ID as an Allow does: alone, the request is answered with a challenge.
    expect(await session.request({ t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ t: "challenge" });
    expect(await phone.answer(session, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ t: "done" });
    expect(await session.request({ t: "stop", chat: "buddy" })).toMatchObject({ t: "done" });
    expect(await session.request({ t: "always", chat: "buddy", ask: "req-1" })).toMatchObject({ t: "refused", request: "always", reason: "stays_on_mac" });
    expect(chats.done).toEqual([
      { action: "allowOnce", chat: "buddy", ask: "req-1", by: phone.deviceId },
      { action: "answer", chat: "buddy", ask: "q-1", by: phone.deviceId, answer: "Friday" },
      { action: "stop", chat: "buddy" },
    ]);

    // Unpair: the Mac ends the session itself, and the relay is told.
    await remote.unpair(phone.deviceId!);
    await vi.waitFor(() => expect(session.inbox.closed).not.toBeNull(), { timeout: 5_000 });
    remote.turnOff();

    // Nothing readable crossed: not a chat's or an ask's words, not the phone's name, not K, the code's secret or the
    // Mac's relay key.
    const { secret } = phone.secrets();
    const hostKey = keyring.doc()!.host!;
    const words = [PLAIN.title, PLAIN.message, PLAIN.reply, PLAIN.command, PLAIN.question, "Reading the price list", "Somchai", "Friday"];
    const keys = [secret!, pairingSecret!];
    expect(carried.length).toBeGreaterThan(20);
    // The opened chat crossed as one sealed frame, larger than any handshake message.
    expect(carried.some((c) => c.side === "phone" && c.way === "received" && c.data instanceof Uint8Array && c.data.length > 400)).toBe(true);
    for (const { data } of carried) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const word of words) expect(contains(bytes, new TextEncoder().encode(word)), word).toBe(false);
      for (const key of keys) {
        expect(contains(bytes, key)).toBe(false);
        for (const text of [toHex(key), toB64Url(key)]) expect(contains(bytes, new TextEncoder().encode(text))).toBe(false);
      }
      expect(contains(bytes, new TextEncoder().encode(hostKey.d))).toBe(false);
    }
  });

  it("ends a pairing on a wrong code and shuts its door on the relay", async () => {
    const { remote } = await macOnRelay();
    const phone = new TestPhone({ name: "Pixel", connect: (host) => socketTo(`/relay/v1/hosts/${host}/phone`, "phone", []) });
    expect(await remote.startPairing()).toBe(true);
    const view = remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    let door: { id: string; token: string } | null = null;
    const outcome = await phone.pair(view.link, (code) => remote.typeCode(code === "0000" ? "0001" : "0000"), {
      rp: RP,
      before: (offer) => (door = { id: offer.doorId, token: toB64Url(offer.doorToken) }),
    }).catch(() => "closed");
    expect(outcome).not.toBe("paired");
    expect(remote.snapshot().pairing).toEqual({ phase: "failed", reason: "wrong_code" });
    // The one-use door no longer opens: the relay forgot it.
    await vi.waitFor(async () => expect(await dialAs(remote.hostId!, door!.id, door!.token)).toBe(4401), { timeout: 5_000 });
    remote.turnOff();
  });

  it("unpairs a phone while the relay cannot be reached, and revokes it on the relay once it can", async () => {
    const { remote } = await macOnRelay();
    const phone = new TestPhone({ name: "Pixel", connect: (host) => socketTo(`/relay/v1/hosts/${host}/phone`, "phone", []) });
    await remote.startPairing();
    const view = remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    expect(await phone.pair(view.link, (code) => remote.typeCode(code), { rp: RP })).toBe("paired");
    const token = phone.secrets().token!;
    expect(await dialAs(remote.hostId!, phone.deviceId!, token)).toBe("ready");
    // The switch goes off (the socket closes), the phone is unpaired with no relay to tell, and the switch comes back.
    remote.turnOff();
    await remote.unpair(phone.deviceId!);
    expect(remote.snapshot().phones).toEqual([]);
    await remote.turnOn();
    await vi.waitFor(() => expect(remote.snapshot().link).toBe("ready"), { timeout: 5_000 });
    // At `ready` the relay still listed the phone, and the Mac revoked it: its token no longer opens the door.
    await vi.waitFor(async () => expect(await dialAs(remote.hostId!, phone.deviceId!, token)).toBe(4401), { timeout: 5_000 });
    remote.turnOff();
  });
});
