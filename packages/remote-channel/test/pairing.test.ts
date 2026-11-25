import { beforeEach, describe, expect, it } from "vitest";
import {
  type Bytes,
  type PairingOffer,
  PAIRING_TTL_MS,
  acceptSession,
  decodePairingGrant,
  encodePairingGrant,
  encodePairingOffer,
  macPairing,
  newPairingGrant,
  newPairingOffer,
  pairingLink,
  readPairingLink,
  startPairing,
  startSession,
  toHex,
} from "../src/index";
import { forgetStartedPairings, macReceiveCommitWith, startPairingWith } from "../src/testing";
import { commitFor, proofRevealing, publicBytes } from "./raw";
import { HOST_ID, fixedKeyPair, flipBit, read, refusal, seededRandom, text } from "./support";

/// Pairing over the relay. The QR code holds a 256-bit secret; both sides exchange throwaway keys
/// and prove they know it (GoSpark's `RemoteAuthentication.proof`, here over a transcript). The
/// phone commits to its key before it sees the Mac's and then shows a four-digit code, which the
/// person types into the Mac. A code is one try on each side. The relay carries every message and
/// may change, swap, drop or replay any of them.

const T0 = 1_790_000_000_000;

/// Each test is a fresh phone: a code started in one test is not refused in the next. Within a
/// test, `anotherPhone()` says when a second device (an attacker's) starts on the same code.
beforeEach(forgetStartedPairings);
const anotherPhone = forgetStartedPairings;

/// A copy of a code, as a photograph or a second scan would give it: starting pairing zeroes the
/// secret in the offer it is given.
function copyOf(offer: PairingOffer): PairingOffer {
  return { ...offer, doorToken: offer.doorToken.slice(), secret: offer.secret.slice() };
}

type Rewrite = (bytes: Bytes) => Bytes;

/// One pairing with a relay that may rewrite each of the four messages, ending with the person
/// typing the phone's code at the Mac. Returns where it was refused, or both channels.
async function pair(
  macOffer: PairingOffer,
  phoneOffer: PairingOffer = copyOf(macOffer),
  relay: { commit?: Rewrite; key?: Rewrite; proof?: Rewrite; confirm?: Rewrite; now?: number } = {},
) {
  const same: Rewrite = (bytes) => bytes;
  const now = relay.now ?? T0 + 1_000;
  const mac = macPairing(macOffer, T0);
  const phone = await startPairing(phoneOffer);
  let key: Bytes;
  try {
    key = await mac.receiveCommit((relay.commit ?? same)(phone.commit), now);
  } catch (error) {
    return { refused: "mac at commit" as const, error };
  }
  let proof: Bytes;
  try {
    proof = await phone.phone.receiveKey((relay.key ?? same)(key));
  } catch (error) {
    return { refused: "phone at key" as const, error };
  }
  let confirm: Bytes;
  try {
    ({ confirm } = await mac.receiveProof((relay.proof ?? same)(proof), now));
  } catch (error) {
    return { refused: "mac at proof" as const, error };
  }
  let phoneSide;
  try {
    phoneSide = await phone.phone.receiveConfirm((relay.confirm ?? same)(confirm));
  } catch (error) {
    return { refused: "phone at confirm" as const, error };
  }
  try {
    return { refused: "none" as const, mac: mac.allow(phoneSide.checkCode, now), phone: phoneSide };
  } catch (error) {
    return { refused: "mac at code" as const, error };
  }
}

