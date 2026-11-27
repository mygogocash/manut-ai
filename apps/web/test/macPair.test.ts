// Pairing, the phone's side (src/app/mac/pair.ts): each of the phone's duties from packages/remote-channel/README.md,
// "What the callers must do", and each way a pairing ends, against a relay socket whose Mac the test plays step by step
// from the package's own Mac side. The desktop's real Mac pairs with this code through the real relay in
// apps/api/test/remote-phone.test.ts.
import {
  type MacPairing,
  encodePairingGrant,
  fromBase64Url,
  macPairing,
  newPairingGrant,
  newPairingOffer,
  pairingLink,
  toBase64Url,
  verifyPasskeyRegistration,
} from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { type PairDeps, type PairStep, pairWithMac, phoneName, readCode } from "../src/app/mac/pair";
import { PasskeyCancelled } from "../src/app/mac/passkeys";
import { memoryVault } from "../src/app/mac/vault";
import { ORIGIN, RP, type ScriptedSocket, Sockets, StandInPasskeys, pairingCode, readJson, sayJson, settle } from "./macKit";

const NOW = 1_800_000_000_000;

function setup(over: Partial<PairDeps> = {}) {
  const sockets = new Sockets();
  const vault = memoryVault();
  const passkeys = new StandInPasskeys();
  const deps: PairDeps = { origin: ORIGIN, rpId: RP.id, connect: sockets.connect, vault, passkeys, name: "iPhone, Safari", label: "Your Mac", now: () => NOW, ...over };
  return { sockets, vault, passkeys, deps };
}

/// A pairing under way, with every step the phone showed.
function start(deps: PairDeps, link: string) {
  const steps: PairStep[] = [];
  const result = pairWithMac(deps, link, (step) => steps.push(step));
  return { steps, result };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("waited too long");
}

/// The relay lets the door in, and the Mac answers the commit and the proof: the phone has its digits.
async function throughDigits(socket: ScriptedSocket, mac: MacPairing): Promise<{ t: string; device: string; token: string }> {
  const hello = await socket.hello();
  socket.deliver(JSON.stringify({ t: "ready", v: 1 }));
  socket.deliver(await mac.receiveCommit(await socket.frame(), NOW));
  const { confirm } = await mac.receiveProof(await socket.frame(), NOW);
  socket.deliver(confirm);
  return hello;
}

const digitsOf = (steps: PairStep[]) => steps.flatMap((s) => (s.step === "digits" ? [s.digits] : []))[0] ?? null;
const passkeyStep = (steps: PairStep[]) => [...steps].reverse().find((s): s is Extract<PairStep, { step: "passkey" }> => s.step === "passkey") ?? null;

