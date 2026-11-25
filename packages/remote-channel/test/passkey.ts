import { type Bytes, type StoredPasskey, toBase64Url } from "../src/index";

/// A stand-in authenticator for tests: a P-256 signing key, and assertions built byte for byte
/// as WebAuthn Level 3 lays them out (section 6.1, the authenticator data; section 5.8.1, the
/// client data; section 6.5.5, an ES256 signature as an ASN.1 DER Ecdsa-Sig-Value over
/// authenticatorData || SHA-256(clientDataJSON)). The spec's own vectors in
/// `fixtures/webauthn-l3-vectors.json` check the same reading against a real layout.

export const RP = { id: "manut.xyz", origin: "https://manut.xyz" } as const;

export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const;

const enc = (value: string): Bytes => new TextEncoder().encode(value) as Bytes;

function cat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/// A raw `r || s` signature, as Web Crypto makes one, as DER: each integer without leading zeros,
/// with one zero byte added where its top bit is set, inside a SEQUENCE.
export function derFromRaw(raw: Uint8Array): Bytes {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = bytes.slice(start);
    if ((body[0] ?? 0) & 0x80) body = cat(Uint8Array.of(0), body);
    return cat(Uint8Array.of(0x02, body.length), body);
  };
  const body = cat(integer(raw.slice(0, 32)), integer(raw.slice(32, 64)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export interface Authenticator {
  readonly keys: CryptoKeyPair;
  readonly passkey: StoredPasskey;
}

export async function newAuthenticator(credentialByte = 0xc1, signCount = 0): Promise<Authenticator> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { keys, passkey: { credentialId: new Uint8Array(16).fill(credentialByte), publicKey, signCount } };
}

export async function authenticatorData(rpId: string, flags: number, signCount: number, extra: Uint8Array = new Uint8Array(0)): Promise<Bytes> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc(rpId)));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, signCount);
  return cat(rpIdHash, Uint8Array.of(flags), count, extra);
}

export interface AssertionShape {
  readonly challenge?: Uint8Array;
  readonly type?: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly flags?: number;
  readonly signCount?: number;
  /// Extra client data fields, such as crossOrigin or topOrigin.
  readonly clientExtras?: Record<string, unknown>;
  /// The whole client data text, when a test needs bytes no browser would make.
  readonly clientDataText?: string;
  readonly authenticatorExtra?: Uint8Array;
  readonly credentialId?: Uint8Array;
}

/// What a browser returns from `navigator.credentials.get()` for this authenticator.
export async function assertion(authenticator: Authenticator, challenge: Uint8Array, shape: AssertionShape = {}) {
  const clientDataJSON = enc(shape.clientDataText ?? JSON.stringify({
    type: shape.type ?? "webauthn.get",
    challenge: toBase64Url(shape.challenge ?? challenge),
    origin: shape.origin ?? RP.origin,
    crossOrigin: false,
    ...shape.clientExtras,
  }));
  const data = await authenticatorData(
    shape.rpId ?? RP.id,
    shape.flags ?? FLAG.UP | FLAG.UV,
    shape.signCount ?? 0,
    shape.authenticatorExtra,
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, authenticator.keys.privateKey, cat(data, hash)));
  return {
    credentialId: shape.credentialId ?? authenticator.passkey.credentialId,
    clientDataJSON,
    authenticatorData: data,
    signature: derFromRaw(raw),
  };
}
