import { type Bytes, concatBytes, copyBytes, equalBytes, utf8, uuidToBytes } from "./bytes";
import { Channel, type ChannelOptions, validateChannelOptions } from "./channel";
import { RemoteChannelError } from "./errors";
import {
  HASH_BYTES,
  PUBLIC_KEY_BYTES,
  type HandshakeKeys,
  derive,
  SECRET_BYTES,
  ephemeralKeyPair,
  exportPublicKey,
  handshakeKeys,
  hmac,
  importSharedSecret,
  sha256,
  sharedSecret,
} from "./keys";
import { PAIRING_TTL_MS, type PairingOffer } from "./offer";
import { hostIdBytes } from "./session";

/// Pairing a phone over the relay. GoSpark paired in person on the LAN: the phone proved it knew
/// the code's key with `HMAC(key, nonce || identity)` (`Shared/Remote/RemoteHandshake.swift`,
/// `RemoteAuthentication.proof`) inside a TLS-PSK session. Here pairing crosses a relay that must
/// not be able to read or stand in the middle of it, and no browser has TLS-PSK, so both sides
/// exchange throwaway ECDH keys and prove the code's secret over a transcript of the exchange
/// with the same key schedule as each session (`keys.ts`). Without the secret the relay can
/// neither finish the exchange nor learn anything from it, and the throwaway keys mean that a
/// photograph of the code taken later cannot open a recording of it.
///
/// Both screens then show a four-digit check code. For it to mean anything against someone who
/// has the secret (a photograph taken within the two minutes) and stands in the middle, neither
/// code may be steerable: the phone commits to its key before it sees the Mac's, so a party in
/// the middle must pick its key toward the phone before it learns the phone's, and toward the Mac
/// before it learns the Mac's. That is the hash commitment of short-authentication-string key
/// agreement, as ZRTP does it (RFC 6189, section 4.4.1.1, "hvi") and Bluetooth's numeric
/// comparison does; the two codes then match only by chance, one in ten thousand, and the code
/// gives one try.
///
/// ```text
/// commit   phone -> Mac   0x10 0x01 | SHA-256("manut-remote-v1 pair commit" || phone key) (32)   34 bytes
/// key      Mac -> phone   0x11 0x01 | Mac key (65)                                                67 bytes
/// proof    phone -> Mac   0x12 0x01 | phone key (65) | phone proof (32)                           99 bytes
/// confirm  Mac -> phone   0x13 0x01 | Mac proof (32)                                              34 bytes
///
/// th          = SHA-256("manut-remote-v1 pair" || host id (32) || door id (16) || commit || key || proof[0..67))
/// keys        = HKDF-SHA-256(IKM = pairing secret, salt = ECDH secret, info = label || 0x00 || th)
/// phone proof = HMAC-SHA-256(phone confirm key, th);  Mac proof = HMAC-SHA-256(mac confirm key, th)
/// check code  = the first 4 bytes of HKDF(..., "manut-remote-v1 pair check code"), big-endian, mod 10,000
/// ```
///
/// The Mac takes one try per code: the first commit spends it, whatever follows, as GoSpark's
/// decision challenges are spent even by a wrong answer. After both proofs, the channel carries
/// what the app sends next (the phone's name, then, once the person presses Allow, the grant).

const COMMIT = 0x10;
const KEY = 0x11;
const PROOF = 0x12;
const CONFIRM = 0x13;
const VERSION = 0x01;
const COMMIT_BYTES = 2 + HASH_BYTES;
const KEY_BYTES = 2 + PUBLIC_KEY_BYTES;
const PROOF_CORE_BYTES = 2 + PUBLIC_KEY_BYTES;
const PROOF_BYTES = PROOF_CORE_BYTES + HASH_BYTES;
const CONFIRM_BYTES = 2 + HASH_BYTES;
const LABEL = utf8("manut-remote-v1 pair");
const COMMIT_LABEL = utf8("manut-remote-v1 pair commit");

function header(bytes: Bytes, type: number, length: number): void {
  if (bytes.length !== length || bytes[0] !== type || bytes[1] !== VERSION) throw new RemoteChannelError("malformed");
}

function commitment(phoneKey: Bytes): Promise<Bytes> {
  return sha256(COMMIT_LABEL, phoneKey);
}