describe("pairing a phone", () => {
  it("dials the code's door, shows the digits only after the Mac's proof, sends nothing before the grant, and is kept only once the Mac says paired", async () => {
    const { sockets, vault, passkeys, deps } = setup();
    const { link, offer } = pairingCode();
    const door = { id: offer.doorId, token: toBase64Url(offer.doorToken) };
    const mac = macPairing(offer, NOW);
    const { steps, result } = start(deps, link);
    const socket = await sockets.next();
    expect(socket.url).toBe(`wss://phone.manut.test/relay/v1/hosts/${offer.hostId}/phone`);
    expect(await throughDigits(socket, mac)).toEqual({ t: "hello", v: 1, device: door.id, token: door.token });
    await until(() => digitsOf(steps) !== null);
    expect(steps.map((s) => s.step)).toEqual(["connecting", "digits"]);
    // The code was spent before the relay was dialled.
    expect(vault.spent).toEqual([door.id]);
    // Only the commit and the proof went out: nothing on the pairing channel until the grant.
    await settle();
    expect(socket.frames().length).toBe(2);

    // The person types the four digits at the Mac; the Mac sends the grant and its passkey request.
    const channel = mac.allow(digitsOf(steps)!, NOW);
    const grant = newPairingGrant();
    const deviceId = grant.deviceId;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    for (const frame of await channel.seal(encodePairingGrant(grant))) socket.deliver(frame);
    await sayJson(socket, channel, { t: "passkey", challenge: toBase64Url(challenge), rp: { id: RP.id }, user: deviceId });
    await until(() => passkeyStep(steps) !== null);
    expect(passkeys.created).toEqual([]);
    // The passkey is made from the person's tap, for this host and this phone's device id.
    passkeyStep(steps)!.make();
    const registered = await readJson(socket, channel);
    expect(passkeys.created).toEqual([{ rpId: RP.id, challenge, userId: deviceId }]);
    expect(registered.t).toBe("registered");
    expect(registered.name).toBe("iPhone, Safari");
    const checked = await verifyPasskeyRegistration(
      {
        credentialId: fromBase64Url(registered.credentialId as string),
        clientDataJSON: fromBase64Url(registered.clientDataJSON as string),
        authenticatorData: fromBase64Url(registered.authenticatorData as string),
      },
      { challenge, rp: RP },
    );
    expect(checked.ok).toBe(true);
    // Not kept until the Mac says so.
    await settle();
    expect(await vault.load()).toBeNull();
    await sayJson(socket, channel, { t: "paired" });
    const done = await result;
    if (!done.ok) throw new Error(done.why);
    expect(done.mac).toMatchObject({ hostId: offer.hostId, deviceId, rpId: RP.id, pairedAt: NOW });
    expect(done.mac.k.extractable).toBe(false);
    expect(done.mac.credentialId).toEqual(passkeys.credentialId);
    expect(await vault.load()).toBe(done.mac);
    expect(steps.map((s) => s.step)).toEqual(["connecting", "digits", "passkey", "finishing"]);
    expect(socket.closed).not.toBeNull();
  });

  it("is one try: a code started once is refused before anything is dialled, after a failure, after a reload and in a second tab", async () => {
    const { sockets, vault, deps } = setup();
    const { link } = pairingCode();
    const first = start(deps, link);
    (await sockets.next()).shut(4401, "unauthenticated");
    expect(await first.result).toEqual({ ok: false, why: "door" });
    // The same code again on this phone: the vault says it was started.
    expect(await start(deps, link).result).toEqual({ ok: false, why: "used" });
    // A reload keeps the vault: a fresh start is refused the same way.
    expect(await pairWithMac({ ...deps }, link, () => undefined)).toEqual({ ok: false, why: "used" });
    expect(sockets.opened.length).toBe(1);

    // Two tabs pressing Pair on one new code at once: only one dials.
    const other = pairingCode();
    const a = start(deps, other.link);
    const b = start(deps, other.link);
    const both = await Promise.race([a.result, b.result]);
    expect(both).toEqual({ ok: false, why: "used" });
    expect(sockets.opened.length).toBe(2);
    sockets.opened[1]!.shut(1006);
    await Promise.all([a.result, b.result]);
    expect(vault.spent.length).toBe(2);
  });

  it("refuses what is not a code, a link for another address, and a browser with no passkeys, before spending or dialling anything", async () => {
    const { link } = pairingCode();
    const plain = setup();
    expect(await start(plain.deps, "hello").result).toEqual({ ok: false, why: "bad_link" });
    expect(await start(plain.deps, link.replace(ORIGIN, "https://manut.xyz")).result).toEqual({ ok: false, why: "other_site" });
    expect(await start(plain.deps, link.replace("#pair=", "?pair=")).result).toEqual({ ok: false, why: "bad_link" });
    const none = setup({ passkeys: new StandInPasskeys(false) });
    expect(await start(none.deps, link).result).toEqual({ ok: false, why: "no_passkeys" });
    expect(plain.sockets.opened.length + none.sockets.opened.length).toBe(0);
    expect(plain.vault.spent.length + none.vault.spent.length).toBe(0);
    // The bare code, without the address, reads too.
    expect(readCode(link.slice(link.indexOf("#pair=") + 6), ORIGIN)).toMatchObject({ hostId: expect.any(String) });
  });

  it("shows no digits when the Mac's proof does not check out", async () => {
    const { sockets, deps } = setup();
    const { link, offer } = pairingCode();
    const mac = macPairing(offer, NOW);
    const { steps, result } = start(deps, link);
    const socket = await sockets.next();
    await socket.hello();
    socket.deliver(JSON.stringify({ t: "ready", v: 1 }));
    socket.deliver(await mac.receiveCommit(await socket.frame(), NOW));
    await socket.frame();
    // A confirm with the right header and the wrong proof: someone without the code's secret.
    socket.deliver(Uint8Array.of(0x13, 0x01, ...crypto.getRandomValues(new Uint8Array(32))));
    expect(await result).toEqual({ ok: false, why: "ended" });
    expect(digitsOf(steps)).toBeNull();
    expect(socket.closed).not.toBeNull();
  });

  it("says why the relay turned the code away", async () => {
    for (const [code, host, why] of [
      [4503, null, "relay_off"],
      [4404, "off", "mac_away"],
      [4429, null, "unreachable"],
      [1006, null, "unreachable"],
    ] as const) {
      const { sockets, deps } = setup();
      const { result } = start(deps, pairingCode().link);
      const socket = await sockets.next();
      await socket.hello();
      if (host) socket.deliver(JSON.stringify({ t: "host", v: 1, state: host }));
      socket.shut(code);
      expect(await result).toEqual({ ok: false, why });
    }
  });

  it("ends when the Mac ends the pairing during the digits, with no passkey prompt and nothing kept", async () => {
    const { sockets, vault, passkeys, deps } = setup();
    const { link, offer } = pairingCode();
    const mac = macPairing(offer, NOW);
    const { steps, result } = start(deps, link);
    const socket = await sockets.next();
    await throughDigits(socket, mac);
    await until(() => digitsOf(steps) !== null);
    // A wrong code typed at the Mac: the Mac closes the door's stream.
    socket.shut(1000, "closed");
    expect(await result).toEqual({ ok: false, why: "ended" });
    expect(passkeys.created).toEqual([]);
    expect(await vault.load()).toBeNull();
  });

  it("refuses a passkey request for another site or another phone, with no prompt", async () => {
    for (const request of [
      (device: string, challenge: string) => ({ t: "passkey", challenge, rp: { id: "manut.xyz" }, user: device }),
      (_device: string, challenge: string) => ({ t: "passkey", challenge, rp: { id: RP.id }, user: "00000000-0000-4000-8000-000000000000" }),
      (device: string) => ({ t: "passkey", challenge: "short", rp: { id: RP.id }, user: device }),
      () => ({ t: "paired" }),
    ]) {
      const { sockets, vault, passkeys, deps } = setup();
      const { link, offer } = pairingCode();
      const mac = macPairing(offer, NOW);
      const { steps, result } = start(deps, link);
      const socket = await sockets.next();
      await throughDigits(socket, mac);
      await until(() => digitsOf(steps) !== null);
      const channel = mac.allow(digitsOf(steps)!, NOW);
      const grant = newPairingGrant();
      for (const frame of await channel.seal(encodePairingGrant(grant))) socket.deliver(frame);
      await sayJson(socket, channel, request(grant.deviceId, toBase64Url(crypto.getRandomValues(new Uint8Array(32)))));
      expect(await result).toEqual({ ok: false, why: "ended" });
      expect(passkeys.created).toEqual([]);
      expect(await vault.load()).toBeNull();
    }
  });

  it("keeps nothing when the Mac refuses the passkey, and lets the person press again after closing the prompt", async () => {
    const { sockets, vault, passkeys, deps } = setup();
    passkeys.refuse.push(new PasskeyCancelled());
    const { link, offer } = pairingCode();
    const mac = macPairing(offer, NOW);
    const { steps, result } = start(deps, link);
    const socket = await sockets.next();
    await throughDigits(socket, mac);
    await until(() => digitsOf(steps) !== null);
    const channel = mac.allow(digitsOf(steps)!, NOW);
    const grant = newPairingGrant();
    for (const frame of await channel.seal(encodePairingGrant(grant))) socket.deliver(frame);
    await sayJson(socket, channel, { t: "passkey", challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), rp: { id: RP.id }, user: grant.deviceId });
    await until(() => passkeyStep(steps) !== null);
    passkeyStep(steps)!.make();
    // The prompt was closed: the same step again, said as closed, and nothing sent.
    await until(() => passkeyStep(steps)?.cancelled === true);
    expect(socket.frames().length).toBe(2);
    passkeyStep(steps)!.make();
    await readJson(socket, channel);
    expect(passkeys.created.length).toBe(2);
    // This passkey belongs to another phone the Mac has.
    await sayJson(socket, channel, { t: "refused", reason: "taken" });
    expect(await result).toEqual({ ok: false, why: "taken" });
    expect(await vault.load()).toBeNull();
  });
});

