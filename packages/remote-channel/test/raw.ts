import { type Bytes, fromBase64Url, uuidToBytes } from "../src/index";
import { HOST_ID } from "./support";

/// The README's constructions written straight against Web Crypto, without the package: used to
/// check the package's bytes, and to play someone who knows a code's secret and breaks the
/// protocol's order on purpose, which the package itself never lets a caller do.

const subtle = crypto.subtle;
export const enc = (value: string): Bytes => new TextEncoder().encode(value) as Bytes;

export function cat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await subtle.digest("SHA-256", cat(...parts)));
}

export async function publicBytes(pair: CryptoKeyPair): Promise<Bytes> {
  return new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
}

export async function ecdh(own: CryptoKeyPair, peer: Uint8Array): Promise<Bytes> {
  const key = await subtle.importKey("raw", cat(peer), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: key }, own.privateKey, 256));
}

export async function hkdf(secret: Uint8Array, salt: Uint8Array, label: string, th: Uint8Array, bytes: number): Promise<Bytes> {
  const key = await subtle.importKey("raw", cat(secret), "HKDF", false, ["deriveBits"]);
  const info = cat(enc(label), Uint8Array.of(0), th);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: cat(salt), info }, key, bytes * 8));
}

export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const k = await subtle.importKey("raw", cat(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, cat(data)));
}

/// A pairing commit message for `pair`'s public key.
export async function commitFor(pair: CryptoKeyPair): Promise<Bytes> {
  return cat(Uint8Array.of(0x10, 0x01), await sha256(enc("manut-remote-v1 pair commit"), await publicBytes(pair)));
}

/// A proof message revealing `revealed`, with a phone proof that is correct for `revealed`, after
/// `commit` was sent and the Mac answered with `key`: what someone who has the code's secret sends
/// when it reveals a key other than the one it committed to.
export async function proofRevealing(revealed: CryptoKeyPair, secret: Uint8Array, doorId: string, commit: Bytes, key: Bytes): Promise<Bytes> {
  const proofCore = cat(Uint8Array.of(0x12, 0x01), await publicBytes(revealed));
  const th = await sha256(enc("manut-remote-v1 pair"), fromBase64Url(HOST_ID), uuidToBytes(doorId), commit, key, proofCore);
  const shared = await ecdh(revealed, key.subarray(2));
  return cat(proofCore, await hmac(await hkdf(secret, shared, "manut-remote-v1 pair phone confirm", th, 32), th));
}
