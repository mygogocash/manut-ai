import { describe, expect, it } from "vitest";
import { type Bytes, acceptSession, importSharedSecret, startSession } from "../src/index";
import { ephemeralKeyPair, exportPublicKey } from "../src/testing";
import { DEVICE_ID, HOST_ID, OTHER_DEVICE_ID, OTHER_HOST_ID, bytesOf, flipBit, openSession, read, refusal, text } from "./support";

/// Each connection's handshake (ported from GoSpark's hello proof, `RemoteAuthentication.proof`,
/// and its tests in `RemoteAuthenticationTests.identityProof`): a fresh ECDH exchange proved with
/// K, so every session has new keys and only the holders of K can finish one. The relay carries
/// every byte here and may change, swap, drop or replay any of them.

const K = bytesOf(32, 0x4b);
const WRONG_K = bytesOf(32, 0x4c);

/// One handshake with a relay that may rewrite each message on its way. Returns which side
/// refused, or "none" when both ended with a channel.
async function handshake(relay: {
  hello?: (bytes: Bytes) => Bytes;
  welcome?: (bytes: Bytes) => Bytes;
  finish?: (bytes: Bytes) => Bytes;
  phoneSecret?: Uint8Array;
  macSecret?: Uint8Array;
  phoneHost?: string;
  macHost?: string;
}): Promise<"mac at hello" | "phone at welcome" | "mac at finish" | "none"> {
  const started = await startSession({ hostId: relay.phoneHost ?? HOST_ID, deviceId: DEVICE_ID, secret: relay.phoneSecret ?? K });
  let accepted;
  try {
    // The Mac hands out K for any device id here, so a refusal must come from the transcript and
    // the proofs, not from looking up an unknown device.
    accepted = await acceptSession((relay.hello ?? ((b) => b))(started.hello), {
      hostId: relay.macHost ?? HOST_ID,
      secretFor: () => relay.macSecret ?? K,
    });
  } catch {
    return "mac at hello";
  }
  let finish;
  try {
    ({ finish } = await started.phone.receiveWelcome((relay.welcome ?? ((b) => b))(accepted.welcome)));
  } catch {
    return "phone at welcome";
  }
  try {
    await accepted.mac.receiveFinish((relay.finish ?? ((b) => b))(finish));
  } catch {
    return "mac at finish";
  }
  return "none";
}

