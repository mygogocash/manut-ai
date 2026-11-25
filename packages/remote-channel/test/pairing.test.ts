import { describe, expect, it } from "vitest";
import {
  type Bytes,
  type PairingOffer,
  PAIRING_TTL_MS,
  decodePairingGrant,
  encodePairingGrant,
  macPairing,
  newPairingGrant,
  newPairingOffer,
  startPairing,
  startSession,
  acceptSession,
  toHex,
} from "../src/index";
import { HOST_ID, fixedKeyPair, flipBit, read, refusal, seededRandom, text } from "./support";

/// Pairing over the relay. The QR code holds a 256-bit secret; both sides exchange throwaway keys
/// and prove they know it (GoSpark's `RemoteAuthentication.proof`, here over a transcript), and the
/// phone commits to its key before it sees the Mac's, so both screens' check codes can only match
/// by chance when someone stands in the middle. The relay carries every message and may change,
/// swap, drop or replay any of them.

const T0 = 1_790_000_000_000;

type Rewrite = (bytes: Bytes) => Bytes;

/// One pairing with a relay that may rewrite each of the four messages. Returns where it was
/// refused, or the two check codes and channels when both sides finished.
async function pair(
  macOffer: PairingOffer,
  phoneOffer: PairingOffer = macOffer,
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
  let macSide;
  try {
    macSide = await mac.receiveProof((relay.proof ?? same)(proof), now);
  } catch (error) {
    return { refused: "mac at proof" as const, error };
  }
  try {
    const phoneSide = await phone.phone.receiveConfirm((relay.confirm ?? same)(macSide.confirm));
    return { refused: "none" as const, mac: macSide, phone: phoneSide };
  } catch (error) {
    return { refused: "phone at confirm" as const, error };
  }
}

