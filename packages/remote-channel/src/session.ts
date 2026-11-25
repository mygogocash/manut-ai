import { type Bytes, concatBytes, copyBytes, equalBytes, fromBase64Url, utf8, uuidFromBytes, uuidToBytes } from "./bytes";
import { Channel, type ChannelOptions, validateChannelOptions } from "./channel";
import { RemoteChannelError } from "./errors";
import {
  HASH_BYTES,
  PUBLIC_KEY_BYTES,
  type HandshakeKeys,
  ephemeralKeyPair,
  exportPublicKey,
  handshakeKeys,
  hmac,
  secretKey,
  sha256,
  sharedSecret,
} from "./keys";

/// Each connection after pairing: a fresh ECDH exchange proved with K, so every session gets new
/// keys and a recording of one is useless for the next. Ported from GoSpark's hello, where the
/// Mac sends a nonce and the phone answers `HMAC(K, nonce || identity)`
/// (`Shared/Remote/RemoteHandshake.swift`, `RemoteAuthentication.proof`); here both sides prove K
/// over a transcript that holds both throwaway keys, because the relay, unlike GoSpark's TLS-PSK
/// listener, carries the exchange in the open. The phone dials, so it speaks first:
///
/// ```text
/// hello    phone -> Mac   0x20 0x01 | device id (16, the relay's UUID as bytes) | phone key (65)   83 bytes
/// welcome  Mac -> phone   0x21 0x01 | Mac key (65) | Mac proof (32)                               99 bytes
/// finish   phone -> Mac   0x22 0x01 | phone proof (32)                                           34 bytes
///
/// th          = SHA-256("manut-remote-v1 session" || host id (32) || hello || welcome[0..67))
/// keys        = HKDF-SHA-256(IKM = K, salt = ECDH secret, info = label || 0x00 || th)   (keys.ts)
/// Mac proof   = HMAC-SHA-256(mac confirm key, th)
/// phone proof = HMAC-SHA-256(phone confirm key, th)
/// ```
///
/// The device comes from the proved hello and never from the relay's `open` message, which only
/// says which stream a phone is on (GoSpark's threat model, RT-9).

const HELLO = 0x20;
const WELCOME = 0x21;
const FINISH = 0x22;
const VERSION = 0x01;
const HELLO_BYTES = 2 + 16 + PUBLIC_KEY_BYTES;
const WELCOME_CORE_BYTES = 2 + PUBLIC_KEY_BYTES;
const WELCOME_BYTES = WELCOME_CORE_BYTES + HASH_BYTES;
const FINISH_BYTES = 2 + HASH_BYTES;
const LABEL = utf8("manut-remote-v1 session");

/// A host id as the relay names a Mac: 43 characters of base64url, the SHA-256 of its relay key.
export function hostIdBytes(hostId: string): Bytes {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hostId)) throw new RemoteChannelError("invalid");
  const bytes = fromBase64Url(hostId);
  if (bytes.length !== 32) throw new RemoteChannelError("invalid");
  return bytes;
}

function header(bytes: Bytes, type: number, length: number): void {
  if (bytes.length !== length || bytes[0] !== type || bytes[1] !== VERSION) throw new RemoteChannelError("malformed");
}

async function transcriptHash(hostId: Bytes, hello: Bytes, welcomeCore: Bytes): Promise<Bytes> {
  return sha256(LABEL, hostId, hello, welcomeCore);
}

export interface SessionHandshakeOptions {
  readonly channel?: ChannelOptions;
}

/// The phone's side, between its hello and the Mac's welcome. It holds K and its throwaway key
/// only until the welcome is read, whatever the welcome brings.
export class PhoneSessionHandshake {
  readonly #hostId: Bytes;
  readonly #deviceId: string;
  readonly #hello: Bytes;
  readonly #channel: ChannelOptions;
  #held: { secret: CryptoKey; ephemeral: CryptoKeyPair } | null;
  #state: "waiting" | "done" | "failed" = "waiting";

  constructor(hostId: Bytes, deviceId: string, secret: CryptoKey, ephemeral: CryptoKeyPair, hello: Bytes, channel: ChannelOptions) {
    this.#hostId = hostId;
    this.#deviceId = deviceId;
    this.#held = { secret, ephemeral };
    this.#hello = hello;
    this.#channel = channel;
  }

