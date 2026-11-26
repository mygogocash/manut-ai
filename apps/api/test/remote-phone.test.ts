import { SELF } from "cloudflare:test";
import { readPairingLink } from "@manut/remote-channel";
import { describe, expect, it, vi } from "vitest";
import { RemoteMac } from "../../desktop/src/remote/host";
import { memoryKeyring } from "../../desktop/src/remote/keys";
import type { RelaySocket } from "../../desktop/src/remote/link";
import type { SourceApproval } from "../../desktop/src/remote/project";
import { FakeChats, PLAIN } from "../../desktop/src/remote/testkit/chats";
import { TestAuthenticator } from "../../desktop/src/remote/testkit/phone";
import { liveBackend } from "../../web/src/app/mac/live";
import type { PairStep } from "../../web/src/app/mac/pair";
import { PasskeyCancelled, type Passkeys } from "../../web/src/app/mac/passkeys";
import type { PhoneSocket } from "../../web/src/app/mac/relay";
import { MacRemote, type MacView } from "../../web/src/app/mac/remote";
import { memoryVault } from "../../web/src/app/mac/vault";

/// The phone's side of reaching the Mac (item 78c, apps/web/src/app/mac/), run against the REAL relay object in workerd
/// and the desktop's own Mac (apps/desktop/src/remote/, item 78b). The phone is the web app's own code: its pairing, its
/// session and the Your Mac tab's state (`MacRemote`), with a vault in memory and a stand-in passkey that lays out its
/// answers as WebAuthn Level 3 does (the desktop's `TestAuthenticator`). The Mac is `RemoteMac` with a keyring in memory
/// and chats a test controls. They pair through the relay with the four digits typed at the Mac, register the passkey
/// over the channel, open a session, do all six requests, drop and catch up. Every message either side sent or received
/// is kept, and none may carry a chat's words, an ask's, the phone's name or a key in a form anyone can read.
///
/// Every key here is made for the test. The relay is on in the test configuration (wrangler.test.json).

const ORIGIN = "https://dev.manut.xyz";
const NAME = "iPhone, Safari";

type Carried = { side: "mac" | "phone"; way: "sent" | "received"; data: string | Uint8Array };

function source(): string {
  const [a = 0, b = 0, c = 0, d = 0] = crypto.getRandomValues(new Uint16Array(4));
  return `2001:db8:${a.toString(16)}:${b.toString(16)}:${c.toString(16)}::${d.toString(16)}`;
}

/// A workerd client socket as the shape both sides take, keeping every message it carried (as remote-mac.test.ts).
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
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
const toB64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

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

/// The browser's passkey, as the desktop's stand-in authenticator makes it; `cancelFirst` closes the first prompt.
function standInPasskeys(authenticator: TestAuthenticator, options: { cancelFirst?: boolean } = {}): Passkeys & { calls: string[] } {
  const calls: string[] = [];
  let cancel = options.cancelFirst ?? false;
  return {
    available: true,
    calls,
    create: async (request) => {
      calls.push("create");
      if (cancel) {
        cancel = false;
        throw new PasskeyCancelled();
      }
      return authenticator.create({ id: request.rpId, origin: ORIGIN }, request.challenge);
    },
    get: async (request) => {
      calls.push("get");
      expect(request.credentialId).toEqual(authenticator.credentialId);
      return authenticator.get({ id: request.rpId, origin: ORIGIN }, request.challenge);
    },
  };
}

async function macOnRelay(carried: Carried[]) {
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
  return { mac: remote, keyring, chats };
}

function phoneOnRelay(carried: Carried[], passkeys: Passkeys) {
  const vault = memoryVault();
  const phone = new MacRemote(
    liveBackend({
      origin: ORIGIN,
      connect: (url) => socketTo(new URL(url.replace(/^wss:/, "https:")).pathname, "phone", carried),
      vault,
      passkeys,
      relay: async () => "on",
      name: NAME,
      label: "Your Mac",
    }),
  );
  return { phone, vault };
}

const paired = (view: MacView) => (view.phase === "paired" ? view : null);

/// Pairs the phone: it reads the code, shows its digits, the person types them at the Mac, and then makes the passkey.
async function pairThrough(mac: RemoteMac, phone: MacRemote, typed: (digits: string) => string = (d) => d): Promise<{ link: string; digits: string }> {
  expect(await mac.startPairing()).toBe(true);
  const code = mac.snapshot().pairing;
  if (code.phase !== "showing") throw new Error("no code");
  const steps: PairStep["step"][] = [];
  phone.subscribe((view) => {
    if (view.phase === "pairing" && steps.at(-1) !== view.step.step) steps.push(view.step.step);
  });
  const pairing = phone.pair(code.link);
  let digits = "";
  await vi.waitFor(() => {
    const view = phone.view;
    if (view.phase !== "pairing" || view.step.step !== "digits") throw new Error("no digits yet");
    digits = view.step.digits;
  }, { timeout: 5_000 });
  expect(digits).toMatch(/^\d{4}$/);
  await mac.typeCode(typed(digits));
  await vi.waitFor(() => {
    const view = phone.view;
    if (view.phase === "pairing" && view.step.step === "passkey") return view.step.make();
    if (view.phase === "unpaired" && view.failed) return;
    throw new Error("no passkey step yet");
  }, { timeout: 5_000 });
  await pairing;
  return { link: code.link, digits };
}

