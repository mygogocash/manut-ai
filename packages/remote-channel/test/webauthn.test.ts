import { describe, expect, it } from "vitest";
import { type Bytes, type StoredPasskey, fromHex, toBase64Url, verifyPasskeyAssertion, verifyPasskeyRegistration } from "../src/index";
import spec from "./fixtures/webauthn-l3-vectors.json";
import { FLAG, RP, assertion, authenticatorData, derFromRaw, newAuthenticator } from "./passkey";

/// Checking a passkey's answer as WebAuthn Level 3 section 7.2 says, and its creation as section
/// 7.1 says, with the spec's own test vectors (section 16) for the byte layout and a stand-in
/// authenticator for each way an answer must be refused.

const vector = spec.vectors["16.7 packed ES256 (UP, UV and BE set)"];
const noUv = spec.vectors["16.2 ES256 with no attestation (UV not set at authentication)"];
const crossOrigin = spec.vectors["16.4 ES256 with crossOrigin true"];
const topOrigin = spec.vectors["16.5 ES256 with topOrigin"];
const SPEC_RP = { id: spec.rpId, origin: spec.origin };

function passkeyOf(v: typeof vector, signCount = 0): StoredPasskey {
  return {
    credentialId: fromHex(v.credentialId),
    publicKey: Uint8Array.of(0x04, ...fromHex(v.publicKey.x), ...fromHex(v.publicKey.y)),
    signCount,
  };
}

function specAssertion(v: typeof vector) {
  return {
    credentialId: fromHex(v.credentialId),
    clientDataJSON: fromHex(v.authentication.clientDataJSON),
    authenticatorData: fromHex(v.authentication.authenticatorData),
    signature: fromHex(v.authentication.signature),
  };
}

describe("the spec's test vectors", () => {
  it("16.7: a passkey made with Face ID is registered, and its answer is accepted", async () => {
    const registered = await verifyPasskeyRegistration(
      {
        credentialId: fromHex(vector.credentialId),
        clientDataJSON: fromHex(vector.registration.clientDataJSON),
        authenticatorData: fromHex(vector.registration.authenticatorData),
      },
      { challenge: fromHex(vector.registration.challenge), rp: SPEC_RP },
    );
    expect(registered).toEqual({ ok: true, passkey: passkeyOf(vector) });
    const result = await verifyPasskeyAssertion(specAssertion(vector), {
      challenge: fromHex(vector.authentication.challenge),
      rp: SPEC_RP,
      passkey: passkeyOf(vector),
    });
    expect(result).toEqual({ ok: true, signCount: 0 });
  });

  it("16.2: an answer with the user-verified flag unset is refused, and so is such a passkey", async () => {
    const result = await verifyPasskeyAssertion(specAssertion(noUv), {
      challenge: fromHex(noUv.authentication.challenge),
      rp: SPEC_RP,
      passkey: passkeyOf(noUv),
    });
    expect(result).toEqual({ ok: false, refused: "no_verification" });
    const registered = await verifyPasskeyRegistration(
      {
        credentialId: fromHex(noUv.credentialId),
        clientDataJSON: fromHex(noUv.registration.clientDataJSON),
        authenticatorData: fromHex(noUv.registration.authenticatorData),
      },
      { challenge: fromHex(noUv.registration.challenge), rp: SPEC_RP },
    );
    expect(registered).toEqual({ ok: false, refused: "no_verification" });
  });

  it("16.4 and 16.5: an answer made inside another site's frame is refused", async () => {
    for (const v of [crossOrigin, topOrigin]) {
      const result = await verifyPasskeyAssertion(specAssertion(v), {
        challenge: fromHex(v.authentication.challenge),
        rp: SPEC_RP,
        passkey: passkeyOf(v),
      });
      expect(result).toEqual({ ok: false, refused: "cross_origin" });
    }
  });

  it("refuses the spec's answer for the wrong origin, the wrong RP id, another challenge or a changed signature", async () => {
    const expected = { challenge: fromHex(vector.authentication.challenge), rp: SPEC_RP, passkey: passkeyOf(vector) };
    const check = (changes: Partial<typeof expected>, a = specAssertion(vector)) => verifyPasskeyAssertion(a, { ...expected, ...changes });
    expect(await check({ rp: { id: spec.rpId, origin: "https://example.com" } })).toEqual({ ok: false, refused: "wrong_origin" });
    expect(await check({ rp: { id: "dev.example.org", origin: spec.origin } })).toEqual({ ok: false, refused: "wrong_rp" });
    expect(await check({ challenge: new Uint8Array(32) })).toEqual({ ok: false, refused: "wrong_challenge" });
    const signature = fromHex(vector.authentication.signature);
    signature[10] = (signature[10] ?? 0) ^ 1;
    expect(await check({}, { ...specAssertion(vector), signature })).toEqual({ ok: false, refused: "bad_signature" });
  });
});

