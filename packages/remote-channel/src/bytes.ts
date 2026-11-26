import { RemoteChannelError } from "./errors";

/// Bytes backed by a plain `ArrayBuffer`, the only kind Web Crypto's types take. Every value this
/// package keeps or returns is one, and every value it is given is copied into one first, so a
/// caller who changes their array after a check cannot change what was checked.
export type Bytes = Uint8Array<ArrayBuffer>;

/// A private copy of the caller's bytes.
export function copyBytes(bytes: Uint8Array): Bytes {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/// Compares two byte strings without stopping at the first difference, so the time it takes says
/// nothing about where a proof, a tag or a commitment went wrong. Lengths are public (every tag
/// here has a fixed length), so a length mismatch returns at once. The loop ORs every XOR into one
/// accumulator and reads it once at the end: there is no branch on the data inside the loop, which
/// is the usual way to compare in constant time in JavaScript (as `@noble/hashes`' `equalBytes`
/// does). A JavaScript engine promises nothing about timing, so this removes the early exit, the
/// leak that matters, and claims no more.
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const encoder = new TextEncoder();

export function utf8(text: string): Bytes {
  return copyBytes(encoder.encode(text));
}

/// A 16-bit length, then the UTF-8 bytes: how a text field goes into a hashed transcript, so that
/// two fields can never run into each other ("ab" + "c" and "a" + "bc" hash differently).
export function lengthPrefixed(text: string): Bytes {
  const bytes = utf8(text);
  if (bytes.length > 0xffff) throw new RemoteChannelError("invalid");
  return concatBytes(u16(bytes.length), bytes);
}

export function u16(value: number): Bytes {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function u32(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((char, index) => [char, index]));

/// base64url (RFC 4648 section 5) with no padding, as the relay and WebAuthn's `challenge` use it.
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) out += ALPHABET[(triple >> (18 - 6 * k)) & 63];
  }
  return out;
}

/// The strict inverse of `toBase64Url`: only the URL-safe alphabet, no padding, and only the one
/// spelling of each value (spare bits in the last character must be zero). Anything else throws
/// `malformed`, so a value can never arrive in two forms.
export function fromBase64Url(text: string): Bytes {
  if (text.length % 4 === 1) throw new RemoteChannelError("malformed");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    const digit = LOOKUP.get(char);
    if (digit === undefined) throw new RemoteChannelError("malformed");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  if ((value & ((1 << bits) - 1)) !== 0) throw new RemoteChannelError("malformed");
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Bytes {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(text)) throw new RemoteChannelError("malformed");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/// A device id exactly as the relay takes it (`apps/api/src/relay-object.ts`, `DEVICE_ID`): upper
/// case, 8-4-4-4-12, as Swift writes a UUID.
export const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export function uuidToBytes(id: string): Bytes {
  if (!DEVICE_ID.test(id)) throw new RemoteChannelError("invalid");
  return fromHex(id.replaceAll("-", ""));
}

export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RemoteChannelError("malformed");
  const hex = toHex(bytes).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/// A random version-4 UUID in the relay's form, from 16 bytes the caller supplies.
export function uuidV4(random: Uint8Array): string {
  if (random.length !== 16) throw new RemoteChannelError("invalid");
  const bytes = copyBytes(random);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return uuidFromBytes(bytes);
}

/// Gives a value that holds secrets a printed form with each of them shown as `redacted`, as
/// GoSpark prints a relay grant's token (`docs/relay-protocol-v1.md`, section 12, RT-4), so a
/// stray `JSON.stringify` or a Node log of a pairing code or a grant shows no secret. Both hooks
/// are non-enumerable, so a spread, a comparison or the value's own fields are unchanged.
export function redactedWhenPrinted<T extends object>(value: T, secrets: readonly (keyof T & string)[]): T {
  const printable = () =>
    Object.fromEntries(Object.entries(value).map(([key, field]) => [key, (secrets as readonly string[]).includes(key) ? "redacted" : field]));
  Object.defineProperty(value, "toJSON", { value: printable, enumerable: false });
  Object.defineProperty(value, Symbol.for("nodejs.util.inspect.custom"), { value: printable, enumerable: false });
  return value;
}

/// Where random bytes come from. Tests pass their own so every value is exact; everything else
/// gets `crypto.getRandomValues`.
export type RandomBytes = (length: number) => Uint8Array;

export const systemRandom: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/// Draws `length` bytes and refuses a source that gave a different number, which would otherwise
/// pass as a short secret.
export function draw(random: RandomBytes, length: number): Bytes {
  const bytes = random(length);
  if (bytes.length !== length) throw new RemoteChannelError("invalid");
  return copyBytes(bytes);
}
