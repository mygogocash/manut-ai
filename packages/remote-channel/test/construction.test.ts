import { describe, expect, it } from "vitest";
import { type Bytes, acceptSession, fromBase64Url, macPairing, newPairingOffer, startPairing, startSession, uuidToBytes } from "../src/index";
import { DEVICE_ID, HOST_ID, bytesOf, fixedKeyPair, seededRandom, text } from "./support";

/// The constructions the README writes down, computed again here straight from Web Crypto and
/// compared byte for byte with what the package sends. A reviewer can check the README against
/// these few lines instead of against the package, and a change to either shows here.

const subtle = crypto.subtle;
const enc = (value: string) => new TextEncoder().encode(value);

function cat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", cat(...parts)));
}

async function ecdh(own: CryptoKeyPair, peer: Uint8Array): Promise<Bytes> {
  const key = await subtle.importKey("raw", cat(peer), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: key }, own.privateKey, 256));
}

async function hkdf(secret: Uint8Array, salt: Uint8Array, label: string, th: Uint8Array, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", cat(secret), "HKDF", false, ["deriveBits"]);
  const info = cat(enc(label), Uint8Array.of(0), th);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: cat(salt), info }, key, bytes * 8));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await subtle.importKey("raw", cat(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, cat(data)));
}

describe("the documented constructions", () => {
  it("session: th, the Mac's proof and the phone's proof are as README.md writes them", async () => {
    const K = bytesOf(32, 0x4b);
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K }, { ephemeral: phoneKeys });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => K }, { ephemeral: macKeys });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);

    const phonePublic = new Uint8Array(await subtle.exportKey("raw", phoneKeys.publicKey));
    const macPublic = new Uint8Array(await subtle.exportKey("raw", macKeys.publicKey));
    expect(started.hello).toEqual(cat(Uint8Array.of(0x20, 0x01), uuidToBytes(DEVICE_ID), phonePublic));
    const welcomeCore = cat(Uint8Array.of(0x21, 0x01), macPublic);
    const th = await sha256(enc("manut-remote-v1 session"), fromBase64Url(HOST_ID), started.hello, welcomeCore);
    const shared = await ecdh(phoneKeys, macPublic);
    const macProof = await hmac(await hkdf(K, shared, "manut-remote-v1 session mac confirm", th, 32), th);
    const phoneProof = await hmac(await hkdf(K, shared, "manut-remote-v1 session phone confirm", th, 32), th);
    expect(accepted.welcome).toEqual(cat(welcomeCore, macProof));
    expect(finish).toEqual(cat(Uint8Array.of(0x22, 0x01), phoneProof));
  });

  it("pairing: the commitment, th, both proofs and the check code are as README.md writes them", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const mac = macPairing(offer, 0);
    const phone = await startPairing(offer, { ephemeral: phoneKeys });
    const key = await mac.receiveCommit(phone.commit, 1, { ephemeral: macKeys });
    const proof = await phone.phone.receiveKey(key);
    const { confirm, checkCode } = await mac.receiveProof(proof, 2);

    const phonePublic = new Uint8Array(await subtle.exportKey("raw", phoneKeys.publicKey));
    const macPublic = new Uint8Array(await subtle.exportKey("raw", macKeys.publicKey));
    expect(phone.commit).toEqual(cat(Uint8Array.of(0x10, 0x01), await sha256(enc("manut-remote-v1 pair commit"), phonePublic)));
    expect(key).toEqual(cat(Uint8Array.of(0x11, 0x01), macPublic));
    const proofCore = cat(Uint8Array.of(0x12, 0x01), phonePublic);
    const th = await sha256(enc("manut-remote-v1 pair"), fromBase64Url(HOST_ID), uuidToBytes(offer.doorId), phone.commit, key, proofCore);
    const shared = await ecdh(macKeys, phonePublic);
    const phoneProof = await hmac(await hkdf(offer.secret, shared, "manut-remote-v1 pair phone confirm", th, 32), th);
    const macProof = await hmac(await hkdf(offer.secret, shared, "manut-remote-v1 pair mac confirm", th, 32), th);
    expect(proof).toEqual(cat(proofCore, phoneProof));
    expect(confirm).toEqual(cat(Uint8Array.of(0x13, 0x01), macProof));
    const code = await hkdf(offer.secret, shared, "manut-remote-v1 pair check code", th, 4);
    expect(checkCode).toBe(String(new DataView(code.buffer).getUint32(0) % 10_000).padStart(4, "0"));
  });

  it("records: the first record from each side opens with the documented key, IV and nonce", async () => {
    const K = bytesOf(32, 0x4b);
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K }, { ephemeral: phoneKeys });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => K }, { ephemeral: macKeys });
    const { channel: phone } = await started.phone.receiveWelcome(accepted.welcome);

    const macPublic = new Uint8Array(await subtle.exportKey("raw", macKeys.publicKey));
    const th = await sha256(enc("manut-remote-v1 session"), fromBase64Url(HOST_ID), started.hello, accepted.welcome.subarray(0, 67));
    const shared = await ecdh(phoneKeys, macPublic);
    const rawKey = await hkdf(K, shared, "manut-remote-v1 session phone to mac key", th, 32);
    const iv = await hkdf(K, shared, "manut-remote-v1 session phone to mac iv", th, 12);
    const aes = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const frames = [...(await phone.seal(text("first"))), ...(await phone.seal(text("second")))];
    for (const [counter, frame] of frames.entries()) {
      expect(frame[0]).toBe(0x30);
      const nonce = iv.slice();
      nonce[11] = (nonce[11] ?? 0) ^ counter;
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: Uint8Array.of(0x30, 0x01) }, aes, frame.subarray(1)));
      expect(plain[0]).toBe(0x01);
      expect(new TextDecoder().decode(plain.subarray(1))).toBe(counter === 0 ? "first" : "second");
    }
  });
});