describe("the phone and the Mac through the real relay", () => {
  it("pairs with the digits and a passkey, does all six requests, catches up after a drop, and no readable word or key crosses", async () => {
    const carried: Carried[] = [];
    const { mac, keyring, chats } = await macOnRelay(carried);
    const authenticator = new TestAuthenticator();
    const passkeys = standInPasskeys(authenticator, { cancelFirst: true });
    const { phone, vault } = phoneOnRelay(carried, passkeys);
    await phone.start();
    expect(phone.view).toEqual({ phase: "unpaired", failed: null });

    // Pairing. The first passkey prompt is closed, and the person presses again: it is the same pairing, still open.
    let pressedAgain = false;
    phone.subscribe((view) => {
      if (view.phase === "pairing" && view.step.step === "passkey" && view.step.cancelled && !pressedAgain) {
        pressedAgain = true;
        view.step.make();
      }
    });
    const { link } = await pairThrough(mac, phone);
    const pairingSecret = readPairingLink(link).secret;
    expect(passkeys.calls).toEqual(["create", "create"]);
    expect(mac.snapshot().pairing).toEqual({ phase: "paired", name: NAME });
    expect(mac.snapshot().phones.map((p) => p.name)).toEqual([NAME]);
    const kept = await vault.load();
    expect(kept).not.toBeNull();
    expect(kept!.k.extractable).toBe(false);
    expect(kept!.deviceId).toBe(mac.snapshot().phones[0]!.id);

    // The list, once the session is open.
    await vi.waitFor(() => expect(paired(phone.view)?.chats?.length).toBe(2), { timeout: 5_000 });
    expect(paired(phone.view)!.link).toBe("live");
    expect(paired(phone.view)!.chats).toMatchObject([{ chat: "buddy", title: PLAIN.title, state: "needs_you" }, { chat: "kit", state: "done" }]);

    // One chat: its messages, its step and its asks, whole.
    await phone.openChat("buddy");
    const open = paired(phone.view)!.open!;
    expect(open.view.messages.map((m) => m.text)).toEqual([PLAIN.message, PLAIN.reply]);
    expect(open.view.step).toBe("Reading the price list");
    expect(open.view.asks.find((a) => a.id === "req-1")).toMatchObject({ kind: "approval", command: PLAIN.command, cwd: "/Users/owner/shop", offers: ["once", "deny"], revision: 1 });

    // Allow once: the Mac's challenge, signed with the passkey.
    await phone.allowOnce("req-1");
    await vi.waitFor(() => expect(paired(phone.view)!.open!.asks.get("req-1")?.note).toBe("allowed"), { timeout: 5_000 });
    expect(passkeys.calls.at(-1)).toBe("get");
    // The Mac's change arrives as an event on the open chat.
    mac.publish();
    await vi.waitFor(() => expect(paired(phone.view)!.open!.view.asks.find((a) => a.id === "req-1")).toMatchObject({ open: false, outcome: "allowed" }), { timeout: 5_000 });

    // A second approval appears while the chat is open, and the person says No: no passkey for that.
    const second: SourceApproval = { kind: "approval", id: "req-2", ts: 1_800_000_300, open: true, title: "Delete the old price list", command: "rm prices-2025.csv", choices: ["once", "deny"] };
    chats.update("buddy", (items) => [...items, second]);
    mac.publish();
    await vi.waitFor(() => expect(paired(phone.view)!.open!.view.asks.some((a) => a.id === "req-2")).toBe(true), { timeout: 5_000 });
    const gets = passkeys.calls.length;
    await phone.no("req-2");
    expect(paired(phone.view)!.open!.asks.get("req-2")?.note).toBe("declined");
    expect(passkeys.calls.length).toBe(gets);

    // The question, and stopping the turn.
    await phone.answer("q-1", "Friday");
    expect(paired(phone.view)!.open!.asks.get("q-1")?.note).toBe("answered");
    await phone.stop();
    expect(paired(phone.view)!.open!.stopNote).toBe("stopped");
    expect(chats.done).toEqual([
      { action: "allowOnce", chat: "buddy", ask: "req-1", by: kept!.deviceId },
      { action: "decline", chat: "buddy", ask: "req-2", by: kept!.deviceId },
      { action: "answer", chat: "buddy", ask: "q-1", by: kept!.deviceId, answer: "Friday" },
      { action: "stop", chat: "buddy" },
    ]);

    // A drop: the view greys and offers nothing, and a message the Mac had meanwhile is there once it is back.
    phone.setOnline(false);
    expect(paired(phone.view)).toMatchObject({ link: "down", down: "offline" });
    await vi.waitFor(() => expect(mac.snapshot().phones[0]?.connected).toBe(false), { timeout: 5_000 });
    chats.update("buddy", (items) => [...items, { kind: "message", id: "m3", role: "assistant", text: "Sent while you were away", ts: 1_800_000_400 }]);
    mac.publish();
    phone.setOnline(true);
    await vi.waitFor(() => expect(paired(phone.view)!.open!.view.messages.map((m) => m.text)).toContain("Sent while you were away"), { timeout: 5_000 });
    expect(paired(phone.view)!.link).toBe("live");
    // And a later change arrives as an event again, on the new session's journal.
    chats.update("buddy", (items) => [...items, { kind: "message", id: "m4", role: "assistant", text: "One more thing", ts: 1_800_000_500 }]);
    mac.publish();
    await vi.waitFor(() => expect(paired(phone.view)!.open!.view.messages.at(-1)?.text).toBe("One more thing"), { timeout: 5_000 });

    // A request the phone may never make is refused by the Mac by name, and the phone has no way to make it anyway.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(phone))).not.toContain("allowAlways");

    // Unpair on the Mac: the phone hears it and stops dialling.
    await mac.unpair(kept!.deviceId);
    await vi.waitFor(() => expect(paired(phone.view)?.forgotten).toBe(true), { timeout: 5_000 });
    phone.dispose();
    mac.turnOff();

    // Nothing readable crossed: no chat's or ask's words, not the phone's name, not K, the code's secret, the passkey's
    // key or the Mac's relay key.
    const device = keyring.doc()?.devices ?? [];
    const k = fromHex(device[0]?.k ?? toHex(new Uint8Array(32)));
    const hostKey = keyring.doc()!.host!;
    const words = [PLAIN.title, PLAIN.message, PLAIN.reply, PLAIN.command, PLAIN.question, "Reading the price list", "Delete the old price list", "Sent while you were away", NAME, "Friday"];
    const keys = [k, pairingSecret];
    expect(carried.length).toBeGreaterThan(30);
    for (const { data } of carried) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const word of words) expect(contains(bytes, new TextEncoder().encode(word)), word).toBe(false);
      for (const key of keys) {
        expect(contains(bytes, key)).toBe(false);
        for (const text of [toHex(key), toB64Url(key)]) expect(contains(bytes, new TextEncoder().encode(text))).toBe(false);
      }
      expect(contains(bytes, new TextEncoder().encode(hostKey.d))).toBe(false);
    }
  }, 30_000);

  it("ends a pairing whose digits were typed wrong at the Mac, keeps nothing, and never starts that code again", async () => {
    const carried: Carried[] = [];
    const { mac } = await macOnRelay(carried);
    const passkeys = standInPasskeys(new TestAuthenticator(0xc2));
    const { phone, vault } = phoneOnRelay(carried, passkeys);
    await phone.start();
    const { link } = await pairThrough(mac, phone, (digits) => (digits === "0000" ? "0001" : "0000"));
    expect(phone.view).toEqual({ phase: "unpaired", failed: "ended" });
    expect(mac.snapshot().pairing).toEqual({ phase: "failed", reason: "wrong_code" });
    expect(passkeys.calls).toEqual([]);
    expect(await vault.load()).toBeNull();
    // The same code again, after the person went back: refused on the phone before anything is dialled.
    phone.again();
    const before = carried.length;
    await phone.pair(link);
    expect(phone.view).toEqual({ phase: "unpaired", failed: "used" });
    expect(carried.length).toBe(before);
    phone.dispose();
    mac.turnOff();
  });

  it("refuses a code the relay no longer has, after the Mac cancelled it", async () => {
    const carried: Carried[] = [];
    const { mac } = await macOnRelay(carried);
    const { phone } = phoneOnRelay(carried, standInPasskeys(new TestAuthenticator(0xc3)));
    await phone.start();
    expect(await mac.startPairing()).toBe(true);
    const code = mac.snapshot().pairing;
    if (code.phase !== "showing") throw new Error("no code");
    mac.cancelPairing();
    // Once the relay has the Mac's `revoke`, the code's door no longer opens.
    const door = readPairingLink(code.link);
    await vi.waitFor(async () => expect(await dialAs(mac.hostId!, door.doorId, toB64Url(door.doorToken))).toBe(4401), { timeout: 5_000 });
    await phone.pair(code.link);
    expect(phone.view).toEqual({ phase: "unpaired", failed: "door" });
    phone.dispose();
    mac.turnOff();
  });
});
