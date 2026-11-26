// The Mac's side put together (host.ts), against a relay in memory and a phone built from the package: built switched
// off, sessions only for a device the Mac holds K for, Unpair ending everything of that phone on the Mac itself (with or
// without a relay), and the switch ending everything.
import { acceptSession, startSession, toBase64Url } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { settle } from "./testkit/clock";
import { PLAIN } from "./testkit/chats";
import { macHarness, pairPhone, turnOn, waitFor } from "./testkit/harness";

describe("switched off", () => {
  it("opens no socket and makes no key until the switch is turned on", async () => {
    const h = macHarness();
    await h.remote.loadPhones();
    await settle();
    expect(h.relay.urls).toEqual([]);
    expect(h.keyring.doc()).toBeNull();
    expect(h.remote.snapshot()).toMatchObject({ on: false, link: "stopped", phones: [] });
    expect(await h.remote.startPairing()).toBe(false);
    await turnOn(h);
    const host = h.keyring.doc()?.host;
    expect(host).toBeTruthy();
    expect(h.relay.urls).toEqual([`wss://dev.manut.xyz/relay/v1/hosts/${h.remote.hostId}/socket`]);
    // The relay key is made once: turned off and on again, the Mac is the same host.
    h.remote.turnOff();
    await turnOn(h);
    expect(h.keyring.doc()?.host).toEqual(host);
  });

  it("opens no socket where the page may not reach the relay (Practice, another host)", async () => {
    for (const origin of [null, "https://api.example.com", "https://manut.xyz.example.com", "http://dev.manut.xyz"]) {
      const h = macHarness({ origin });
      await h.remote.turnOn();
      await settle();
      expect(h.remote.snapshot().link).toBe("no_origin");
      expect(h.relay.urls).toEqual([]);
      expect(h.keyring.doc()).toBeNull();
    }
  });
});

describe("sessions", () => {
  it("opens a session only with K, and lists the chats", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    await waitFor(() => h.remote.snapshot().phones[0]?.connected === true);
    expect(await session.request({ t: "list" })).toMatchObject({ t: "chats", chats: [{ chat: "buddy", title: PLAIN.title }, { chat: "kit" }] });
  });

  it("refuses a hello from a device it holds no K for, and sends nothing back", async () => {
    const h = macHarness();
    await turnOn(h);
    const stranger = "11111111-2222-4333-8444-555555555555";
    const token = new Uint8Array(32).fill(3);
    h.relay.devices.set(stranger, toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", token))));
    const socket = h.relay.connectPhone(h.remote.hostId!);
    const got: unknown[] = [];
    let closed: number | null = null;
    socket.onmessage = (event) => got.push(event.data);
    socket.onclose = (event) => (closed = event.code);
    socket.send(JSON.stringify({ t: "hello", v: 1, device: stranger, token: toBase64Url(token) }));
    await settle();
    const { hello } = await startSession({ hostId: h.remote.hostId!, deviceId: stranger, secret: new Uint8Array(32).fill(5) });
    socket.send(hello);
    await waitFor(() => closed !== null);
    // Only the relay's own `ready` arrived: no welcome.
    expect(got).toEqual([JSON.stringify({ t: "ready", v: 1 })]);
    expect(closed).toBe(1000);
  });

  it("refuses a session whose phone proves the wrong K", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const { token } = phone.secrets();
    const socket = h.relay.connectPhone(h.remote.hostId!);
    const frames: Uint8Array[] = [];
    let closed = false;
    socket.onmessage = (event) => event.data instanceof ArrayBuffer && frames.push(new Uint8Array(event.data));
    socket.onclose = () => (closed = true);
    socket.send(JSON.stringify({ t: "hello", v: 1, device: phone.deviceId, token }));
    await settle();
    const { hello, phone: handshake } = await startSession({ hostId: h.remote.hostId!, deviceId: phone.deviceId!, secret: new Uint8Array(32).fill(6) });
    socket.send(hello);
    await waitFor(() => frames.length === 1);
    // The phone cannot check the Mac's proof with the wrong K, and a made-up finish closes the stream on the Mac.
    await expect(handshake.receiveWelcome(frames[0]!)).rejects.toThrow();
    socket.send(Uint8Array.of(0x22, 0x01, ...new Uint8Array(32)));
    await waitFor(() => closed);
    expect(h.remote.snapshot().phones[0]?.connected).toBe(false);
    // acceptSession itself would have refused an unknown device before sending anything.
    await expect(acceptSession(hello, { hostId: h.remote.hostId!, secretFor: () => undefined })).rejects.toThrow();
  });
});

