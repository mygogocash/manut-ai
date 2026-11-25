import { type Bytes, concatBytes, copyBytes, equalBytes, toBase64Url, utf8 } from "./bytes";
import { sha256 } from "./keys";

/// Checking a passkey (WebAuthn) on the Mac. The phone's answer to a decision challenge is a
/// passkey assertion that needs Face ID or the passcode; the Mac checks it as the W3C Web
/// Authentication Level 3 specification's section 7.2 ("Verifying an Authentication Assertion")
/// says, and checks the passkey's creation at pairing as section 7.1 says. GoSpark's phone signed
/// with a Secure Enclave key instead (`Shared/Remote/RemoteDecisionChallenges.swift`), which a web
/// app cannot make; a passkey is the browser's way to a key that needs the person's face.
///
/// The layouts this reads, from the specification:
///
/// ```text
/// clientDataJSON      UTF-8 JSON (section 5.8.1): type, challenge (base64url, no padding),
///                     origin, crossOrigin (optional boolean), topOrigin (optional)
/// authenticatorData   rpIdHash (32, SHA-256 of the RP id) | flags (1) | signCount (4, big-endian)
///                     | attestedCredentialData (if AT) | extensions (CBOR map, if ED)   (section 6.1)
///   flags             bit 0 UP, bit 2 UV, bit 3 BE, bit 4 BS, bit 6 AT, bit 7 ED
///   attested data     aaguid (16) | credentialIdLength (2, big-endian, at most 1023)
///                     | credentialId | credentialPublicKey (COSE_Key, CTAP2 canonical CBOR)   (6.5.1)
/// signature           ES256: an ASN.1 DER Ecdsa-Sig-Value (RFC 3279, 2.2.3) over
///                     authenticatorData || SHA-256(clientDataJSON)   (sections 6.5.5 and 7.2)
/// ```
///
/// Only ES256 (COSE algorithm -7, ECDSA on P-256 with SHA-256) is taken, which every platform
/// passkey offers when asked for it. No attestation is read: the passkey's public key arrives at
/// pairing over the channel the pairing secret proved, so the phone that sends it is the phone
/// being paired; attestation would only say which maker built the authenticator.

/// What the Mac expects the passkey to be bound to: its exact host as the RP id, so a passkey made
/// on the dev site never answers in production (`docs/remote-access.md`, "Domain"), and the
/// exact origin of the page that asks.
export interface RelyingParty {
  readonly id: string;
  readonly origin: string;
}

/// What the Mac keeps for a paired phone's passkey.
export interface StoredPasskey {
  readonly credentialId: Uint8Array;
  /// The uncompressed P-256 point: 04, X, Y.
  readonly publicKey: Uint8Array;
  /// The last signature counter seen; 0 for a passkey that does not count (a synced one).
  readonly signCount: number;
}

/// What the phone sends back from `navigator.credentials.get()`: `rawId`, and the response's
/// `clientDataJSON`, `authenticatorData` and `signature`.
export interface PasskeyAssertion {
  readonly credentialId: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly signature: Uint8Array;
}

/// What the phone sends back from `navigator.credentials.create()`: `rawId`, and the response's
/// `clientDataJSON` and `getAuthenticatorData()`.
export interface PasskeyRegistration {
  readonly credentialId: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  readonly authenticatorData: Uint8Array;
}

/// Why an answer or a creation was refused. None of these names a value.
/// - `wrong_credential`: another passkey than the one this phone registered.
/// - `malformed`: bytes that do not have the specification's layout.
/// - `wrong_type`: client data of a creation sent as an answer, or the other way round.
/// - `wrong_challenge`: the passkey signed another challenge than the one issued.
/// - `wrong_origin`: made on another site than the expected origin.
/// - `cross_origin`: made inside another site's frame (`crossOrigin` true or a `topOrigin`).
/// - `wrong_rp`: the relying-party id hash is not the SHA-256 of the expected RP id.
/// - `no_presence`: the user-present flag is unset.
/// - `no_verification`: the user-verified flag is unset: no Face ID and no passcode.
/// - `bad_signature`: the signature does not verify, or is not one DER spelling of one.
/// - `counter`: the signature counter did not move past the stored one.
/// - `unsupported_key`: a passkey whose key is not ES256 in the form the specification requires.
export type PasskeyRefusal =
  | "wrong_credential"
  | "malformed"
  | "wrong_type"
  | "wrong_challenge"
  | "wrong_origin"
  | "cross_origin"
  | "wrong_rp"
  | "no_presence"
  | "no_verification"
  | "bad_signature"
  | "counter"
  | "unsupported_key";

