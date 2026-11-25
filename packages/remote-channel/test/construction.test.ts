import { beforeEach, describe, expect, it } from "vitest";
import { fromBase64Url, macPairing, newPairingOffer, uuidToBytes } from "../src/index";
import { acceptSessionWith, forgetStartedPairings, macReceiveCommitWith, startPairingWith, startSessionWith } from "../src/testing";
import { cat, commitFor, ecdh, enc, hkdf, hmac, proofRevealing, publicBytes, sha256 } from "./raw";
import { DEVICE_ID, HOST_ID, bytesOf, fixedKeyPair, seededRandom, text } from "./support";

/// The constructions the README writes down, computed again here straight from Web Crypto and
/// compared byte for byte with what the package sends. A reviewer can check the README against
/// these few lines instead of against the package, and a change to either shows here.

beforeEach(forgetStartedPairings);

describe("the documented constructions", () => {
  it("session: th, the Mac's proof and the phone's proof are as README.md writes them", async () => {
    const K = bytesOf(32, 0x4b);
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const started = await startSessionWith({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K }, phoneKeys);
    const accepted = await acceptSessionWith(started.hello, { hostId: HOST_ID, secretFor: () => K }, macKeys);
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);

    const phonePublic = await publicBytes(phoneKeys);
    const macPublic = await publicBytes(macKeys);
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
    // Starting pairing zeroes the phone's copy of the secret, so the check keeps its own.
    const secret = offer.secret.slice();
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const mac = macPairing(offer, 0);
    const phone = await startPairingWith(offer, phoneKeys);
    const key = await macReceiveCommitWith(mac, phone.commit, 1, macKeys);
    const proof = await phone.phone.receiveKey(key);
    const { confirm } = await mac.receiveProof(proof, 2);
    const { checkCode } = await phone.phone.receiveConfirm(confirm);

    const phonePublic = await publicBytes(phoneKeys);
    const macPublic = await publicBytes(macKeys);
    expect(phone.commit).toEqual(await commitFor(phoneKeys));
    expect(key).toEqual(cat(Uint8Array.of(0x11, 0x01), macPublic));
    const proofCore = cat(Uint8Array.of(0x12, 0x01), phonePublic);
    const th = await sha256(enc("manut-remote-v1 pair"), fromBase64Url(HOST_ID), uuidToBytes(offer.doorId), phone.commit, key, proofCore);
    const shared = await ecdh(macKeys, phonePublic);
    const phoneProof = await hmac(await hkdf(secret, shared, "manut-remote-v1 pair phone confirm", th, 32), th);
    const macProof = await hmac(await hkdf(secret, shared, "manut-remote-v1 pair mac confirm", th, 32), th);
    expect(proof).toEqual(cat(proofCore, phoneProof));
    expect(confirm).toEqual(cat(Uint8Array.of(0x13, 0x01), macProof));
    const code = await hkdf(secret, shared, "manut-remote-v1 pair check code", th, 4);
    const expected = String(new DataView(code.buffer).getUint32(0) % 10_000).padStart(4, "0");
    expect(checkCode).toBe(expected);
    // The Mac takes exactly that code, typed.
    expect(mac.allow(expected, 3).role).toBe("mac");
  });

  it("records: the first record from each side opens with the documented key, IV and nonce", async () => {
    const K = bytesOf(32, 0x4b);
    const phoneKeys = await fixedKeyPair("phone");
    const macKeys = await fixedKeyPair("mac");
    const started = await startSessionWith({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K }, phoneKeys);
    const accepted = await acceptSessionWith(started.hello, { hostId: HOST_ID, secretFor: () => K }, macKeys);
    const { channel: phone } = await started.phone.receiveWelcome(accepted.welcome);

    const th = await sha256(enc("manut-remote-v1 session"), fromBase64Url(HOST_ID), started.hello, accepted.welcome.subarray(0, 67));
    const shared = await ecdh(phoneKeys, await publicBytes(macKeys));
    const rawKey = await hkdf(K, shared, "manut-remote-v1 session phone to mac key", th, 32);
    const iv = await hkdf(K, shared, "manut-remote-v1 session phone to mac iv", th, 12);
    const aes = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const frames = [...(await phone.seal(text("first"))), ...(await phone.seal(text("second")))];
    for (const [counter, frame] of frames.entries()) {
      expect(frame[0]).toBe(0x30);
      const nonce = iv.slice();
      nonce[11] = (nonce[11] ?? 0) ^ counter;
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: Uint8Array.of(0x30, 0x01) }, aes, frame.subarray(1)));
      expect(plain[0]).toBe(0x01);
      expect(new TextDecoder().decode(plain.subarray(1))).toBe(counter === 0 ? "first" : "second");
    }
  });

  it("pairing: someone with the secret who commits to one key and then reveals another is refused", async () => {
    // The attack the commitment stops: knowing the secret, a party in the middle would like to pick
    // its key after seeing the Mac's, trying keys until the Mac's check code matches the one the
    // real phone shows. Here it commits to key A, sees the Mac's key, then reveals key B with a
    // proof that is correct for B. Only the commitment check can refuse it.
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const a = await fixedKeyPair("relayPhoneSide");
    const b = await fixedKeyPair("relayMacSide");
    const commit = await commitFor(a);
    const mac = macPairing(offer, 0);
    const key = await mac.receiveCommit(commit, 1);
    const switched = await proofRevealing(b, offer.secret, offer.doorId, commit, key);
    await expect(mac.receiveProof(switched, 2)).rejects.toMatchObject({ problem: "unauthenticated" });

    // The same steps with B committed to are accepted, so the refusal above is the commitment's.
    const honestCommit = await commitFor(b);
    const honestMac = macPairing(offer, 0);
    const honestKey = await honestMac.receiveCommit(honestCommit, 1);
    const honest = await proofRevealing(b, offer.secret, offer.doorId, honestCommit, honestKey);
    expect((await honestMac.receiveProof(honest, 2)).confirm).toHaveLength(34);
  });
});
