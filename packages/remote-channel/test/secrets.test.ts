import { describe, expect, it } from "vitest";
import {
  REMOTE_CHANNEL_MESSAGES,
  RemoteChannelError,
  acceptSession,
  decodePairingGrant,
  encodePairingGrant,
  macPairing,
  newPairingGrant,
  newPairingOffer,
  readPairingLink,
  startPairing,
  startSession,
  toBase64Url,
  toHex,
  encodePairingOffer,
} from "../src/index";
import { DEVICE_ID, HOST_ID, bytesOf, flipBit, openSession, seededRandom, text } from "./support";

/// Nothing secret in an error, a log or a printed value. Every refusal carries one of a fixed set
/// of sentences, so this checks the set itself and then drives every kind of refusal with known
/// secrets and looks for any spelling of them in what comes out.

const K = bytesOf(32, 0x5a);

/// Node's own printer, as a log would use it, reached without Node's type definitions, which this
/// package does not depend on.
const { inspect } = (await import("node:util" as string)) as { inspect: (value: unknown, options?: object) => string };

/// Every way a secret could be written into a string: hex in both cases, base64url, base64 and
/// the forms `JSON.stringify` and Node's printer give a byte array.
function spellings(secret: Uint8Array): string[] {
  const base64 = btoa(String.fromCharCode(...secret));
  return [
    toHex(secret),
    toHex(secret).toUpperCase(),
    toBase64Url(secret),
    base64,
    Array.from(secret).join(","),
    Array.from(secret).join(", "),
    JSON.stringify(Array.from(secret)),
    JSON.stringify(secret),
  ];
}

/// Node's printer lays long arrays out in rows, so runs of whitespace are folded to one space first.
function expectNoSecret(output: string, secrets: Uint8Array[]): void {
  const folded = output.replace(/\s+/g, " ");
  for (const secret of secrets) for (const spelling of spellings(secret)) expect(folded).not.toContain(spelling);
}

describe("secrets", () => {
  it("every error sentence is fixed and names no value", () => {
    for (const message of REMOTE_CHANNEL_MESSAGES) expect(message).toMatch(/^[A-Z][A-Za-z ,.']+\.$/);
    const error = new RemoteChannelError("unauthenticated");
    expect(error.message).toBe("A message from the other side did not prove who sent it.");
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/[0-9a-f]{16}/);
  });

  it("refusals in every part carry only the fixed sentences, and no spelling of the secrets at hand", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const secrets = [K, offer.secret, offer.doorToken];
    const errors: unknown[] = [];
    const collect = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };

    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    const accepted = await acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => K });
    await collect(() => started.phone.receiveWelcome(flipBit(accepted.welcome, 70)));
    await collect(() => accepted.mac.receiveFinish(new Uint8Array(34)));
    await collect(() => acceptSession(started.hello, { hostId: HOST_ID, secretFor: () => undefined }));
    await collect(() => startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K.slice(1) }));

    const { phone, mac } = await openSession(K);
    const [frame] = await phone.seal(text("secret words"));
    await collect(() => mac.open(flipBit(frame!, 20)));
    await collect(() => mac.open(frame!));

    const pairing = macPairing(offer, 0);
    const phonePairing = await startPairing({ ...offer, secret: bytesOf(32, 1) });
    const key = await pairing.receiveCommit(phonePairing.commit, 1);
    await collect(async () => pairing.receiveProof(await phonePairing.phone.receiveKey(key), 2));
    await collect(() => pairing.receiveCommit(phonePairing.commit, 3));
    await collect(async () => readPairingLink(`${encodePairingOffer(offer)}x`));
    await collect(async () => decodePairingGrant(encodePairingGrant(newPairingGrant()).slice(1)));

    expect(errors.length).toBe(10);
    for (const error of errors) {
      expect(error).toBeInstanceOf(RemoteChannelError);
      const refused = error as RemoteChannelError;
      expect(REMOTE_CHANNEL_MESSAGES).toContain(refused.message);
      expectNoSecret(`${refused.message}\n${refused.stack ?? ""}\n${inspect(refused, { breakLength: Infinity })}\n${JSON.stringify(refused)}`, secrets);
    }
  });

  it("a pairing code and a grant print with their secrets redacted", () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const grant = newPairingGrant(seededRandom(100));
    for (const value of [offer, grant, readPairingLink(encodePairingOffer(offer)), decodePairingGrant(encodePairingGrant(grant))]) {
      const printed = `${JSON.stringify(value)}\n${inspect(value, { breakLength: Infinity })}`;
      expect(printed).toContain("redacted");
      expectNoSecret(printed, [offer.secret, offer.doorToken, grant.secret, grant.doorToken]);
    }
    // The values themselves are untouched.
    expect(offer.secret).toHaveLength(32);
    expect(Object.keys(grant)).toEqual(["deviceId", "doorToken", "secret"]);
  });

  it("a channel or a handshake in progress prints no key", async () => {
    const offer = newPairingOffer(HOST_ID, seededRandom(1));
    const { phone, mac } = await openSession(K);
    const pairing = macPairing(offer, 0);
    const started = await startSession({ hostId: HOST_ID, deviceId: DEVICE_ID, secret: K });
    for (const value of [phone, mac, pairing, started.phone]) {
      expectNoSecret(`${JSON.stringify(value)}\n${inspect(value, { showHidden: true, depth: 5, breakLength: Infinity })}`, [K, offer.secret, offer.doorToken]);
    }
    expect(Object.keys(mac).sort()).toEqual(["deviceId", "role"]);
  });
});