describe("pairing", () => {
  it("gives both screens the same four-digit check code and a channel that carries the grant", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const result = await pair(offer);
    if (result.refused !== "none") throw new Error(`refused at ${result.refused}`);
    expect(result.mac.checkCode).toMatch(/^\d{4}$/);
    expect(result.phone.checkCode).toBe(result.mac.checkCode);
    expect(result.mac.channel.deviceId).toBeNull();

    // After Allow, the Mac hands over the phone's id, its relay door and K, and the phone can
    // then open a session with that K.
    const grant = newPairingGrant(seededRandom(200));
    const frames = await result.mac.channel.seal(encodePairingGrant(grant));
    const received = decodePairingGrant((await result.phone.channel.open(frames[0]!))!);
    expect(received).toEqual(grant);
    const started = await startSession({ hostId: HOST_ID, deviceId: received.deviceId, secret: received.secret });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => grant.secret });
    const { finish } = await started.phone.receiveWelcome(accepted.welcome);
    expect((await accepted.mac.receiveFinish(finish)).deviceId).toBe(grant.deviceId);

    for (const frame of await result.phone.channel.seal(text("iPhone, Safari"))) {
      expect(read(await result.mac.channel.open(frame))).toBe("iPhone, Safari");
    }
  });

  it("a wrong secret at pairing is refused, and spends the code's one try", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const guessed = { ...offer, secret: offer.secret.map((byte) => byte ^ 1) as Bytes };
    const result = await pair(offer, guessed);
    expect(result.refused).toBe("mac at proof");

    // The real phone, with the right secret, comes too late: the code was good for one try.
    const mac = macPairing(offer, T0);
    const wrong = await startPairing(guessed);
    const key = await mac.receiveCommit(wrong.commit, T0 + 1);
    expect(await refusal(async () => mac.receiveProof(await wrong.phone.receiveKey(key), T0 + 2))).toBe("unauthenticated");
    const right = await startPairing(offer);
    expect(await refusal(() => mac.receiveCommit(right.commit, T0 + 3))).toBe("used");
  });

  it("a code is good for one try, even when the first try was nonsense", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    expect(await refusal(() => mac.receiveCommit(new Uint8Array(34), T0 + 1))).toBe("malformed");
    const phone = await startPairing(offer);
    expect(await refusal(() => mac.receiveCommit(phone.commit, T0 + 2))).toBe("used");
  });

  it("a code is refused after its two minutes, at the first message or the third", async () => {
    expect(PAIRING_TTL_MS).toBe(120_000);
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const late = await pair(offer, offer, { now: T0 + PAIRING_TTL_MS });
    expect(late.refused).toBe("mac at commit");
    expect(late.refused === "mac at commit" && (late.error as { problem?: string }).problem).toBe("expired");
    expect((await pair(offer, offer, { now: T0 + PAIRING_TTL_MS - 1 })).refused).toBe("none");

    const mac = macPairing(offer, T0);
    const phone = await startPairing(offer);
    const proof = await phone.phone.receiveKey(await mac.receiveCommit(phone.commit, T0 + PAIRING_TTL_MS - 1));
    expect(await refusal(() => mac.receiveProof(proof, T0 + PAIRING_TTL_MS))).toBe("expired");
    // A Mac may shorten the window but never lengthen it.
    expect(macPairing(offer, T0, { ttlMs: 30_000 }).expiresAt).toBe(T0 + 30_000);
    expect(() => macPairing(offer, T0, { ttlMs: PAIRING_TTL_MS + 1 })).toThrow();
  });

  it("a relay that swaps the phone's key is refused, because the key does not open the phone's commitment", async () => {
    const relayKey = (await crypto.subtle.exportKey("raw", (await fixedKeyPair("relayMacSide")).publicKey)) as ArrayBuffer;
    const result = await pair(newPairingOffer(HOST_ID, seededRandom(1)), undefined, {
      proof: (bytes) => {
        const changed = bytes.slice();
        changed.set(new Uint8Array(relayKey), 2);
        return changed;
      },
    });
    expect(result.refused).toBe("mac at proof");
  });

  it("a relay that swaps the Mac's key is refused", async () => {
    const relayKey = (await crypto.subtle.exportKey("raw", (await fixedKeyPair("relayPhoneSide")).publicKey)) as ArrayBuffer;
    const result = await pair(newPairingOffer(HOST_ID, seededRandom(1)), undefined, {
      key: (bytes) => {
        const changed = bytes.slice();
        changed.set(new Uint8Array(relayKey), 2);
        return changed;
      },
    });
    expect(result.refused).toBe("mac at proof");
  });

  it("a transcript with any one byte of any of the four messages changed is refused", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const lengths = { commit: 34, key: 67, proof: 99, confirm: 34 } as const;
    for (const [message, length] of Object.entries(lengths)) {
      for (let index = 0; index < length; index++) {
        const result = await pair(offer, offer, { [message]: (bytes: Bytes) => flipBit(bytes, index) });
        expect(result.refused, `${message} byte ${index}`).not.toBe("none");
      }
    }
  });

  it("the Mac's proof sent back as the phone's is refused", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    // Run once to learn what a Mac proof looks like for this exact transcript, using fixed keys
    // so the second run has the same transcript and the same Mac proof.
    const run = async () => {
      const mac = macPairing(offer, T0);
      const phone = await startPairing(offer, { ephemeral: await fixedKeyPair("phone") });
      const key = await mac.receiveCommit(phone.commit, T0 + 1, { ephemeral: await fixedKeyPair("mac") });
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
    const recordedPhone = await startPairing(first);
    const recordedKey = await macPairing(first, T0).receiveCommit(recordedPhone.commit, T0 + 1);
    const recordedProof = await recordedPhone.phone.receiveKey(recordedKey);

    const next = newPairingOffer(HOST_ID, seededRandom(90));
    const mac = macPairing(next, T0);
    await mac.receiveCommit(recordedPhone.commit, T0 + 1);
    expect(await refusal(() => mac.receiveProof(recordedProof, T0 + 2))).toBe("unauthenticated");
  });

  it("someone who photographed the code after it expired, and recorded the relay, can neither pair nor read the grant", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(offer);
    const key = await mac.receiveCommit(phone.commit, T0 + 1);
    const proof = await phone.phone.receiveKey(key);
    const macSide = await mac.receiveProof(proof, T0 + 2);
    await phone.phone.receiveConfirm(macSide.confirm);
    const [recordedGrant] = await macSide.channel.seal(encodePairingGrant(newPairingGrant(seededRandom(200))));

    // Pairing again with the photographed secret: the code is spent, and past its time.
    const later = T0 + PAIRING_TTL_MS + 60_000;
    const attacker = await startPairing(offer);
    expect(await refusal(() => mac.receiveCommit(attacker.commit, later))).toBe("used");
    expect(await refusal(() => macPairing(offer, T0).receiveCommit(attacker.commit, later))).toBe("expired");

    // Playing the phone against the recording: the recorded Mac proof does not fit a transcript
    // with the attacker's own key, and the attacker has neither side's throwaway private key.
    await attacker.phone.receiveKey(key);
    expect(await refusal(() => attacker.phone.receiveConfirm(macSide.confirm))).toBe("unauthenticated");

    // Any channel the secret can still make (here with a Mac that would pair again) cannot open
    // the recorded grant, because each pairing's keys come from its own throwaway keys.
    const own = await pair(offer);
    if (own.refused !== "none") throw new Error("own pairing failed");
    expect(await refusal(() => own.phone.channel.open(recordedGrant!))).toBe("unauthenticated");
  });

  it("the photographed code's secret is not K, so it opens no session as the paired phone", async () => {
    // The relay knows the paired phone's device id (it forwards its hello), and the photograph
    // gives the code's secret. K was drawn by the Mac after Allow and only ever crossed inside the
    // pairing channel, so a session proved with the code's secret is refused.
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const grant = newPairingGrant(seededRandom(200));
    const started = await startSession({ hostId: HOST_ID, deviceId: grant.deviceId, secret: offer.secret });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: (id) => (id === grant.deviceId ? grant.secret : undefined) });
    expect(await refusal(() => started.phone.receiveWelcome(accepted.welcome))).toBe("unauthenticated");
    // And the code's door is not a paired device at all.
    const door = await startSession({ hostId: HOST_ID, deviceId: offer.doorId, secret: offer.secret });
    expect(await refusal(() => acceptSession(door.hello, { hostId: HOST_ID, secretFor: (id) => (id === grant.deviceId ? grant.secret : undefined) }))).toBe("unknown_device");
  });

  it("with the secret, someone in the middle still meets two different check codes", async () => {
    // A relay that also has the secret (photographed within its two minutes) pairs with each side
    // on its own. The phone committed to its key first and the relay committed to its key before
    // the Mac chose one, so neither code can be steered: here, with fixed keys, they differ.
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(offer, { ephemeral: await fixedKeyPair("phone") });
    const relayAsPhone = await startPairing(offer, { ephemeral: await fixedKeyPair("relayMacSide") });
    const relayAsMac = macPairing(offer, T0);

    const macKey = await mac.receiveCommit(relayAsPhone.commit, T0 + 1, { ephemeral: await fixedKeyPair("mac") });
    const relayKey = await relayAsMac.receiveCommit(phone.commit, T0 + 1, { ephemeral: await fixedKeyPair("relayPhoneSide") });
    const macSide = await mac.receiveProof(await relayAsPhone.phone.receiveKey(macKey), T0 + 2);
    const phoneMiddle = await relayAsMac.receiveProof(await phone.phone.receiveKey(relayKey), T0 + 2);
    const phoneSide = await phone.phone.receiveConfirm(phoneMiddle.confirm);
    expect(phoneSide.checkCode).not.toBe(macSide.checkCode);
  });

  it("each step runs once, and a refused step ends the pairing", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(offer);
    const key = await mac.receiveCommit(phone.commit, T0 + 1);
    const proof = await phone.phone.receiveKey(key);
    expect(await refusal(() => phone.phone.receiveKey(key))).toBe("used");
    expect(await refusal(() => mac.receiveProof(flipBit(proof, 80), T0 + 2))).toBe("unauthenticated");
    expect(await refusal(() => mac.receiveProof(proof, T0 + 2))).toBe("closed");
  });

  it("pins every byte of a pairing run with fixed keys, so the layout in the README cannot drift", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const mac = macPairing(offer, T0);
    const phone = await startPairing(offer, { ephemeral: await fixedKeyPair("phone") });
    const key = await mac.receiveCommit(phone.commit, T0 + 1, { ephemeral: await fixedKeyPair("mac") });
    const proof = await phone.phone.receiveKey(key);
    const macSide = await mac.receiveProof(proof, T0 + 2);
    const phoneSide = await phone.phone.receiveConfirm(macSide.confirm);
    const [record] = await macSide.channel.seal(text("grant"));
    expect({
      commit: toHex(phone.commit),
      key: toHex(key),
      proof: toHex(proof),
      confirm: toHex(macSide.confirm),
      checkCode: phoneSide.checkCode,
      record: toHex(record!),
    }).toMatchSnapshot();
  });
});