describe("the phone's name for the Mac's list", () => {
  it("names the kind of phone and the browser, and nothing more", () => {
    expect(phoneName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1")).toBe("iPhone, Safari");
    expect(phoneName("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36")).toBe("Android phone, Chrome");
    expect(phoneName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1")).toBe("iPhone, Chrome");
    expect(phoneName("")).toBe("Phone, browser");
  });
});

describe("a code that names the Mac's tailnet (item 78f-2d)", () => {
  it("dials the pairing door over the tailnet first, and keeps the Mac's tailnet door with the paired Mac", async () => {
    const { sockets, vault, passkeys, deps } = setup();
    const hostId = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const offer = newPairingOffer(hostId, undefined, "mac.tail1234.ts.net");
    const link = pairingLink(`${ORIGIN}/app/`, offer);
    const mac = macPairing(offer, NOW);
    const { steps, result } = start(deps, link);
    const socket = await sockets.next();
    expect(socket.url).toBe(`wss://mac.tail1234.ts.net:47100/relay/v1/hosts/${hostId}/phone`);
    await throughDigits(socket, mac);
    await until(() => digitsOf(steps) !== null);
    const channel = mac.allow(digitsOf(steps)!, NOW);
    const grant = newPairingGrant();
    for (const frame of await channel.seal(encodePairingGrant(grant))) socket.deliver(frame);
    await sayJson(socket, channel, { t: "passkey", challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))), rp: { id: RP.id }, user: grant.deviceId });
    await until(() => passkeyStep(steps) !== null);
    passkeyStep(steps)!.make();
    await readJson(socket, channel);
    await sayJson(socket, channel, { t: "paired" });
    const done = await result;
    if (!done.ok) throw new Error(done.why);
    expect(done.mac.tailnet).toEqual({ name: "mac.tail1234.ts.net", port: 47100 });
    expect((await vault.load())?.tailnet).toEqual({ name: "mac.tail1234.ts.net", port: 47100 });
    // the relay was never needed: one socket, the tailnet's
    expect(sockets.opened).toHaveLength(1);
    expect(passkeys.created).toHaveLength(1);
  });
});