  /// Checks the Mac's proof and answers with the phone's. The channel may be used at once: the
  /// Mac reads the finish before any record that follows it.
  async receiveWelcome(welcome: Uint8Array): Promise<{ finish: Bytes; channel: Channel }> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state === "done" || this.#held === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const { secret, ephemeral } = this.#held;
    this.#held = null;
    const bytes = copyBytes(welcome);
    header(bytes, WELCOME, WELCOME_BYTES);
    const core = bytes.subarray(0, WELCOME_CORE_BYTES);
    const ecdh = await sharedSecret(ephemeral, bytes.slice(2, 2 + PUBLIC_KEY_BYTES));
    const th = await transcriptHash(this.#hostId, this.#hello, core);
    let keys: HandshakeKeys;
    try {
      keys = await handshakeKeys("session", secret, ecdh, th);
    } finally {
      ecdh.fill(0);
    }
    if (!equalBytes(await hmac(keys.macConfirm, th), bytes.subarray(WELCOME_CORE_BYTES))) {
      throw new RemoteChannelError("unauthenticated");
    }
    const finish = concatBytes(Uint8Array.of(FINISH, VERSION), await hmac(keys.phoneConfirm, th));
    this.#state = "done";
    return { finish, channel: new Channel("phone", this.#deviceId, keys, this.#channel) };
  }
}

/// The Mac's side, between its welcome and the phone's finish. It drops the session's keys as soon
/// as the finish is read: into the channel when it holds, and nowhere when it does not.
export class MacSessionHandshake {
  readonly #deviceId: string;
  readonly #th: Bytes;
  readonly #channel: ChannelOptions;
  #keys: HandshakeKeys | null;
  #state: "waiting" | "done" | "failed" = "waiting";

  constructor(deviceId: string, keys: HandshakeKeys, th: Bytes, channel: ChannelOptions) {
    this.#deviceId = deviceId;
    this.#keys = keys;
    this.#th = th;
    this.#channel = channel;
  }

  /// Checks the phone's proof. Only then is the device the one the session belongs to.
  async receiveFinish(finish: Uint8Array): Promise<Channel> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state === "done" || this.#keys === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const keys = this.#keys;
    this.#keys = null;
    const bytes = copyBytes(finish);
    header(bytes, FINISH, FINISH_BYTES);
    if (!equalBytes(await hmac(keys.phoneConfirm, this.#th), bytes.subarray(2))) {
      keys.phoneToMac.iv.fill(0);
      keys.macToPhone.iv.fill(0);
      throw new RemoteChannelError("unauthenticated");
    }
    this.#state = "done";
    return new Channel("mac", this.#deviceId, keys, this.#channel);
  }
}

type SecretLookup = (deviceId: string) => CryptoKey | Uint8Array | undefined | Promise<CryptoKey | Uint8Array | undefined>;

/// `startSession` with the throwaway key pair given. Only `testing.ts` passes one, to pin bytes;
/// `index.ts` does not export this, so no caller can make a session reuse a key pair.
export async function startSessionWith(
  params: { readonly hostId: string; readonly deviceId: string; readonly secret: CryptoKey | Uint8Array },
  ephemeral: CryptoKeyPair | undefined,
  options: SessionHandshakeOptions = {},
): Promise<{ hello: Bytes; phone: PhoneSessionHandshake }> {
  const hostId = hostIdBytes(params.hostId);
  const deviceBytes = uuidToBytes(params.deviceId);
  const secret = await secretKey(params.secret);
  const channel = options.channel ?? {};
  validateChannelOptions(channel);
  const pair = ephemeral ?? (await ephemeralKeyPair());
  const hello = concatBytes(Uint8Array.of(HELLO, VERSION), deviceBytes, await exportPublicKey(pair));
  return { hello, phone: new PhoneSessionHandshake(hostId, params.deviceId, secret, pair, hello, channel) };
}

/// The phone starts a session with the Mac it paired with: the host id from the pairing code,
/// and its device id and K from the grant.
export function startSession(
  params: { readonly hostId: string; readonly deviceId: string; readonly secret: CryptoKey | Uint8Array },
  options: SessionHandshakeOptions = {},
): Promise<{ hello: Bytes; phone: PhoneSessionHandshake }> {
  return startSessionWith(params, undefined, options);
}

/// `acceptSession` with the throwaway key pair given; test-only, as `startSessionWith`.
export async function acceptSessionWith(
  hello: Uint8Array,
  params: { readonly hostId: string; readonly secretFor: SecretLookup },
  ephemeral: CryptoKeyPair | undefined,
  options: SessionHandshakeOptions = {},
): Promise<{ welcome: Bytes; mac: MacSessionHandshake }> {
  const hostId = hostIdBytes(params.hostId);
  const channel = options.channel ?? {};
  validateChannelOptions(channel);
  const bytes = copyBytes(hello);
  header(bytes, HELLO, HELLO_BYTES);
  const deviceId = uuidFromBytes(bytes.subarray(2, 18));
  const found = await params.secretFor(deviceId);
  if (found === undefined) throw new RemoteChannelError("unknown_device");
  const secret = await secretKey(found);
  const pair = ephemeral ?? (await ephemeralKeyPair());
  const ecdh = await sharedSecret(pair, bytes.slice(18, 18 + PUBLIC_KEY_BYTES));
  const core = concatBytes(Uint8Array.of(WELCOME, VERSION), await exportPublicKey(pair));
  const th = await transcriptHash(hostId, bytes, core);
  let keys: HandshakeKeys;
  try {
    keys = await handshakeKeys("session", secret, ecdh, th);
  } finally {
    ecdh.fill(0);
  }
  const welcome = concatBytes(core, await hmac(keys.macConfirm, th));
  return { welcome, mac: new MacSessionHandshake(deviceId, keys, th, channel) };
}

/// The Mac answers a hello. `secretFor` returns the K it keeps for that device, or undefined for
/// a device it does not know, which is refused before anything is sent.
export function acceptSession(
  hello: Uint8Array,
  params: { readonly hostId: string; readonly secretFor: SecretLookup },
  options: SessionHandshakeOptions = {},
): Promise<{ welcome: Bytes; mac: MacSessionHandshake }> {
  return acceptSessionWith(hello, params, undefined, options);
}