describe("the session handshake", () => {
  it("opens a session when both sides hold K, and both directions carry messages", async () => {
    const { phone, mac } = await openSession(K);
    expect(mac.deviceId).toBe(DEVICE_ID);
    expect(phone.deviceId).toBe(DEVICE_ID);
    for (const frame of await phone.seal(text("hello from the phone"))) expect(read(await mac.open(frame))).toBe("hello from the phone");
    for (const frame of await mac.seal(text("hello from the Mac"))) expect(read(await phone.open(frame))).toBe("hello from the Mac");
  });

  it("takes K as a key script cannot read back, as the desktop and the phone keep it, and refuses one it could", async () => {
    const secret = await importSharedSecret(K);
    expect(secret.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", secret)).rejects.toThrow();
    // Web Crypto never makes an exportable HKDF key, so an exportable stand-in and an exportable
    // key of another kind show the check: a key script could read back is refused either way.
    await expect(crypto.subtle.importKey("raw", K, "HKDF", true, ["deriveBits"])).rejects.toThrow();
    const standIn = { type: "secret", extractable: true, algorithm: { name: "HKDF" }, usages: ["deriveBits"] } as unknown as CryptoKey;
    const hmacKey = await crypto.subtle.importKey("raw", K, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
    for (const readable of [standIn, hmacKey]) {
      expect(await refusal(() => startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: readable }))).toBe("invalid");
      const hello = (await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret })).hello;
      expect(await refusal(() => acceptSession(hello, { hostId: HOST_ID, secretFor: () => readable }))).toBe("invalid");
    }
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: async () => secret });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    const mac = await accepted.mac.receiveFinish(finish);
    expect(mac.deviceId).toBe(DEVICE_ID);
  });

  it("a session opened with the wrong K is refused, whichever side holds the wrong one", async () => {
    expect(await handshake({ phoneSecret: WRONG_K })).toBe("phone at welcome");
    expect(await handshake({ macSecret: WRONG_K })).toBe("phone at welcome");
    // The Mac's own check of the phone's proof, without leaning on the phone refusing first: a
    // finish that is any other 32 bytes is refused.
    expect(await handshake({ finish: (bytes) => flipBit(bytes, bytes.length - 1) })).toBe("mac at finish");
  });

  it("a relay that swaps the phone's key is refused", async () => {
    const relayKey = await exportPublicKey(await ephemeralKeyPair());
    const swap = (hello: Bytes) => {
      const changed = hello.slice();
      changed.set(relayKey, 2 + 16);
      return changed;
    };
    expect(await handshake({ hello: swap })).toBe("phone at welcome");
  });

  it("a relay that swaps the Mac's key is refused", async () => {
    const relayKey = await exportPublicKey(await ephemeralKeyPair());
    const swap = (welcome: Bytes) => {
      const changed = welcome.slice();
      changed.set(relayKey, 2);
      return changed;
    };
    expect(await handshake({ welcome: swap })).toBe("phone at welcome");
  });

  it("a hello with any one byte changed is refused", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    for (let index = 0; index < started.hello.length; index++) {
      expect(await handshake({ hello: (bytes) => flipBit(bytes, index) }), `hello byte ${index}`).not.toBe("none");
    }
  });

  it("a welcome with any one byte changed is refused", async () => {
    for (let index = 0; index < 99; index++) {
      expect(await handshake({ welcome: (bytes) => flipBit(bytes, index) }), `welcome byte ${index}`).toBe("phone at welcome");
    }
  });

  it("a finish with any one byte changed is refused", async () => {
    for (let index = 0; index < 34; index++) {
      expect(await handshake({ finish: (bytes) => flipBit(bytes, index) }), `finish byte ${index}`).toBe("mac at finish");
    }
  });

  it("the Mac's own proof sent back as the phone's finish is refused", async () => {
    let macProof: Bytes | undefined;
    const outcome = await handshake({
      welcome: (bytes) => {
        macProof = bytes.slice(67);
        return bytes;
      },
      finish: (bytes) => Uint8Array.from([...bytes.slice(0, 2), ...(macProof ?? [])]) as Bytes,
    });
    expect(outcome).toBe("mac at finish");
  });

  it("a hello and finish replayed from an earlier session cannot open a new one", async () => {
    const first = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const firstAccepted = await acceptSession(first.hello, { hostId: HOST_ID, secretFor: () => K });
    const { finish: recordedFinish } = await first.phone.receiveWelcome(firstAccepted.welcome);
    await firstAccepted.mac.receiveFinish(recordedFinish);

    // The relay plays the recorded hello again. The Mac answers with a fresh key of its own, so
    // the recorded finish proves nothing about this new transcript.
    const replayed = await acceptSession(first.hello, { hostId: HOST_ID, secretFor: () => K });
    expect(await refusal(() => replayed.mac.receiveFinish(recordedFinish))).toBe("unauthenticated");
  });

  it("a welcome replayed from an earlier session is refused by the phone", async () => {
    const first = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const recordedWelcome = (await acceptSession(first.hello, { hostId: HOST_ID, secretFor: () => K })).welcome;
    const second = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    expect(await refusal(() => second.phone.receiveWelcome(recordedWelcome))).toBe("unauthenticated");
  });

  it("a phone that dialled another Mac's relay cannot open a session with this one, even with the same K", async () => {
    expect(await handshake({ phoneHost: OTHER_HOST_ID })).toBe("phone at welcome");
  });

  it("a device the Mac does not know is refused before the Mac sends anything", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: OTHER_DEVICE_ID, secret: K });
    const known = (id: string) => (id === DEVICE_ID ? K : undefined);
    expect(await refusal(() => acceptSession(started.hello, { hostId: HOST_ID, secretFor: known }))).toBe("unknown_device");
  });

  it("the device is the one the hello proved, so a relay's claim never names it", async () => {
    // The relay's `open` message names a device too (relay-object.ts); the Mac reads the device
    // from the proved hello only (GoSpark's RT-9). A hello for another device with that device's
    // K opens a session for that device and no other.
    const other = bytesOf(32, 0x77);
    const started = await startSession({ hostId: HOST_ID, deviceId: OTHER_DEVICE_ID, secret: other });
    const accepted = await acceptSession(started.hello, {
      hostId: HOST_ID,
      secretFor: (id) => (id === OTHER_DEVICE_ID ? other : id === DEVICE_ID ? K : undefined),
    });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    expect((await accepted.mac.receiveFinish(finish)).deviceId).toBe(OTHER_DEVICE_ID);
  });

  it("a key that is not a point on P-256 is refused", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const offCurve = started.hello.slice();
    offCurve.fill(0, 2 + 16 + 1);
    offCurve[2 + 16 + 64] = 1;
    expect(await refusal(() => acceptSession(offCurve, { hostId: HOST_ID, secretFor: () => K }))).toBe("malformed");
    const compressed = Uint8Array.from([...started.hello.slice(0, 18), 0x02, ...started.hello.slice(19)]) as Bytes;
    expect(await refusal(() => acceptSession(compressed, { hostId: HOST_ID, secretFor: () => K }))).toBe("malformed");
  });

  it("refuses a message of the wrong length, type or version", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const accept = (hello: Uint8Array) => acceptSession(hello, { hostId: HOST_ID, secretFor: () => K });
    expect(await refusal(() => accept(started.hello.slice(0, 82)))).toBe("malformed");
    expect(await refusal(() => accept(Uint8Array.from([...started.hello, 0])))).toBe("malformed");
    expect(await refusal(() => accept(Uint8Array.from([0x21, ...started.hello.slice(1)])))).toBe("malformed");
    expect(await refusal(() => accept(Uint8Array.from([0x20, 0x02, ...started.hello.slice(2)])))).toBe("malformed");
  });

  it("each step runs once", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => K });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    expect(await refusal(() => started.phone.receiveWelcome(accepted.welcome))).toBe("used");
    await accepted.mac.receiveFinish(finish);
    expect(await refusal(() => accepted.mac.receiveFinish(finish))).toBe("used");
  });

  it("a step refused once stays refused, so a relay gets one guess per handshake", async () => {
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => K });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    expect(await refusal(() => accepted.mac.receiveFinish(flipBit(finish, 5)))).toBe("unauthenticated");
    expect(await refusal(() => accepted.mac.receiveFinish(finish))).toBe("closed");
  });

  it("refuses a device id or host id that is not in the relay's form", async () => {
    expect(await refusal(() => startSession({ hostId: HOST_ID, deviceId: DEVICE_ID.toLowerCase(), secret: K }))).toBe("invalid");
    expect(await refusal(() => startSession({ hostId: "short", deviceId: DEVICE_ID, secret: K }))).toBe("invalid");
    expect(await refusal(() => startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K.slice(0, 31) }))).toBe("invalid");
  });
});