describe("Unpair", () => {
  it("closes the phone's channels on the Mac, drops its challenges, forgets its K and revokes it on the relay", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    expect(await session.request({ t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "challenge" });
    expect(h.remote.challenges.size).toBe(1);
    await h.remote.unpair(phone.deviceId!);
    expect(h.remote.challenges.size).toBe(0);
    expect(h.remote.snapshot().phones).toEqual([]);
    expect(h.keyring.doc()?.devices).toEqual([]);
    await waitFor(() => session.inbox.closed !== null);
    expect(session.channel.isClosed).toBe(false);
    await waitFor(() => !h.relay.devices.has(phone.deviceId!));
    expect(h.relay.fromMacText.filter((m) => m.t === "revoke").map((m) => m.id)).toContain(phone.deviceId);
    // A new session from it is refused: the relay shuts its door, and the Mac holds no K for it anyway.
    await expect(phone.connect()).rejects.toThrow();
  });

  it("takes effect on the Mac with the relay unreachable, and revokes on the relay once it is back", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    await waitFor(() => h.remote.snapshot().phones[0]?.connected === true);
    // The relay goes away with the stream still open on the Mac's side as far as the phone knows.
    h.relay.reachable = false;
    h.relay.cut();
    await waitFor(() => h.remote.snapshot().link === "waiting");
    // The first wait after a drop is one second.
    expect(h.clock.pending()).toEqual([1_000]);
    await h.remote.unpair(phone.deviceId!);
    expect(h.remote.snapshot().phones).toEqual([]);
    expect(h.keyring.doc()?.devices).toEqual([]);
    expect(h.relay.devices.has(phone.deviceId!)).toBe(true);
    // Back: at `ready` the relay still lists the phone, and the Mac revokes it.
    h.relay.reachable = true;
    h.clock.advance(1_000);
    await waitFor(() => h.remote.snapshot().link === "ready");
    await waitFor(() => !h.relay.devices.has(phone.deviceId!));
    expect(session.inbox.closed).not.toBeNull();
  });
  it("ends the phone's sessions before the keychain write, so a relay that ignores the revoke gets it no new session and no event", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const first = await phone.connect();
    await first.request({ t: "open", chat: "buddy" });
    h.relay.hostile = true;
    // The keychain takes its time to forget the phone.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const remove = h.keyring.removeDevice;
    h.keyring.removeDevice = async (id) => {
      await held;
      return remove(id);
    };
    const unpairing = h.remote.unpair(phone.deviceId!);
    // While the keychain write waits, the phone dials again through the relay that ignored the revoke, and asks.
    const again = await phone.connect().catch(() => null);
    const asked = again ? await again.request({ t: "open", chat: "buddy" }, 500).catch(() => null) : null;
    release();
    await unpairing;
    // The store changes and the Mac tells the phones watching: nothing reaches the unpaired phone.
    h.chats.update("buddy", (items) => [...items, { kind: "message", id: "m9", role: "assistant", text: "After the unpair", ts: 1_800_000_900 }]);
    h.remote.publish();
    await settle();
    const heard = again ? await again.pushed(1, 300).catch(() => []) : [];
    expect({ session: again !== null, asked: asked?.t ?? null, heard: heard.length }).toEqual({ session: false, asked: null, heard: 0 });
    expect(h.remote.snapshot().phones).toEqual([]);
    expect(h.relay.openPhones).toBe(0);
  });
});

describe("turning the switch off", () => {
  it("ends the pairing, every session, every challenge and journal, and the socket", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    await session.request({ t: "open", chat: "buddy" });
    await session.request({ t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    expect(await h.remote.startPairing()).toBe(true);
    expect(h.remote.challenges.size).toBe(1);
    expect(h.remote.server?.journal.isOpen("buddy")).toBe(true);
    const server = h.remote.server!;
    h.remote.turnOff();
    expect(h.remote.snapshot()).toMatchObject({ on: false, link: "stopped", pairing: { phase: "idle" } });
    expect(h.remote.challenges.size).toBe(0);
    expect(server.journal.isOpen("buddy")).toBe(false);
    expect(h.remote.server).toBeNull();
    await waitFor(() => !h.relay.macConnected);
    await waitFor(() => session.inbox.closed !== null);
    expect(h.relay.presence).toBe("off");
    // The phone stays paired for when the switch comes back.
    expect(h.remote.snapshot().phones.map((p) => p.id)).toEqual([phone.deviceId]);
    // Nothing reconnects by itself.
    h.clock.advance(60 * 60_000);
    await settle();
    expect(h.relay.urls).toHaveLength(1);
  });
});

describe("what crosses the relay", () => {
  it("carries no chat's or ask's words, no phone's name and no key in a form anyone can read", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h, { name: "Somchai's iPhone" });
    const session = await phone.connect();
    await session.request({ t: "list" });
    await session.request({ t: "open", chat: "buddy" });
    expect(await phone.allow(session, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
    expect(await phone.answer(session, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Saturday" })).toMatchObject({ t: "done" });
    expect(h.chats.done.at(-1)).toEqual({ action: "answer", chat: "buddy", ask: "q-1", by: phone.deviceId, answer: "Saturday" });
    const { secret } = phone.secrets();
    const words = [PLAIN.title, PLAIN.message, PLAIN.reply, PLAIN.command, PLAIN.question, "Somchai"];
    const contains = (hay: Uint8Array, needle: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    };
    const hex = Array.from(secret!, (b) => b.toString(16).padStart(2, "0")).join("");
    for (const { data } of h.relay.carried) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      for (const word of words) expect(contains(bytes, new TextEncoder().encode(word)), word).toBe(false);
      for (const key of [secret!, new TextEncoder().encode(hex), new TextEncoder().encode(toBase64Url(secret!))]) expect(contains(bytes, key)).toBe(false);
      expect(contains(bytes, new TextEncoder().encode(h.keyring.doc()!.host!.d))).toBe(false);
    }
  });
});