describe("pairing", () => {
  it("the phone shows four digits, the person types them at the Mac, and the channel carries the grant", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const result = await pair(offer);
    if (result.refused !== "none") throw new Error(`refused at ${result.refused}`);
    expect(result.phone.checkCode).toMatch(/^\d{4}$/);
    expect(result.mac.deviceId).toBeNull();

    // Once the code is typed, the Mac hands over the phone's id, its relay door and K, and the
    // phone can then open a session with that K.
    const grant = newPairingGrant(seededRandom(200));
    const frames = await result.mac.seal(encodePairingGrant(grant));
    const received = decodePairingGrant((await result.phone.channel.open(frames[0]!))!);
    expect(received).toEqual(grant);
    const started = await startSession({ hostId: HOST_ID, deviceId: received.deviceId, secret: received.secret });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => grant.secret });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    expect((await accepted.mac.receiveFinish(finish)).deviceId).toBe(grant.deviceId);

    for (const frame of await result.phone.channel.seal(text("iPhone, Safari"))) {
      expect(read(await result.mac.open(frame))).toBe("iPhone, Safari");
    }
  });

  it("a wrong secret at pairing is refused, and spends the code's one try on the Mac", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const guessed = { ...copyOf(offer), secret: offer.secret.map((byte) => byte ^ 1) as Bytes };
    expect((await pair(offer, guessed)).refused).toBe("mac at proof");

    // The real phone, with the right secret, comes too late: the code was good for one try.
    const mac = macPairing(offer, T0);
    anotherPhone();
    const wrong = await startPairing({ ...copyOf(offer), secret: offer.secret.map((byte) => byte ^ 1) as Bytes });
    const key = await mac.receiveCommit(wrong.commit, T0 + 1);
    expect(await refusal(async () => mac.receiveProof(await wrong.phone.receiveKey(key), T0 + 2))).toBe("unauthenticated");
    anotherPhone();
    const right = await startPairing(copyOf(offer));
    expect(await refusal(() => mac.receiveCommit(right.commit, T0 + 3))).toBe("used");
  });

  it("a code is one try on the Mac, even when the first try was nonsense", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    expect(await refusal(() => mac.receiveCommit(new Uint8Array(34), T0 + 1))).toBe("malformed");
    const phone = await startPairing(copyOf(offer));
    expect(await refusal(() => mac.receiveCommit(phone.commit, T0 + 2))).toBe("used");
  });

  it("a phone cannot start pairing twice on one code, from the same offer or from the code read again", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const link = pairingLink("https://manut.xyz/app/", offer);
    await startPairing(offer);
    // The offer's secret is gone from the phone's copy, and the door is spent in this page.
    expect(offer.secret.every((byte) => byte === 0)).toBe(true);
    expect(await refusal(() => startPairing(offer))).toBe("used");
    expect(await refusal(() => startPairing(readPairingLink(link)))).toBe("used");
    // The spent offer itself is refused even where its door was never seen.
    anotherPhone();
    expect(await refusal(() => startPairing(offer))).toBe("used");

    // Two starts at once on a fresh code: one goes through.
    const fresh = newPairingOffer(HOST_ID, seededRandom(90));
    const results = await Promise.allSettled([startPairing(copyOf(fresh)), startPairing(copyOf(fresh))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    // A start that went wrong half way is no reason to start again: the code stays spent.
    const failing = newPairingOffer(HOST_ID, seededRandom(150));
    const started = await startPairing(copyOf(failing));
    expect(await refusal(() => started.phone.receiveKey(new Uint8Array(67)))).toBe("malformed");
    expect(await refusal(() => startPairing(copyOf(failing)))).toBe("used");
  });

  it("a wrong typed code spends the pairing, with no second guess", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(copyOf(offer));
    const proof = await phone.phone.receiveKey(await mac.receiveCommit(phone.commit, T0 + 1));
    expect(await refusal(async () => mac.allow("1234", T0 + 2))).toBe("used");
    const { confirm } = await mac.receiveProof(proof, T0 + 2);
    const { checkCode } = await phone.phone.receiveConfirm(confirm);
    const wrong = String((Number(checkCode) + 1) % 10_000).padStart(4, "0");
    expect(await refusal(async () => mac.allow(wrong, T0 + 3))).toBe("wrong_code");
    expect(await refusal(async () => mac.allow(checkCode, T0 + 4))).toBe("closed");
  });

  it("a typed code is taken with spaces around it, and nothing that is not those four digits", async () => {
    const run = async (typed: (code: string) => string) => {
      const offer = newPairingOffer(HOST_ID);
      const mac = macPairing(offer, T0);
      const phone = await startPairing(copyOf(offer));
      const proof = await phone.phone.receiveKey(await mac.receiveCommit(phone.commit, T0 + 1));
      const { checkCode } = await phone.phone.receiveConfirm((await mac.receiveProof(proof, T0 + 2)).confirm);
      return refusal(async () => mac.allow(typed(checkCode), T0 + 3)).catch(() => "none");
    };
    expect(await run((code) => ` ${code}\n`)).toBe("none");
    for (const typed of [(code: string) => `${code}0`, (code: string) => code.slice(1), () => "", (code: string) => `${code.slice(0, 2)} ${code.slice(2)}`]) {
      expect(await run(typed)).toBe("wrong_code");
    }
  });

  it("a code is refused after its two minutes: at the first message, the third, or when typed", async () => {
    expect(PAIRING_TTL_MS).toBe(120_000);
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const late = await pair(offer, copyOf(offer), { now: T0 + PAIRING_TTL_MS });
    expect(late.refused).toBe("mac at commit");
    expect(late.refused === "mac at commit" && (late.error as { problem?: string }).problem).toBe("expired");
    anotherPhone();
    expect((await pair(offer, copyOf(offer), { now: T0 + PAIRING_TTL_MS - 1 })).refused).toBe("none");

    anotherPhone();
    const mac = macPairing(offer, T0);
    const phone = await startPairing(copyOf(offer));
    const proof = await phone.phone.receiveKey(await mac.receiveCommit(phone.commit, T0 + PAIRING_TTL_MS - 1));
    expect(await refusal(() => mac.receiveProof(proof, T0 + PAIRING_TTL_MS))).toBe("expired");

    // The person types the right code, but only after the code's time: Allow is refused, and
    // nothing waits open past it.
    anotherPhone();
    const slow = macPairing(offer, T0);
    const slowPhone = await startPairing(copyOf(offer));
    const slowProof = await slowPhone.phone.receiveKey(await slow.receiveCommit(slowPhone.commit, T0 + 1));
    const { checkCode } = await slowPhone.phone.receiveConfirm((await slow.receiveProof(slowProof, T0 + 2)).confirm);
    expect(await refusal(async () => slow.allow(checkCode, T0 + PAIRING_TTL_MS))).toBe("expired");
    expect(await refusal(async () => slow.allow(checkCode, T0 + 3))).toBe("closed");

    // A Mac may shorten the window but never lengthen it.
    expect(macPairing(offer, T0, { ttlMs: 30_000 }).expiresAt).toBe(T0 + 30_000);
    expect(() => macPairing(offer, T0, { ttlMs: PAIRING_TTL_MS + 1 })).toThrow();
  });

  it("a relay that swaps the phone's key is refused, because the key does not open the phone's commitment", async () => {
    const relayKey = await publicBytes(await fixedKeyPair("relayMacSide"));
    const result = await pair(newPairingOffer(HOST_ID, seededRandom(1)), undefined, {
      proof: (bytes) => {
        const changed = bytes.slice();
        changed.set(relayKey, 2);
        return changed;
      },
    });
    expect(result.refused).toBe("mac at proof");
  });

  it("a relay that swaps the Mac's key is refused", async () => {
    const relayKey = await publicBytes(await fixedKeyPair("relayPhoneSide"));
    const result = await pair(newPairingOffer(HOST_ID, seededRandom(1)), undefined, {
      key: (bytes) => {
        const changed = bytes.slice();
        changed.set(relayKey, 2);
        return changed;
      },
    });
    expect(result.refused).toBe("mac at proof");
  });

  it("a transcript with any one byte of any of the four messages changed is refused", async () => {
    const lengths = { commit: 34, key: 67, proof: 99, confirm: 34 } as const;
    for (const [message, length] of Object.entries(lengths)) {
      for (let index = 0; index < length; index++) {
        const result = await pair(newPairingOffer(HOST_ID), undefined, { [message]: (bytes: Bytes) => flipBit(bytes, index) });
        expect(result.refused, `${message} byte ${index}`).not.toBe("none");
      }
    }
  });

  it("the Mac's proof sent back as the phone's is refused", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    // Run once to learn what a Mac proof looks like for this exact transcript, using fixed keys
    // so the second run (another phone, for the test's purpose) has the same Mac proof.
    const run = async () => {
      anotherPhone();
      const mac = macPairing(offer, T0);
      const phone = await startPairingWith(copyOf(offer), await fixedKeyPair("phone"));
      const key = await macReceiveCommitWith(mac, phone.commit, T0 + 1, await fixedKeyPair("mac"));
      const proof = await phone.phone.receiveKey(key);
      return { mac, proof };
    };
    const first = await run();
    const { confirm } = await first.mac.receiveProof(first.proof, T0 + 2);
    const second = await run();
    const reflected = Uint8Array.from([...second.proof.slice(0, 67), ...confirm.slice(2)]) as Bytes;
    expect(await refusal(() => second.mac.receiveProof(reflected, T0 + 2))).toBe("unauthenticated");
  });

  it("messages recorded from one pairing are refused by the next code", async () => {
    const first = newPairingOffer(HOST_ID, seededRandom(1));
    const recordedPhone = await startPairing(copyOf(first));
    const recordedKey = await macPairing(first, T0).receiveCommit(recordedPhone.commit, T0 + 1);
    const recordedProof = await recordedPhone.phone.receiveKey(recordedKey);

    const next = newPairingOffer(HOST_ID, seededRandom(90));
    const mac = macPairing(next, T0);
    await mac.receiveCommit(recordedPhone.commit, T0 + 1);
    expect(await refusal(() => mac.receiveProof(recordedProof, T0 + 2))).toBe("unauthenticated");
  });

  it("someone who photographed the code after it expired, and recorded the relay, can neither pair nor read the grant", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const photo = encodePairingOffer(offer);
    const mac = macPairing(offer, T0);
    const phone = await startPairing(copyOf(offer));
    const key = await mac.receiveCommit(phone.commit, T0 + 1);
    const proof = await phone.phone.receiveKey(key);
    const { confirm } = await mac.receiveProof(proof, T0 + 2);
    const { checkCode } = await phone.phone.receiveConfirm(confirm);
    const [recordedGrant] = await mac.allow(checkCode, T0 + 3).seal(encodePairingGrant(newPairingGrant(seededRandom(200))));

    // Pairing again with the photographed secret: the code is spent, and past its time.
    const later = T0 + PAIRING_TTL_MS + 60_000;
    anotherPhone();
    const attacker = await startPairing(readPairingLink(photo));
    expect(await refusal(() => mac.receiveCommit(attacker.commit, later))).toBe("used");
    expect(await refusal(() => macPairing(readPairingLink(photo), T0).receiveCommit(attacker.commit, later))).toBe("expired");

    // Playing the phone against the recording: the recorded Mac proof does not fit a transcript
    // with the attacker's own key, and the attacker has neither side's throwaway private key.
    await attacker.phone.receiveKey(key);
    expect(await refusal(() => attacker.phone.receiveConfirm(confirm))).toBe("unauthenticated");

    // Any channel the secret can still make (here with a Mac that would pair again) cannot open
    // the recorded grant, because each pairing's keys come from its own throwaway keys.
    anotherPhone();
    const own = await pair(readPairingLink(photo));
    if (own.refused !== "none") throw new Error("own pairing failed");
    expect(await refusal(() => own.phone.channel.open(recordedGrant!))).toBe("unauthenticated");
  });

  it("the photographed code's secret is not K, so it opens no session as the paired phone", async () => {
    // The relay knows the paired phone's device id (it forwards its hello), and the photograph
    // gives the code's secret. K was drawn by the Mac after the code was typed and only ever
    // crossed inside the pairing channel, so a session proved with the code's secret is refused.
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const grant = newPairingGrant(seededRandom(200));
    const started = await startSession({ hostId: HOST_ID, deviceId: grant.deviceId, secret: offer.secret });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: (id) => (id === grant.deviceId ? grant.secret : undefined) });
    expect(await refusal(() => started.phone.receiveWelcome(accepted.welcome))).toBe("unauthenticated");
    // And the code's door is not a paired device at all.
    const door = await startSession({ hostId: HOST_ID, deviceId: offer.doorId, secret: offer.secret });
    expect(await refusal(() => acceptSession(door.hello, { hostId: HOST_ID, secretFor: (id) => (id === grant.deviceId ? grant.secret : undefined) }))).toBe("unknown_device");
  });

  it("with the secret, someone in the middle can steer neither code: every way to choose a key late is refused", async () => {
    // A relay that has the secret (photographed within its two minutes) pairs with each side on
    // its own. Played honestly, the two codes differ (fixed keys here), so the code the person
    // types from the phone is refused at the Mac.
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const photo = encodePairingOffer(offer);
    const mac = macPairing(offer, T0);
    const phoneKeys = await fixedKeyPair("phone");
    const phone = await startPairingWith(copyOf(offer), phoneKeys);
    anotherPhone();
    const relayAsPhone = await startPairingWith(readPairingLink(photo), await fixedKeyPair("relayMacSide"));
    const relayAsMac = macPairing(readPairingLink(photo), T0);
    const macKey = await macReceiveCommitWith(mac, relayAsPhone.commit, T0 + 1, await fixedKeyPair("mac"));
    const relayKey = await macReceiveCommitWith(relayAsMac, phone.commit, T0 + 1, await fixedKeyPair("relayPhoneSide"));
    const { confirm: toRelay } = await mac.receiveProof(await relayAsPhone.phone.receiveKey(macKey), T0 + 2);
    await relayAsPhone.phone.receiveConfirm(toRelay);
    const { confirm: toPhone } = await relayAsMac.receiveProof(await phone.phone.receiveKey(relayKey), T0 + 2);
    const shown = await phone.phone.receiveConfirm(toPhone);
    expect(await refusal(async () => mac.allow(shown.checkCode, T0 + 3))).toBe("wrong_code");

    // To steer the phone's code, the relay would need the phone's key before choosing its own.
    // The phone's first message holds only a hash of it, the phone takes one key and no other,
    // and it will not start again on this code.
    const phonePublic = await publicBytes(phoneKeys);
    expect(toHex(phone.commit)).not.toContain(toHex(phonePublic.subarray(1, 9)));
    expect(await refusal(() => phone.phone.receiveKey(relayKey))).toBe("used");
    expect(await refusal(() => startPairing(copyOf(readPairingLink(photo))))).toBe("used");

    // To steer the Mac's code, the relay would reveal another key than the one it committed to,
    // chosen after seeing the Mac's: refused, and only the commitment refuses it, since the
    // proof is right for the key revealed.
    const steered = macPairing(readPairingLink(photo), T0);
    const committed = await commitFor(await fixedKeyPair("relayMacSide"));
    const steeredKey = await steered.receiveCommit(committed, T0 + 1);
    const late = await proofRevealing(await fixedKeyPair("relayPhoneSide"), readPairingLink(photo).secret, offer.doorId, committed, steeredKey);
    expect(await refusal(() => steered.receiveProof(late, T0 + 2))).toBe("unauthenticated");
  });

  it("each step runs once, and a refused step ends the pairing", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(copyOf(offer));
    const key = await mac.receiveCommit(phone.commit, T0 + 1);
    const proof = await phone.phone.receiveKey(key);
    expect(await refusal(() => phone.phone.receiveKey(key))).toBe("used");
    expect(await refusal(() => mac.receiveProof(flipBit(proof, 80), T0 + 2))).toBe("unauthenticated");
    expect(await refusal(() => mac.receiveProof(proof, T0 + 2))).toBe("closed");
    expect(await refusal(async () => mac.allow("0000", T0 + 3))).toBe("closed");
  });

  it("pins every byte of a pairing run with fixed keys, so the layout in the README cannot drift", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairingWith(copyOf(offer), await fixedKeyPair("phone"));
    const key = await macReceiveCommitWith(mac, phone.commit, T0 + 1, await fixedKeyPair("mac"));
    const proof = await phone.phone.receiveKey(key);
    const { confirm } = await mac.receiveProof(proof, T0 + 2);
    const phoneSide = await phone.phone.receiveConfirm(confirm);
    const [record] = await mac.allow(phoneSide.checkCode, T0 + 3).seal(text("grant"));
    expect({
      commit: toHex(phone.commit),
      key: toHex(key),
      proof: toHex(proof),
      confirm: toHex(confirm),
      checkCode: phoneSide.checkCode,
      record: toHex(record!),
    }).toMatchSnapshot();
  });
});