/// Which Mac and which door a pairing belongs to: the parts of the code that are not secret, kept
/// so neither side holds the code's raw secret longer than it needs to.
interface PairingContext {
  readonly hostId: Bytes;
  readonly doorId: Bytes;
}

function contextOf(offer: PairingOffer): PairingContext {
  return { hostId: hostIdBytes(offer.hostId), doorId: uuidToBytes(offer.doorId) };
}

/// What both sides compute once the transcript is complete.
async function pairingKeys(secret: CryptoKey, ecdh: Bytes, context: PairingContext, commit: Bytes, key: Bytes, proofCore: Bytes) {
  const th = await sha256(LABEL, context.hostId, context.doorId, commit, key, proofCore);
  const keys = await handshakeKeys("pair", secret, ecdh, th);
  const code = await derive(secret, ecdh, "manut-remote-v1 pair check code", th, 4);
  const checkCode = String(new DataView(code.buffer).getUint32(0) % 10_000).padStart(4, "0");
  return { th, keys, checkCode };
}

export interface PairingOptions {
  /// The throwaway key pair, for a test that pins the bytes. Leave it out everywhere else.
  readonly ephemeral?: CryptoKeyPair;
  readonly channel?: ChannelOptions;
}

/// The phone's side, after it scanned the code and sent its commitment.
export class PhonePairing {
  readonly #context: PairingContext;
  readonly #secret: CryptoKey;
  readonly #ephemeral: CryptoKeyPair;
  readonly #phoneKey: Bytes;
  readonly #commit: Bytes;
  readonly #channel: ChannelOptions;
  #state: "commit sent" | "proof sent" | "done" | "failed" = "commit sent";
  #pending: { th: Bytes; keys: HandshakeKeys; checkCode: string } | null = null;

  constructor(context: PairingContext, secret: CryptoKey, ephemeral: CryptoKeyPair, phoneKey: Bytes, commit: Bytes, channel: ChannelOptions) {
    this.#context = context;
    this.#secret = secret;
    this.#ephemeral = ephemeral;
    this.#phoneKey = phoneKey;
    this.#commit = commit;
    this.#channel = channel;
  }