export type AssertionResult = { readonly ok: true; readonly signCount: number } | { readonly ok: false; readonly refused: PasskeyRefusal };
export type RegistrationResult = { readonly ok: true; readonly passkey: StoredPasskey } | { readonly ok: false; readonly refused: PasskeyRefusal };

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;
const ED = 0x80;
const BASE_BYTES = 37;
/// No platform sends client data or authenticator data near this size; the cap keeps a hostile
/// answer from costing the Mac a large parse.
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_CREDENTIAL_ID_BYTES = 1023;
/// The ES256 COSE key in CTAP2 canonical CBOR, as section 6.5.1.1 shows it: a map of five
/// entries, kty 2 (EC2), alg -7 (ES256), crv 1 (P-256), then x and y as 32-byte strings. The
/// specification requires exactly this form (canonical encoding, alg present, no other optional
/// entries), so the key is read by matching it rather than by a general CBOR parser.
const COSE_PREFIX = Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20);
const COSE_Y = Uint8Array.of(0x22, 0x58, 0x20);
const COSE_KEY_BYTES = COSE_PREFIX.length + 32 + COSE_Y.length + 32;

type Refused = { readonly ok: false; readonly refused: PasskeyRefusal };

function allBytes(...values: unknown[]): boolean {
  return values.every((value) => value instanceof Uint8Array);
}
const refuse = (refused: PasskeyRefusal): Refused => ({ ok: false, refused });

/// Steps 8 to 14 of sections 7.1 and 7.2: the client data, read as UTF-8 (a leading byte-order
/// mark dropped, as the specification's UTF-8 decode does) and JSON.
function readClientData(bytes: Bytes, type: string, challenge: Bytes, rp: RelyingParty): Refused | null {
  if (bytes.length > MAX_FIELD_BYTES) return refuse("malformed");
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse("malformed");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return refuse("malformed");
  const fields = data as Record<string, unknown>;
  if (typeof fields.type !== "string" || typeof fields.challenge !== "string" || typeof fields.origin !== "string") {
    return refuse("malformed");
  }
  if (fields.crossOrigin !== undefined && typeof fields.crossOrigin !== "boolean") return refuse("malformed");
  if (fields.type !== type) return refuse("wrong_type");
  // The challenge is not a secret (the Mac sent it to the phone), but it is compared without an
  // early exit all the same, like everything else this package checks.
  if (!equalBytes(utf8(fields.challenge), utf8(toBase64Url(challenge)))) return refuse("wrong_challenge");
  if (fields.origin !== rp.origin) return refuse("wrong_origin");
  // This page is never framed by another site, so either sign of a frame is refused.
  if (fields.crossOrigin === true || fields.topOrigin !== undefined) return refuse("cross_origin");
  return null;
}

/// The fixed 37 bytes of authenticator data: the RP id hash, the flags both ceremonies require
/// (user present, user verified, and backup state only with backup eligibility), and the counter.
async function readAuthenticatorData(bytes: Bytes, rp: RelyingParty): Promise<Refused | { flags: number; signCount: number }> {
  if (bytes.length < BASE_BYTES || bytes.length > MAX_FIELD_BYTES) return refuse("malformed");
  if (!equalBytes(bytes.subarray(0, 32), await sha256(utf8(rp.id)))) return refuse("wrong_rp");
  const flags = bytes[32] ?? 0;
  if ((flags & BS) !== 0 && (flags & BE) === 0) return refuse("malformed");
  if ((flags & UP) === 0) return refuse("no_presence");
  if ((flags & UV) === 0) return refuse("no_verification");
  return { flags, signCount: new DataView(bytes.buffer, bytes.byteOffset).getUint32(33) };
}

/// One DER INTEGER of an ECDSA signature, as 32 bytes, or null for anything but the one minimal,
/// positive spelling of a value that fits.
function derInteger(sig: Bytes, at: number): { value: Bytes; next: number } | null {
  if (sig[at] !== 0x02) return null;
  const length = sig[at + 1] ?? 0;
  const start = at + 2;
  if (length < 1 || length > 33 || start + length > sig.length) return null;
  const body = sig.subarray(start, start + length);
  const first = body[0] ?? 0;
  if ((first & 0x80) !== 0) return null;
  if (length > 1 && first === 0 && ((body[1] ?? 0) & 0x80) === 0) return null;
  const digits = first === 0 && length > 1 ? body.subarray(1) : body;
  if (digits.length > 32) return null;
  const value = new Uint8Array(32);
  value.set(digits, 32 - digits.length);
  return { value, next: start + length };
}

/// The Ecdsa-Sig-Value as Web Crypto's raw `r || s`, or null when it is not strict DER: a
/// SEQUENCE with a short-form length that covers exactly the two INTEGERs and nothing after.
function rawSignature(sig: Bytes): Bytes | null {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1] !== sig.length - 2) return null;
  const r = derInteger(sig, 2);
  if (r === null) return null;
  const s = derInteger(sig, r.next);
  if (s === null || s.next !== sig.length) return null;
  if (r.value.every((byte) => byte === 0) || s.value.every((byte) => byte === 0)) return null;
  return concatBytes(r.value, s.value);
}

async function importPublicKey(publicKey: Bytes): Promise<CryptoKey | null> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) return null;
  try {
    return await crypto.subtle.importKey("raw", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return null;
  }
}

