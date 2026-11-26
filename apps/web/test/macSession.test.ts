// One session with the paired Mac (src/app/mac/session.ts) and the relay socket under it (relay.ts): the phone's own
// door, the handshake proved with K, requests answered by their id, events apart, and every way a session ends, each of
// which closes the channel so the next session is a new handshake (packages/remote-channel/README.md).
import { importSharedSecret, newPairingGrant, toBase64Url } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { endOf, relayUrl } from "../src/app/mac/relay";
import { openSession } from "../src/app/mac/session";
import type { PairedMac } from "../src/app/mac/vault";
import { ManualClock, ORIGIN, Sockets, macSession, readJson, sayJson, settle } from "./macKit";

async function pairedMac(): Promise<{ mac: PairedMac; secrets: Map<string, CryptoKey> }> {
  const grant = newPairingGrant();
  const hostId = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const k = await importSharedSecret(grant.secret.slice());
  const macK = await importSharedSecret(grant.secret);
  return {
    mac: { hostId, deviceId: grant.deviceId, doorToken: grant.doorToken, k, credentialId: new Uint8Array(16), rpId: "phone.manut.test", pairedAt: 0 },
    secrets: new Map([[grant.deviceId, macK]]),
  };
}

describe("the relay socket", () => {
  it("dials this page's own origin only, wss for https and ws only for this machine", () => {
    const host = "A".repeat(43);
    expect(relayUrl("https://dev.manut.xyz", host)).toBe(`wss://dev.manut.xyz/relay/v1/hosts/${host}/phone`);
    expect(relayUrl("http://localhost:5417", host)).toBe(`ws://localhost:5417/relay/v1/hosts/${host}/phone`);
    expect(relayUrl("http://dev.manut.xyz", host)).toBeNull();
    expect(relayUrl("https://dev.manut.xyz", "not a host id")).toBeNull();
  });

  it("reads every close code the relay uses as why", () => {
    expect(endOf(4401, null)).toEqual({ why: "unknown_door" });
    expect(endOf(4403, null)).toEqual({ why: "revoked" });
    expect(endOf(4404, "sleeping")).toEqual({ why: "mac_away", state: "sleeping" });
    expect(endOf(4404, null)).toEqual({ why: "mac_away", state: "offline" });
    expect(endOf(4409, null)).toEqual({ why: "replaced" });
    expect(endOf(4429, null)).toEqual({ why: "busy" });
    expect(endOf(4503, null)).toEqual({ why: "relay_off" });
    expect(endOf(1000, null)).toEqual({ why: "closed" });
    expect(endOf(1006, null)).toEqual({ why: "lost" });
  });
});

describe("a session with the Mac", () => {
  it("says hello at its own door, proves K, and matches each answer to its request, with events apart", async () => {
    const { mac, secrets } = await pairedMac();
    const sockets = new Sockets();
    const opening = openSession({ origin: ORIGIN, connect: sockets.connect }, mac);
    const socket = await sockets.next();
    expect(await socket.hello()).toEqual({ t: "hello", v: 1, device: mac.deviceId, token: toBase64Url(mac.doorToken) });
    socket.deliver(JSON.stringify({ t: "ready", v: 1 }));
    const channel = await macSession(socket, { hostId: mac.hostId, secrets });
    const opened = await opening;
    if (!opened.ok) throw new Error(opened.end.why);
    const session = opened.session;
    const events: unknown[] = [];
    session.onEvent = (message) => events.push(message);
    const list = session.request({ t: "list" });
    const open = session.request({ t: "open", chat: "buddy" });
    const first = await readJson(socket, channel);
    const second = await readJson(socket, channel);
    expect(first).toEqual({ t: "list", id: 1 });
    expect(second).toEqual({ t: "open", chat: "buddy", id: 2 });
    // Answered out of order, with an event between: each lands where it belongs.
    await sayJson(socket, channel, { t: "chat", id: 2, view: {}, cursor: null });
    await sayJson(socket, channel, { t: "event", chat: "buddy", event: { k: "state" }, cursor: { journal: "j", seq: 1 } });
    await sayJson(socket, channel, { t: "chats", id: 1, chats: [] });
    expect(await list).toEqual({ t: "chats", id: 1, chats: [] });
    expect(await open).toMatchObject({ t: "chat", id: 2 });
    expect(events).toEqual([{ t: "event", chat: "buddy", event: { k: "state" }, cursor: { journal: "j", seq: 1 } }]);
    // The relay's `pong`, and a `host` before a close, are not frames.
    socket.deliver("pong");
    await settle();
    expect(session.ended).toBeNull();
    session.close();
    expect(session.ended).toEqual({ why: "closed" });
    expect(socket.closed).not.toBeNull();
  });

  it("ends on a record that does not open, on the relay closing the stream, and on an answer that never comes", async () => {
    const { mac, secrets } = await pairedMac();
    const open = async (clock?: ManualClock) => {
      const sockets = new Sockets();
      const opening = openSession({ origin: ORIGIN, connect: sockets.connect, ...(clock ? { timers: clock } : {}) }, mac);
      const socket = await sockets.next();
      await socket.hello();
      socket.deliver(JSON.stringify({ t: "ready", v: 1 }));
      const channel = await macSession(socket, { hostId: mac.hostId, secrets });
      const opened = await opening;
      if (!opened.ok) throw new Error(opened.end.why);
      const ends: string[] = [];
      opened.session.onEnd = (end) => ends.push(end.why);
      return { session: opened.session, socket, channel, ends };
    };

    // A record changed on the way: the channel refuses it, and the session ends.
    const tampered = await open();
    const pending = tampered.session.request({ t: "list" });
    await readJson(tampered.socket, tampered.channel);
    tampered.socket.deliver(Uint8Array.of(0x30, ...crypto.getRandomValues(new Uint8Array(40))));
    expect(await pending).toBeNull();
    expect(tampered.ends).toEqual(["refused"]);
    expect(tampered.socket.closed).not.toBeNull();

    // The relay closes the stream: the Mac unpaired this phone.
    const revoked = await open();
    revoked.socket.shut(4403, "revoked");
    await settle();
    expect(revoked.ends).toEqual(["revoked"]);
    expect(await revoked.session.request({ t: "list" })).toBeNull();

    // The Mac never answers: what it would have said is unknown, so the session ends.
    const clock = new ManualClock();
    const quiet = await open(clock);
    const waiting = quiet.session.request({ t: "list" });
    await readJson(quiet.socket, quiet.channel);
    clock.advance(20_000);
    expect(await waiting).toBeNull();
    expect(quiet.ends).toEqual(["lost"]);
  });

  it("reads a Mac that turns the hello away as refused, and the relay's refusals as theirs", async () => {
    const { mac } = await pairedMac();
    const sockets = new Sockets();
    const turned = openSession({ origin: ORIGIN, connect: sockets.connect }, mac);
    const socket = await sockets.next();
    await socket.hello();
    socket.deliver(JSON.stringify({ t: "ready", v: 1 }));
    await socket.frame();
    socket.shut(1000, "closed");
    expect(await turned).toEqual({ ok: false, end: { why: "refused" } });

    const away = openSession({ origin: ORIGIN, connect: sockets.connect }, mac);
    const second = await sockets.next();
    await second.hello();
    second.deliver(JSON.stringify({ t: "host", v: 1, state: "sleeping" }));
    second.shut(4404, "unavailable");
    expect(await away).toEqual({ ok: false, end: { why: "mac_away", state: "sleeping" } });
  });
});
