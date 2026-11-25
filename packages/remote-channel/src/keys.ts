import { type Bytes, concatBytes, copyBytes, utf8 } from "./bytes";
import { RemoteChannelError, guarded } from "./errors";

/// The key schedule both handshakes share, and the only place this package calls Web Crypto for
/// key agreement and derivation. Every primitive is Web Crypto's own: ECDH on P-256, HKDF with
/// SHA-256 (RFC 5869), HMAC-SHA-256 and SHA-256. Nothing here is a primitive of ours.
///
/// The shape is TLS 1.3's PSK with (EC)DHE key exchange (RFC 8446, section 4.2.9 `psk_dhe_ke`,
/// with its key schedule in section 7.1 and Finished in 4.4.4): a fresh ECDH secret and a
/// pre-shared secret both feed HKDF, every key is derived with a label and the hash of the
/// transcript, and each side proves it holds the keys with an HMAC over that transcript hash. It
/// stands in for GoSpark's TLS-PSK session (`docs/relay-protocol-v1.md`, RT-6), which no browser
/// offers, and unlike that suite it gives each session forward secrecy.

/// Uncompressed P-256 public key: `04`, then X, then Y (SEC 1, section 2.3.3).
export const PUBLIC_KEY_BYTES = 65;
/// The pairing secret and K: 256 bits, as GoSpark's `RemoteAuthentication.randomKey()`.
export const SECRET_BYTES = 32;
export const HASH_BYTES = 32;

const ECDH: EcKeyImportParams = { name: "ECDH", namedCurve: "P-256" };

/// A throwaway key pair for one handshake. Its private half cannot be exported.
export async function ephemeralKeyPair(): Promise<CryptoKeyPair> {
  return guarded("invalid", async () => (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair);
}

export async function exportPublicKey(pair: CryptoKeyPair): Promise<Bytes> {
  const raw = copyBytes(new Uint8Array(await guarded("invalid", () => crypto.subtle.exportKey("raw", pair.publicKey))));
  if (raw.length !== PUBLIC_KEY_BYTES || raw[0] !== 0x04) throw new RemoteChannelError("invalid");
  return raw;
}

/// The other side's public key. Web Crypto refuses a point that is not on the curve, so a relay
/// cannot slip in an invalid-curve point; the length and the `04` prefix are checked first so a
/// compressed or short key is refused the same way in every browser.
async function importPeerKey(bytes: Bytes): Promise<CryptoKey> {
  if (bytes.length !== PUBLIC_KEY_BYTES || bytes[0] !== 0x04) throw new RemoteChannelError("malformed");
  return guarded("malformed", () => crypto.subtle.importKey("raw", bytes, ECDH, false, []));
}

/// The 32-byte ECDH shared secret: the X coordinate of the shared point (SEC 1, section 3.3.1),
/// which is what Web Crypto's `deriveBits` for ECDH returns.
export async function sharedSecret(own: CryptoKeyPair, peer: Bytes): Promise<Bytes> {
  const peerKey = await importPeerKey(peer);
  return guarded("malformed", async () =>
    copyBytes(new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, own.privateKey, 256))));
}

/// The pairing secret or K as an HKDF key that script cannot read back. A caller that already
/// keeps K as such a key (the desktop imports it from the keychain, the phone from IndexedDB)
/// passes the key itself.
export async function importSharedSecret(secret: Uint8Array): Promise<CryptoKey> {
  if (secret.length !== SECRET_BYTES) throw new RemoteChannelError("invalid");
  return guarded("invalid", () => crypto.subtle.importKey("raw", copyBytes(secret), "HKDF", false, ["deriveBits"]));
}

/// The secret as an HKDF key, whichever form it came in.
export async function secretKey(secret: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (secret instanceof Uint8Array) return importSharedSecret(secret);
  if (secret.algorithm.name !== "HKDF" || !secret.usages.includes("deriveBits")) throw new RemoteChannelError("invalid");
  return secret;
}

export async function sha256(...parts: readonly Uint8Array[]): Promise<Bytes> {
  return copyBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", concatBytes(...parts))));
}

/// HKDF-SHA-256 (RFC 5869). The long-term secret (the pairing secret or K) is the input keying
/// material and the ECDH secret is the salt, so both must be known to get any output: without
/// the long-term secret a relay that ran ECDH with one side learns nothing, and someone who later
/// learns the long-term secret still needs an ECDH secret that was never stored. The secret goes
/// in as the input keying material because Web Crypto's HKDF takes its key that way, which lets
/// K stay a key that script cannot read back. The info is a label, a zero byte and the
/// transcript hash, so each key belongs to one purpose of one handshake.
export async function derive(secret: CryptoKey, ecdh: Bytes, label: string, transcriptHash: Bytes, bytes: number): Promise<Bytes> {
  const info = concatBytes(utf8(label), Uint8Array.of(0), transcriptHash);
  return guarded("invalid", async () =>
    copyBytes(new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ecdh, info }, secret, bytes * 8))));
}

/// HMAC-SHA-256 of `data` under a derived key.
export async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  return guarded("invalid", async () => {
    const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return copyBytes(new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data)));
  });
}

export async function aesKey(raw: Bytes): Promise<CryptoKey> {
  return guarded("invalid", () => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
}

/// What a handshake hands the channel: one key and one IV for each direction. Keys are
/// non-extractable Web Crypto keys; the IVs are not secret on their own.
export interface DirectionKeys {
  readonly key: CryptoKey;
  readonly iv: Bytes;
}

export interface HandshakeKeys {
  readonly phoneConfirm: Bytes;
  readonly macConfirm: Bytes;
  readonly phoneToMac: DirectionKeys;
  readonly macToPhone: DirectionKeys;
}

/// Every key one handshake needs, from its purpose (`pair` or `session`), the long-term secret,
/// the ECDH secret and the transcript hash. The two confirm keys differ, so neither side's proof
/// can be sent back as the other's; the two directions differ, so a record cannot be sent back.
export async function handshakeKeys(purpose: "pair" | "session", secret: CryptoKey, ecdh: Bytes, th: Bytes): Promise<HandshakeKeys> {
  const label = (name: string) => `manut-remote-v1 ${purpose} ${name}`;
  const [phoneConfirm, macConfirm, phoneToMacKey, phoneToMacIv, macToPhoneKey, macToPhoneIv] = await Promise.all([
    derive(secret, ecdh, label("phone confirm"), th, 32),
    derive(secret, ecdh, label("mac confirm"), th, 32),
    derive(secret, ecdh, label("phone to mac key"), th, 32),
    derive(secret, ecdh, label("phone to mac iv"), th, 12),
    derive(secret, ecdh, label("mac to phone key"), th, 32),
    derive(secret, ecdh, label("mac to phone iv"), th, 12),
  ]);
  const keys: HandshakeKeys = {
    phoneConfirm,
    macConfirm,
    phoneToMac: { key: await aesKey(phoneToMacKey), iv: phoneToMacIv },
    macToPhone: { key: await aesKey(macToPhoneKey), iv: macToPhoneIv },
  };
  // Best effort: the raw key bytes are no longer needed once imported. JavaScript cannot promise
  // that no copy survives, which is why the keys themselves are non-extractable.
  phoneToMacKey.fill(0);
  macToPhoneKey.fill(0);
  return keys;
}