/// Section 7.2, for a passkey that must have seen the person's face or passcode just now.
/// Returns the new signature counter for the caller to store when the answer holds.
export async function verifyPasskeyAssertion(
  answer: PasskeyAssertion,
  expected: { readonly challenge: Uint8Array; readonly rp: RelyingParty; readonly passkey: StoredPasskey },
): Promise<AssertionResult> {
  // The answer arrives decoded from the phone, so its fields are checked to be bytes before use.
  if (!allBytes(answer.credentialId, answer.clientDataJSON, answer.authenticatorData, answer.signature)) return refuse("malformed");
  const clientDataJSON = copyBytes(answer.clientDataJSON);
  const authenticatorData = copyBytes(answer.authenticatorData);
  const signature = copyBytes(answer.signature);
  const challenge = copyBytes(expected.challenge);
  // Step 5: the credential is the one this phone registered.
  if (!equalBytes(answer.credentialId, expected.passkey.credentialId)) return refuse("wrong_credential");
  const client = readClientData(clientDataJSON, "webauthn.get", challenge, expected.rp);
  if (client !== null) return client;
  const auth = await readAuthenticatorData(authenticatorData, expected.rp);
  if ("ok" in auth) return auth;
  // Section 6.1: an assertion never carries attested credential data, and without the extensions
  // flag nothing follows the 37 bytes.
  if ((auth.flags & AT) !== 0) return refuse("malformed");
  if ((auth.flags & ED) === 0 && authenticatorData.length !== BASE_BYTES) return refuse("malformed");
  // Steps 20 and 21: the signature over authenticatorData || SHA-256(clientDataJSON).
  const raw = rawSignature(signature);
  const key = await importPublicKey(copyBytes(expected.passkey.publicKey));
  if (raw === null || key === null) return refuse("bad_signature");
  const signed = concatBytes(authenticatorData, await sha256(clientDataJSON));
  let verified = false;
  try {
    verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
  } catch {
    verified = false;
  }
  if (!verified) return refuse("bad_signature");
  // Step 22: a counter that did not move on is the specification's sign of a copied
  // authenticator, and the Mac refuses it. A synced passkey sends 0 every time, and a stored 0
  // with an answer of 0 is not compared.
  const stored = expected.passkey.signCount;
  if ((auth.signCount !== 0 || stored !== 0) && auth.signCount <= stored) return refuse("counter");
  return { ok: true, signCount: auth.signCount };
}

/// Section 7.1, for the passkey the phone makes at pairing, after the person pressed Allow. It
/// takes the key from the attested credential data itself (`getAuthenticatorData()`), so nothing
/// but the authenticator's own bytes says which key will answer later.
export async function verifyPasskeyRegistration(
  registration: PasskeyRegistration,
  expected: { readonly challenge: Uint8Array; readonly rp: RelyingParty },
): Promise<RegistrationResult> {
  if (!allBytes(registration.credentialId, registration.clientDataJSON, registration.authenticatorData)) return refuse("malformed");
  const clientDataJSON = copyBytes(registration.clientDataJSON);
  const data = copyBytes(registration.authenticatorData);
  const client = readClientData(clientDataJSON, "webauthn.create", copyBytes(expected.challenge), expected.rp);
  if (client !== null) return client;
  const auth = await readAuthenticatorData(data, expected.rp);
  if ("ok" in auth) return auth;
  if ((auth.flags & AT) === 0) return refuse("malformed");
  const view = new DataView(data.buffer);
  const idAt = BASE_BYTES + 16 + 2;
  if (data.length < idAt) return refuse("malformed");
  const idLength = view.getUint16(BASE_BYTES + 16);
  if (idLength < 1 || idLength > MAX_CREDENTIAL_ID_BYTES || data.length < idAt + idLength) return refuse("malformed");
  const credentialId = data.slice(idAt, idAt + idLength);
  if (!equalBytes(credentialId, registration.credentialId)) return refuse("wrong_credential");
  const keyAt = idAt + idLength;
  if (data.length < keyAt + COSE_KEY_BYTES) return refuse("unsupported_key");
  const cose = data.subarray(keyAt, keyAt + COSE_KEY_BYTES);
  const yAt = COSE_PREFIX.length + 32;
  if (!equalBytes(cose.subarray(0, COSE_PREFIX.length), COSE_PREFIX) || !equalBytes(cose.subarray(yAt, yAt + COSE_Y.length), COSE_Y)) {
    return refuse("unsupported_key");
  }
  if ((auth.flags & ED) === 0 && data.length !== keyAt + COSE_KEY_BYTES) return refuse("malformed");
  const publicKey = concatBytes(Uint8Array.of(0x04), cose.subarray(COSE_PREFIX.length, yAt), cose.subarray(yAt + COSE_Y.length));
  if ((await importPublicKey(publicKey)) === null) return refuse("unsupported_key");
  return { ok: true, passkey: { credentialId, publicKey, signCount: auth.signCount } };
}