describe("a passkey's answer", () => {
  const challenge = new Uint8Array(32).fill(0x2a);

  it("is accepted when everything holds", async () => {
    const authenticator = await newAuthenticator();
    const result = await verifyPasskeyAssertion(await assertion(authenticator, challenge), { challenge, rp: RP, passkey: authenticator.passkey });
    expect(result).toEqual({ ok: true, signCount: 0 });
  });

  it("refuses each broken part by name", async () => {
    const authenticator = await newAuthenticator();
    const other = await newAuthenticator();
    const expected = { challenge, rp: RP, passkey: authenticator.passkey };
    const cases: [string, Awaited<ReturnType<typeof assertion>>, string][] = [
      ["the wrong origin", await assertion(authenticator, challenge, { origin: "https://evil.example" }), "wrong_origin"],
      ["the dev origin on production", await assertion(authenticator, challenge, { origin: "https://dev.manut.xyz" }), "wrong_origin"],
      ["the wrong relying-party id hash", await assertion(authenticator, challenge, { rpId: "dev.manut.xyz" }), "wrong_rp"],
      ["the user-verified flag unset", await assertion(authenticator, challenge, { flags: FLAG.UP }), "no_verification"],
      ["the user-present flag unset", await assertion(authenticator, challenge, { flags: FLAG.UV }), "no_presence"],
      ["a challenge that is not the one issued", await assertion(authenticator, challenge, { challenge: new Uint8Array(32) }), "wrong_challenge"],
      ["a registration's client data", await assertion(authenticator, challenge, { type: "webauthn.create" }), "wrong_type"],
      ["a signature by another key", await assertion(other, challenge), "bad_signature"],
      ["another credential", await assertion(authenticator, challenge, { credentialId: new Uint8Array(16) }), "wrong_credential"],
      ["crossOrigin true", await assertion(authenticator, challenge, { clientExtras: { crossOrigin: true } }), "cross_origin"],
      ["a topOrigin", await assertion(authenticator, challenge, { clientExtras: { topOrigin: "https://manut.xyz" } }), "cross_origin"],
      ["crossOrigin that is not a boolean", await assertion(authenticator, challenge, { clientExtras: { crossOrigin: "false" } }), "malformed"],
      ["attested credential data in an answer", await assertion(authenticator, challenge, { flags: FLAG.UP | FLAG.UV | FLAG.AT }), "malformed"],
      ["backed up but not eligible", await assertion(authenticator, challenge, { flags: FLAG.UP | FLAG.UV | FLAG.BS }), "malformed"],
      ["bytes after the data with no extensions flag", await assertion(authenticator, challenge, { authenticatorExtra: Uint8Array.of(0xa0) }), "malformed"],
      ["client data that is not JSON", await assertion(authenticator, challenge, { clientDataText: "webauthn.get" }), "malformed"],
      ["client data that is a list", await assertion(authenticator, challenge, { clientDataText: "[]" }), "malformed"],
    ];
    for (const [name, answer, refused] of cases) {
      expect(await verifyPasskeyAssertion(answer, expected), name).toEqual({ ok: false, refused });
    }
  });

  it("accepts extensions only when their flag says they are there, and still checks the signature over them", async () => {
    const authenticator = await newAuthenticator();
    const withExtensions = await assertion(authenticator, challenge, { flags: FLAG.UP | FLAG.UV | FLAG.ED, authenticatorExtra: Uint8Array.of(0xa0) });
    expect(await verifyPasskeyAssertion(withExtensions, { challenge, rp: RP, passkey: authenticator.passkey })).toEqual({ ok: true, signCount: 0 });
    const cut = { ...withExtensions, authenticatorData: withExtensions.authenticatorData.slice(0, 37) };
    expect(await verifyPasskeyAssertion(cut, { challenge, rp: RP, passkey: authenticator.passkey })).toEqual({ ok: false, refused: "bad_signature" });
  });

  it("refuses a signature changed in any bit, or in a DER spelling other than the one", async () => {
    const authenticator = await newAuthenticator();
    const answer = await assertion(authenticator, challenge);
    for (let index = 0; index < answer.signature.length; index++) {
      const signature = answer.signature.slice();
      signature[index] = (signature[index] ?? 0) ^ 0x01;
      const result = await verifyPasskeyAssertion({ ...answer, signature }, { challenge, rp: RP, passkey: authenticator.passkey });
      expect(result, `signature byte ${index}`).toEqual({ ok: false, refused: "bad_signature" });
    }
    // The same r and s with a needless leading zero, a long-form length, or a byte after the end.
    const sig = answer.signature;
    const rLength = sig[3]!;
    const padded = Uint8Array.of(0x30, sig[1]! + 1, 0x02, rLength + 1, 0x00, ...sig.slice(4)) as Bytes;
    const longForm = Uint8Array.of(0x30, 0x81, ...sig.slice(1)) as Bytes;
    const trailing = Uint8Array.of(...sig, 0x00) as Bytes;
    const trailingInside = Uint8Array.of(0x30, sig[1]! + 1, ...sig.slice(2), 0x00) as Bytes;
    for (const signature of [padded, longForm, trailing, trailingInside, new Uint8Array(0) as Bytes, Uint8Array.of(0x30, 0x00) as Bytes]) {
      const result = await verifyPasskeyAssertion({ ...answer, signature }, { challenge, rp: RP, passkey: authenticator.passkey });
      expect(result).toEqual({ ok: false, refused: "bad_signature" });
    }
    // A raw r || s, as Web Crypto signs, is not what an authenticator sends.
    expect(derFromRaw(new Uint8Array(64).fill(1))[0]).toBe(0x30);
  });

  it("refuses a signature counter that went backwards or stood still, and accepts one that moved on", async () => {
    const authenticator = await newAuthenticator(0xc1, 5);
    const at = async (signCount: number) =>
      verifyPasskeyAssertion(await assertion(authenticator, challenge, { signCount }), { challenge, rp: RP, passkey: authenticator.passkey });
    expect(await at(4)).toEqual({ ok: false, refused: "counter" });
    expect(await at(5)).toEqual({ ok: false, refused: "counter" });
    expect(await at(0)).toEqual({ ok: false, refused: "counter" });
    expect(await at(6)).toEqual({ ok: true, signCount: 6 });
    // A synced passkey (iCloud Keychain) always says 0, and so does what was stored for it.
    const synced = await newAuthenticator(0xc2, 0);
    const result = await verifyPasskeyAssertion(await assertion(synced, challenge), { challenge, rp: RP, passkey: synced.passkey });
    expect(result).toEqual({ ok: true, signCount: 0 });
  });
});

