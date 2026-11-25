// "Pair a phone" on the Mac, end to end against a relay in memory and a phone built from the package (testkit/): the
// package's caller duties for pairing (packages/remote-channel/README.md, "What the callers must do") are each held here.
import { describe, expect, it } from "vitest";
import { REGISTRATION_TTL_MS } from "./pairing";
import { settle } from "./testkit/clock";
import { ORIGIN, RP, macHarness, pairPhone, turnOn, waitFor } from "./testkit/harness";
import { TestAuthenticator, TestPhone } from "./testkit/phone";

const DOOR_LIFETIME_MS = 120_000;

function revoked(h: ReturnType<typeof macHarness>): string[] {
  return h.relay.fromMacText.filter((m) => m.t === "revoke").map((m) => String(m.id));
}

describe("pairing a phone", () => {
  it("pairs with the four digits the phone shows, and counts the phone paired only once its passkey came back", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone, outcome } = await pairPhone(h, { name: "iPhone, Safari" });
    expect(outcome).toBe("paired");
    expect(h.views.map((v) => v.phase)).toEqual(["showing", "checking", "code", "finishing", "paired"]);
    const phones = h.remote.snapshot().phones;
    expect(phones).toEqual([{ id: phone.deviceId, name: "iPhone, Safari", pairedAt: h.clock.now, lastSeen: h.clock.now, connected: false }]);
    // The keychain holds the phone, and the relay lets it in with its own door; the pairing door is revoked.
    expect(h.keyring.doc()?.devices.map((d) => d.id)).toEqual([phone.deviceId]);
    expect([...h.relay.devices.keys()]).toEqual([phone.deviceId]);
    expect(revoked(h)).toHaveLength(1);
    expect(revoked(h)[0]).not.toBe(phone.deviceId);
  });

  it("links to the app on the API origin with the code in the fragment, for two minutes", async () => {
    const h = macHarness();
    await turnOn(h);
    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    expect(view.phase).toBe("showing");
    if (view.phase !== "showing") return;
    expect(view.link.startsWith(`${ORIGIN}/app/#pair=`)).toBe(true);
    expect(view.expiresAt).toBe(h.clock.now + DOOR_LIFETIME_MS);
    // The door is registered with the relay while the code shows.
    await waitFor(() => h.relay.devices.size === 1);
  });

  it("hides the QR code at the first commit, whatever the commit brings", async () => {
    const h = macHarness();
    await turnOn(h);
    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    // A phone that sends a broken commit still spends the code: the link is gone and the door with it.
    const { readPairingLink, toBase64Url } = await import("@manut/remote-channel");
    const offer = readPairingLink(view.link);
    const socket = h.relay.connectPhone(offer.hostId);
    socket.send(JSON.stringify({ t: "hello", v: 1, device: offer.doorId, token: toBase64Url(offer.doorToken) }));
    await settle();
    socket.send(new Uint8Array(34).fill(7));
    await waitFor(() => h.remote.snapshot().pairing.phase === "failed");
    expect(h.views.map((v) => v.phase)).toEqual(["showing", "checking", "failed"]);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "refused" });
    expect(revoked(h)).toEqual([offer.doorId]);
  });

  it("ends the pairing on a wrong code, says to start again, and takes no second try", async () => {
    const h = macHarness();
    await turnOn(h);
    let second: boolean | null = null;
    const phone = new TestPhone({ name: "Pixel", connect: h.relay.connectPhone });
    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    const outcome = await phone.pair(
      view.link,
      async (code) => {
        const wrong = String((Number(code) + 1) % 10_000).padStart(4, "0");
        expect(await h.remote.typeCode(wrong)).toBe(false);
        second = await h.remote.typeCode(code);
      },
      { rp: RP },
    ).catch(() => "closed");
    expect(outcome).not.toBe("paired");
    expect(second).toBe(false);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "wrong_code" });
    expect(h.remote.snapshot().phones).toEqual([]);
    expect(h.keyring.doc()?.devices ?? []).toEqual([]);
    expect(h.relay.devices.size).toBe(0);
  });

  it("refuses a code typed after its two minutes", async () => {
    const h = macHarness();
    await turnOn(h);
    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    const phone = new TestPhone({ name: "Pixel", connect: h.relay.connectPhone });
    await phone.pair(
      view.link,
      async (code) => {
        // Time passes on the Mac with its timer not yet run: the typed code itself is late.
        h.clock.now += DOOR_LIFETIME_MS;
        expect(await h.remote.typeCode(code)).toBe(false);
      },
      { rp: RP },
    ).catch(() => "closed");
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "expired" });
    expect(h.relay.devices.size).toBe(0);
  });

  it("revokes the door when the two minutes pass with no phone", async () => {
    const h = macHarness();
    await turnOn(h);
    await h.remote.startPairing();
    await waitFor(() => h.relay.devices.size === 1);
    const door = [...h.relay.devices.keys()][0];
    h.clock.advance(DOOR_LIFETIME_MS);
    await waitFor(() => h.relay.devices.size === 0);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "expired" });
    expect(revoked(h)).toEqual([door]);
  });

  it("refuses a second pairing while one is open, so only one door is ever open", async () => {
    const h = macHarness();
    await turnOn(h);
    expect(await h.remote.startPairing()).toBe(true);
    const first = h.remote.snapshot().pairing;
    expect(await h.remote.startPairing()).toBe(false);
    expect(h.remote.snapshot().pairing).toBe(first);
    await settle();
    expect(h.relay.fromMacText.filter((m) => m.t === "device")).toHaveLength(1);
    // Cancel ends it, and a new code can be shown.
    h.remote.cancelPairing();
    expect(h.remote.snapshot().pairing).toEqual({ phase: "idle" });
    expect(await h.remote.startPairing()).toBe(true);
  });

  it("does not keep a phone whose passkey never comes back", async () => {
    const h = macHarness();
    await turnOn(h);
    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    const { readPairingLink, startPairing, toBase64Url } = await import("@manut/remote-channel");
    const offer = readPairingLink(view.link);
    const socket = h.relay.connectPhone(offer.hostId);
    const frames: Uint8Array[] = [];
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) frames.push(new Uint8Array(event.data));
    };
    socket.send(JSON.stringify({ t: "hello", v: 1, device: offer.doorId, token: toBase64Url(offer.doorToken) }));
    await settle();
    const { commit, phone } = await startPairing(offer);
    socket.send(commit);
    await waitFor(() => frames.length === 1);
    socket.send(await phone.receiveKey(frames[0]!));
    await waitFor(() => frames.length === 2);
    const { checkCode } = await phone.receiveConfirm(frames[1]!);
    expect(await h.remote.typeCode(checkCode)).toBe(true);
    // The grant and the passkey request went out; the phone makes no passkey.
    await waitFor(() => frames.length === 4);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "finishing" });
    expect(h.remote.snapshot().phones).toEqual([]);
    h.clock.advance(REGISTRATION_TTL_MS);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "expired" });
    expect(h.keyring.doc()?.devices ?? []).toEqual([]);
    await waitFor(() => h.relay.devices.size === 0);
  });

  it("refuses a passkey made for another site, and one that already belongs to another phone", async () => {
    const h = macHarness();
    await turnOn(h);
    const shared = new TestAuthenticator(0xd4);
    expect((await pairPhone(h, { name: "First", authenticator: shared })).outcome).toBe("paired");
    expect((await pairPhone(h, { name: "Second", authenticator: shared })).outcome).toBe("taken");
    expect(h.remote.snapshot().phones.map((p) => p.name)).toEqual(["First"]);

    await h.remote.startPairing();
    const view = h.remote.snapshot().pairing;
    if (view.phase !== "showing") throw new Error("no code");
    const elsewhere = new TestPhone({ name: "Elsewhere", connect: h.relay.connectPhone, authenticator: new TestAuthenticator(0xe5) });
    const outcome = await elsewhere.pair(view.link, (code) => h.remote.typeCode(code), { rp: { id: "evil.example", origin: "https://evil.example" } });
    expect(outcome).toBe("refused");
    expect(h.remote.snapshot().phones.map((p) => p.name)).toEqual(["First"]);
  });

  it("keeps no more phones than the relay has places for, beside the door", async () => {
    const h = macHarness();
    await turnOn(h);
    for (let i = 0; i < 7; i++) expect((await pairPhone(h, { name: `Phone ${i}`, authenticator: new TestAuthenticator(0x10 + i) })).outcome).toBe("paired");
    expect(await h.remote.startPairing()).toBe(false);
    expect(h.remote.snapshot().pairing).toEqual({ phase: "failed", reason: "full" });
  });
});
