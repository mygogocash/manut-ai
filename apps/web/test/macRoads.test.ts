// The phone's roads to the Mac (item 78f-2c, docs/remote-access.md, "Which road"): the Mac's `road` message read only for a
// name the desktop would accept and the door's one port; the tailnet door dialled first and the relay after 1.5 seconds,
// or at once when the tailnet turns the phone away; the first to say ready carries the session and the other is closed;
// turned away by both, the relay's reason.
import { importSharedSecret, newPairingGrant, toBase64Url } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { TAILNET_PORT, tailnetUrl } from "../src/app/mac/relay";
import { TAILNET_HEAD_START_MS, dialRoads, readRoad } from "../src/app/mac/session";
import type { PairedMac } from "../src/app/mac/vault";
import { ManualClock, ORIGIN, Sockets, settle } from "./macKit";

const NAME = "mac.tail1234.ts.net";

async function mac(tailnet?: { name: string; port: number }): Promise<PairedMac> {
  const grant = newPairingGrant();
  return {
    hostId: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    deviceId: grant.deviceId,
    doorToken: grant.doorToken,
    k: await importSharedSecret(grant.secret),
    credentialId: new Uint8Array(16),
    rpId: "phone.manut.test",
    pairedAt: 0,
    ...(tailnet ? { tailnet } : {}),
  };
}

const READY = JSON.stringify({ t: "ready", v: 1 });

describe("the Mac's road message", () => {
  it("takes only a tailnet name the desktop would accept, on the door's one port, and null for none", () => {
    expect(readRoad({ t: "road", name: NAME, port: 47100 })).toEqual({ name: NAME, port: 47100 });
    expect(readRoad({ t: "road", name: null })).toBeNull();
    for (const bad of [
      { t: "road", name: NAME, port: 443 },
      { t: "road", name: "evil.example.com", port: 47100 },
      { t: "road", name: "x.ts.net.evil.com", port: 47100 },
      { t: "road", name: "MAC.tail1234.ts.net", port: 47100 },
      { t: "road", name: 3, port: 47100 },
      { t: "event", name: NAME, port: 47100 },
      null,
    ]) {
      expect(readRoad(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("dials the tailnet door only at that name and port, over wss", () => {
    const host = "A".repeat(43);
    expect(tailnetUrl({ name: NAME, port: TAILNET_PORT }, host)).toBe(`wss://${NAME}:47100/relay/v1/hosts/${host}/phone`);
    expect(tailnetUrl({ name: NAME, port: 8443 }, host)).toBeNull();
    expect(tailnetUrl({ name: "dev.manut.xyz", port: 47100 }, host)).toBeNull();
    expect(tailnetUrl({ name: NAME, port: 47100 }, "short")).toBeNull();
  });
});

describe("which road", () => {
  it("dials only the relay when no tailnet door is known", async () => {
    const sockets = new Sockets();
    const clock = new ManualClock();
    const m = await mac();
    const dialling = dialRoads({ origin: ORIGIN, connect: sockets.connect }, m, clock);
    const relay = await sockets.next();
    expect(relay.url).toContain("/relay/v1/hosts/");
    expect(relay.url).not.toContain("ts.net");
    relay.deliver(READY);
    expect((await dialling).ok).toBe(true);
  });

  it("tries the tailnet first, and a tailnet that answers in time carries the session with no relay dialled", async () => {
    const sockets = new Sockets();
    const clock = new ManualClock();
    const m = await mac({ name: NAME, port: 47100 });
    const dialling = dialRoads({ origin: ORIGIN, connect: sockets.connect }, m, clock);
    const tail = await sockets.next();
    expect(tail.url).toBe(`wss://${NAME}:47100/relay/v1/hosts/${m.hostId}/phone`);
    expect(await tail.hello()).toEqual({ t: "hello", v: 1, device: m.deviceId, token: toBase64Url(m.doorToken) });
    tail.deliver(READY);
    expect((await dialling).ok).toBe(true);
    clock.advance(TAILNET_HEAD_START_MS * 2);
    await settle();
    expect(sockets.opened.length).toBe(1);
  });

  it("starts the relay after the head start, and the road that loses is closed when it comes", async () => {
    const sockets = new Sockets();
    const clock = new ManualClock();
    const m = await mac({ name: NAME, port: 47100 });
    const dialling = dialRoads({ origin: ORIGIN, connect: sockets.connect }, m, clock);
    const tail = await sockets.next();
    clock.advance(TAILNET_HEAD_START_MS - 1);
    await settle();
    expect(sockets.opened.length).toBe(1);
    clock.advance(1);
    const relay = await sockets.next();
    expect(relay.url).not.toContain("ts.net");
    relay.deliver(READY);
    expect((await dialling).ok).toBe(true);
    tail.deliver(READY);
    await settle();
    expect(tail.closed).not.toBeNull();
    expect(relay.closed).toBeNull();
  });

  it("starts the relay at once when the tailnet turns the phone away, and says the relay's reason when both do", async () => {
    const sockets = new Sockets();
    const clock = new ManualClock();
    const m = await mac({ name: NAME, port: 47100 });
    const dialling = dialRoads({ origin: ORIGIN, connect: sockets.connect }, m, clock);
    const tail = await sockets.next();
    tail.shut(1006);
    const relay = await sockets.next();
    expect(relay.url).not.toContain("ts.net");
    relay.shut(4403);
    expect(await dialling).toEqual({ ok: false, end: { why: "revoked" } });
  });
});