describe("a passkey's creation", () => {
  const challenge = new Uint8Array(32).fill(0x3c);

  /// The registration a browser would return, built from the spec vector's layout with this
  /// test's own key: attested credential data, then the COSE key in CTAP2's canonical form.
  async function registration(shape: { flags?: number; rpId?: string; type?: string; credentialId?: Uint8Array; cose?: Uint8Array; extra?: Uint8Array } = {}) {
    const authenticator = await newAuthenticator();
    const credentialId = authenticator.passkey.credentialId;
    const x = authenticator.passkey.publicKey.slice(1, 33);
    const y = authenticator.passkey.publicKey.slice(33, 65);
    const cose = shape.cose ?? Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y);
    const attested = Uint8Array.of(...new Uint8Array(16), 0x00, credentialId.length, ...credentialId, ...cose, ...(shape.extra ?? []));
    const data = await authenticatorData(shape.rpId ?? RP.id, shape.flags ?? FLAG.UP | FLAG.UV | FLAG.AT, 0, attested);
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: shape.type ?? "webauthn.create",
      challenge: toBase64Url(challenge),
      origin: RP.origin,
      crossOrigin: false,
    }));
    return { authenticator, input: { credentialId: shape.credentialId ?? credentialId, clientDataJSON, authenticatorData: data } };
  }

  it("keeps the credential id and the public key the authenticator attested", async () => {
    const { authenticator, input } = await registration();
    expect(await verifyPasskeyRegistration(input, { challenge, rp: RP })).toEqual({ ok: true, passkey: authenticator.passkey });
  });

  it("refuses each broken part by name", async () => {
    const cases: [string, Awaited<ReturnType<typeof registration>>, string][] = [
      ["no user verification", await registration({ flags: FLAG.UP | FLAG.AT }), "no_verification"],
      ["no attested credential data", await registration({ flags: FLAG.UP | FLAG.UV }), "malformed"],
      ["the wrong RP id", await registration({ rpId: "dev.manut.xyz" }), "wrong_rp"],
      ["an answer's client data", await registration({ type: "webauthn.get" }), "wrong_type"],
      ["another credential id than the one attested", await registration({ credentialId: new Uint8Array(16) }), "wrong_credential"],
      ["a key that is not ES256 in CTAP2's form", await registration({ cose: Uint8Array.of(0xa4, 0x01, 0x01) }), "unsupported_key"],
      ["bytes after the key with no extensions flag", await registration({ extra: Uint8Array.of(0xa0) }), "malformed"],
    ];
    for (const [name, { input }, refused] of cases) {
      expect(await verifyPasskeyRegistration(input, { challenge, rp: RP }), name).toEqual({ ok: false, refused });
    }
    const { input } = await registration();
    expect(await verifyPasskeyRegistration(input, { challenge: new Uint8Array(32), rp: RP })).toEqual({ ok: false, refused: "wrong_challenge" });
    expect(await verifyPasskeyRegistration(input, { challenge, rp: { ...RP, origin: "https://dev.manut.xyz" } })).toEqual({ ok: false, refused: "wrong_origin" });
  });
});