  /// Takes the Mac's key and answers with the phone's key and proof.
  async receiveKey(key: Uint8Array): Promise<Bytes> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "commit sent") throw new RemoteChannelError("used");
    this.#state = "failed";
    const bytes = copyBytes(key);
    header(bytes, KEY, KEY_BYTES);
    const ecdh = await sharedSecret(this.#ephemeral, bytes.slice(2));
    const proofCore = concatBytes(Uint8Array.of(PROOF, VERSION), this.#phoneKey);
    this.#pending = await pairingKeys(this.#secret, ecdh, this.#context, this.#commit, bytes, proofCore);
    const proof = concatBytes(proofCore, await hmac(this.#pending.keys.phoneConfirm, this.#pending.th));
    this.#state = "proof sent";
    return proof;
  }

  /// Checks the Mac's proof. Only then does the phone show its check code.
  async receiveConfirm(confirm: Uint8Array): Promise<{ checkCode: string; channel: Channel }> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "proof sent" || this.#pending === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const bytes = copyBytes(confirm);
    header(bytes, CONFIRM, CONFIRM_BYTES);
    const { th, keys, checkCode } = this.#pending;
    if (!equalBytes(await hmac(keys.macConfirm, th), bytes.subarray(2))) throw new RemoteChannelError("unauthenticated");
    this.#state = "done";
    this.#pending = null;
    return { checkCode, channel: new Channel("phone", null, keys, this.#channel) };
  }
}

/// The phone scanned a code: it makes its throwaway key and sends only its commitment.
export async function startPairing(offer: PairingOffer, options: PairingOptions = {}): Promise<{ commit: Bytes; phone: PhonePairing }> {
  const context = contextOf(offer);
  const secret = await importSharedSecret(offer.secret);
  const channel = options.channel ?? {};
  validateChannelOptions(channel);
  const ephemeral = options.ephemeral ?? (await ephemeralKeyPair());
  const phoneKey = await exportPublicKey(ephemeral);
  const commit = concatBytes(Uint8Array.of(COMMIT, VERSION), await commitment(phoneKey));
  return { commit, phone: new PhonePairing(context, secret, ephemeral, phoneKey, commit, channel) };
}

/// The Mac's side of one code, from when it is shown.
export class MacPairing {
  /// The first instant at which the code no longer pairs.
  readonly expiresAt: number;
  readonly #context: PairingContext;
  /// The code's raw secret, a private copy, zeroed at the first commit whatever it brings.
  readonly #secret: Bytes;
  readonly #channel: ChannelOptions;
  #state: "open" | "key sent" | "done" | "failed" = "open";
  #exchange: { secret: CryptoKey; ephemeral: CryptoKeyPair; commit: Bytes; key: Bytes } | null = null;

  constructor(context: PairingContext, secret: Bytes, createdAt: number, ttlMs: number, channel: ChannelOptions) {
    this.#context = context;
    this.#secret = secret;
    this.expiresAt = createdAt + ttlMs;
    this.#channel = channel;
  }

  /// Takes a phone's commitment and answers with the Mac's key. The first call spends the code's
  /// one try, whether or not it succeeds.
  async receiveCommit(commit: Uint8Array, now: number, options: { ephemeral?: CryptoKeyPair } = {}): Promise<Bytes> {
    // Whatever became of the first try, the code is spent: a person at the Mac shows a new one.
    if (this.#state !== "open") throw new RemoteChannelError("used");
    this.#state = "failed";
    try {
      if (!(now < this.expiresAt)) throw new RemoteChannelError("expired");
      const bytes = copyBytes(commit);
      header(bytes, COMMIT, COMMIT_BYTES);
      const secret = await importSharedSecret(this.#secret);
      const ephemeral = options.ephemeral ?? (await ephemeralKeyPair());
      const key = concatBytes(Uint8Array.of(KEY, VERSION), await exportPublicKey(ephemeral));
      this.#exchange = { secret, ephemeral, commit: bytes, key };
      this.#state = "key sent";
      return key;
    } finally {
      // Best effort, as in keys.ts: from here the secret lives only as a key script cannot read.
      this.#secret.fill(0);
    }
  }

  /// Checks that the phone's key opens its commitment and that its proof holds. Only then does the
  /// Mac show its check code and ask the person to Allow.
  async receiveProof(proof: Uint8Array, now: number): Promise<{ confirm: Bytes; checkCode: string; channel: Channel }> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "key sent" || this.#exchange === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const { secret, ephemeral, commit, key } = this.#exchange;
    this.#exchange = null;
    if (!(now < this.expiresAt)) throw new RemoteChannelError("expired");
    const bytes = copyBytes(proof);
    header(bytes, PROOF, PROOF_BYTES);
    const phoneKey = bytes.slice(2, 2 + PUBLIC_KEY_BYTES);
    if (!equalBytes(await commitment(phoneKey), commit.subarray(2))) throw new RemoteChannelError("unauthenticated");
    const ecdh = await sharedSecret(ephemeral, phoneKey);
    const { th, keys, checkCode } = await pairingKeys(secret, ecdh, this.#context, commit, key, bytes.subarray(0, PROOF_CORE_BYTES));
    if (!equalBytes(await hmac(keys.phoneConfirm, th), bytes.subarray(PROOF_CORE_BYTES))) throw new RemoteChannelError("unauthenticated");
    const confirm = concatBytes(Uint8Array.of(CONFIRM, VERSION), await hmac(keys.macConfirm, th));
    this.#state = "done";
    return { confirm, checkCode, channel: new Channel("mac", null, keys, this.#channel) };
  }
}

/// The Mac starts showing a code at `createdAt`. It pairs for two minutes at most; `ttlMs` may
/// only shorten that.
export function macPairing(offer: PairingOffer, createdAt: number, options: { ttlMs?: number; channel?: ChannelOptions } = {}): MacPairing {
  const context = contextOf(offer);
  if (offer.secret.length !== SECRET_BYTES) throw new RemoteChannelError("invalid");
  const ttlMs = options.ttlMs ?? PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > PAIRING_TTL_MS || !Number.isFinite(createdAt)) {
    throw new RemoteChannelError("invalid");
  }
  const channel = options.channel ?? {};
  validateChannelOptions(channel);
  return new MacPairing(context, copyBytes(offer.secret), createdAt, ttlMs, channel);
}
