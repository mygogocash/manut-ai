import { type Bytes, concatBytes, copyBytes, equalBytes, utf8, uuidToBytes } from "./bytes";
import { Channel, type ChannelOptions, validateChannelOptions } from "./channel";
import { RemoteChannelError } from "./errors";
import {
  HASH_BYTES,
  PUBLIC_KEY_BYTES,
  SECRET_BYTES,
  type HandshakeKeys,
  derive,
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
/// The phone then shows a four-digit check code, and the person types it into the Mac, which
/// compares it with its own once. Typing rather than comparing two screens matters when someone
/// photographed the code and races the real phone: the real phone is then refused, shows no
/// digits, and there is nothing to type, so a careless Allow is not possible. Against someone who
/// has the secret and stands in the middle, neither code may be steerable: the phone commits to
/// its key before it sees the Mac's, so a party in the middle must pick its key toward the phone
/// before it learns the phone's, and toward the Mac before it learns the Mac's. That is the hash
/// commitment of short-authentication-string key agreement, as ZRTP does it (RFC 6189, section
/// 4.4.1.1, "hvi") and Bluetooth's numeric comparison does; the two codes then match only by
/// chance, one in ten thousand.
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
/// A code is one try on each side. The Mac's first commit spends it on the Mac, whatever follows,
/// as GoSpark's decision challenges are spent even by a wrong answer, and so does a wrong typed
/// code. Starting pairing spends it on the phone: the same door is refused again in this page and
/// the offer's secret is zeroed, because a phone that tried again on a failure would let someone
/// in the middle with the secret play the Mac to it until its code happened to match the Mac's.
/// So someone in the middle gets one chance in ten thousand in all. The package retries nothing.

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

function zeroIvs(keys: HandshakeKeys): void {
  keys.phoneToMac.iv.fill(0);
  keys.macToPhone.iv.fill(0);
}

/// What both sides compute once the transcript is complete. The check code is kept as the bytes
/// of its four ASCII digits, which the caller zeroes when done; the ECDH secret is zeroed here.
async function pairingKeys(secret: CryptoKey, ecdh: Bytes, context: PairingContext, commit: Bytes, key: Bytes, proofCore: Bytes) {
  try {
    const th = await sha256(LABEL, context.hostId, context.doorId, commit, key, proofCore);
    const keys = await handshakeKeys("pair", secret, ecdh, th);
    const raw = await derive(secret, ecdh, "manut-remote-v1 pair check code", th, 4);
    const code = utf8(String(new DataView(raw.buffer).getUint32(0) % 10_000).padStart(4, "0"));
    raw.fill(0);
    return { th, keys, code };
  } finally {
    ecdh.fill(0);
  }
}

export interface PairingOptions {
  readonly channel?: ChannelOptions;
}

/// The phone's side, after it scanned the code and sent its commitment. It holds the code's
/// secret, as a key script cannot read back, only until the Mac's key arrives.
export class PhonePairing {
  readonly #context: PairingContext;
  readonly #phoneKey: Bytes;
  readonly #commit: Bytes;
  readonly #channel: ChannelOptions;
  #held: { secret: CryptoKey; ephemeral: CryptoKeyPair } | null;
  #state: "commit sent" | "proof sent" | "done" | "failed" = "commit sent";
  #pending: { th: Bytes; keys: HandshakeKeys; code: Bytes } | null = null;

  constructor(context: PairingContext, secret: CryptoKey, ephemeral: CryptoKeyPair, phoneKey: Bytes, commit: Bytes, channel: ChannelOptions) {
    this.#context = context;
    this.#held = { secret, ephemeral };
    this.#phoneKey = phoneKey;
    this.#commit = commit;
    this.#channel = channel;
  }

  /// Takes the Mac's key and answers with the phone's key and proof. Only one key is ever taken,
  /// so a party in the middle must choose its key before it sees the phone's.
  async receiveKey(key: Uint8Array): Promise<Bytes> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "commit sent" || this.#held === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const { secret, ephemeral } = this.#held;
    this.#held = null;
    const bytes = copyBytes(key);
    header(bytes, KEY, KEY_BYTES);
    const ecdh = await sharedSecret(ephemeral, bytes.slice(2));
    const proofCore = concatBytes(Uint8Array.of(PROOF, VERSION), this.#phoneKey);
    this.#pending = await pairingKeys(secret, ecdh, this.#context, this.#commit, bytes, proofCore);
    const proof = concatBytes(proofCore, await hmac(this.#pending.keys.phoneConfirm, this.#pending.th));
    this.#state = "proof sent";
    return proof;
  }

  /// Checks the Mac's proof. Only then does the phone show its check code, for the person to type
  /// into the Mac. The phone sends nothing on the channel until the grant arrives on it.
  async receiveConfirm(confirm: Uint8Array): Promise<{ checkCode: string; channel: Channel }> {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "proof sent" || this.#pending === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const { th, keys, code } = this.#pending;
    this.#pending = null;
    const checkCode = new TextDecoder().decode(code);
    code.fill(0);
    const bytes = copyBytes(confirm);
    try {
      header(bytes, CONFIRM, CONFIRM_BYTES);
      if (!equalBytes(await hmac(keys.macConfirm, th), bytes.subarray(2))) throw new RemoteChannelError("unauthenticated");
    } catch (error) {
      zeroIvs(keys);
      throw error;
    }
    this.#state = "done";
    return { checkCode, channel: new Channel("phone", null, keys, this.#channel) };
  }
}

/// Door ids of the codes this page has started pairing on. A code is one try on the phone too, so
/// the same door is refused for as long as the page lives; across reloads, the app must not offer
/// a code again either (78c).
const startedDoors = new Set<string>();

/// Test-only, through `testing.ts`: lets one test process play several phones.
export function forgetStartedPairings(): void {
  startedDoors.clear();
}

/// `startPairing` with the throwaway key pair given. Only `testing.ts` passes one, to pin bytes;
/// `index.ts` does not export this, so no caller can make a pairing reuse a key pair.
export async function startPairingWith(offer: PairingOffer, ephemeral: CryptoKeyPair | undefined, options: PairingOptions = {}): Promise<{ commit: Bytes; phone: PhonePairing }> {
  const context = contextOf(offer);
  const channel = options.channel ?? {};
  validateChannelOptions(channel);
  if (offer.secret.length !== SECRET_BYTES) throw new RemoteChannelError("invalid");
  // Spent before anything awaits, so two starts at once cannot both pass.
  if (startedDoors.has(offer.doorId) || offer.secret.every((byte) => byte === 0)) throw new RemoteChannelError("used");
  startedDoors.add(offer.doorId);
  let secret: CryptoKey;
  try {
    secret = await importSharedSecret(offer.secret);
  } finally {
    offer.secret.fill(0);
  }
  const pair = ephemeral ?? (await ephemeralKeyPair());
  const phoneKey = await exportPublicKey(pair);
  const commit = concatBytes(Uint8Array.of(COMMIT, VERSION), await commitment(phoneKey));
  return { commit, phone: new PhonePairing(context, secret, pair, phoneKey, commit, channel) };
}

/// The phone scanned a code: it makes its throwaway key and sends only its commitment. This spends
/// the code on the phone: its secret is zeroed in `offer`, and the same door is refused again.
export function startPairing(offer: PairingOffer, options: PairingOptions = {}): Promise<{ commit: Bytes; phone: PhonePairing }> {
  return startPairingWith(offer, undefined, options);
}

let receiveCommitWith: (mac: MacPairing, commit: Uint8Array, now: number, ephemeral: CryptoKeyPair | undefined) => Promise<Bytes>;

/// The Mac's side of one code, from when it is shown until the person types the phone's code.
export class MacPairing {
  static {
    // The only way in with a given key pair, for `testing.ts`; it is not reachable from the class.
    receiveCommitWith = (mac, commit, now, ephemeral) => mac.#receiveCommit(commit, now, ephemeral);
  }

  /// The first instant at which the code no longer pairs, typed code included.
  readonly expiresAt: number;
  readonly #context: PairingContext;
  /// The code's raw secret, a private copy, zeroed at the first commit whatever it brings.
  readonly #secret: Bytes;
  readonly #channel: ChannelOptions;
  #state: "open" | "key sent" | "awaiting code" | "done" | "failed" = "open";
  #exchange: { secret: CryptoKey; ephemeral: CryptoKeyPair; commit: Bytes; key: Bytes } | null = null;
  #pending: { keys: HandshakeKeys; code: Bytes } | null = null;

  constructor(context: PairingContext, secret: Bytes, createdAt: number, ttlMs: number, channel: ChannelOptions) {
    this.#context = context;
    this.#secret = secret;
    this.expiresAt = createdAt + ttlMs;
    this.#channel = channel;
  }

  /// Takes a phone's commitment and answers with the Mac's key. The first call spends the code's
  /// one try, whether or not it succeeds; the Mac hides the QR code then.
  receiveCommit(commit: Uint8Array, now: number): Promise<Bytes> {
    return this.#receiveCommit(commit, now, undefined);
  }

  async #receiveCommit(commit: Uint8Array, now: number, ephemeral: CryptoKeyPair | undefined): Promise<Bytes> {
    // Whatever became of the first try, the code is spent: a person at the Mac shows a new one.
    if (this.#state !== "open") throw new RemoteChannelError("used");
    this.#state = "failed";
    try {
      if (!(now < this.expiresAt)) throw new RemoteChannelError("expired");
      const bytes = copyBytes(commit);
      header(bytes, COMMIT, COMMIT_BYTES);
      const secret = await importSharedSecret(this.#secret);
      const pair = ephemeral ?? (await ephemeralKeyPair());
      const key = concatBytes(Uint8Array.of(KEY, VERSION), await exportPublicKey(pair));
      this.#exchange = { secret, ephemeral: pair, commit: bytes, key };
      this.#state = "key sent";
      return key;
    } finally {
      // Best effort, as in keys.ts: from here the secret lives only as a key script cannot read.
      this.#secret.fill(0);
    }
  }

  /// Checks that the phone's key opens its commitment and that its proof holds, and answers with
  /// the Mac's proof, so the phone can show its code. The Mac never shows its own: the person
  /// types the phone's into `allow`.
  async receiveProof(proof: Uint8Array, now: number): Promise<{ confirm: Bytes }> {
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
    const { th, keys, code } = await pairingKeys(secret, ecdh, this.#context, commit, key, bytes.subarray(0, PROOF_CORE_BYTES));
    if (!equalBytes(await hmac(keys.phoneConfirm, th), bytes.subarray(PROOF_CORE_BYTES))) {
      code.fill(0);
      zeroIvs(keys);
      throw new RemoteChannelError("unauthenticated");
    }
    const confirm = concatBytes(Uint8Array.of(CONFIRM, VERSION), await hmac(keys.macConfirm, th));
    this.#pending = { keys, code };
    this.#state = "awaiting code";
    return { confirm };
  }

  /// The person typed the code the phone shows. It is compared once, without an early exit, with
  /// the Mac's own, before the code's time is up; a wrong code, or one typed late, spends the
  /// pairing, and there is no second guess. Spaces around the digits are dropped. Only now does
  /// the Mac get its channel, on which it sends the grant.
  allow(typedCode: string, now: number): Channel {
    if (this.#state === "failed") throw new RemoteChannelError("closed");
    if (this.#state !== "awaiting code" || this.#pending === null) throw new RemoteChannelError("used");
    this.#state = "failed";
    const { keys, code } = this.#pending;
    this.#pending = null;
    const entered = utf8(typeof typedCode === "string" ? typedCode.trim() : "");
    const matches = equalBytes(entered, code);
    code.fill(0);
    entered.fill(0);
    if (!(now < this.expiresAt) || !matches) {
      zeroIvs(keys);
      throw new RemoteChannelError(now < this.expiresAt ? "wrong_code" : "expired");
    }
    this.#state = "done";
    return new Channel("mac", null, keys, this.#channel);
  }
}

/// `MacPairing.receiveCommit` with the throwaway key pair given; test-only, as `startPairingWith`.
export function macReceiveCommitWith(mac: MacPairing, commit: Uint8Array, now: number, ephemeral: CryptoKeyPair): Promise<Bytes> {
  return receiveCommitWith(mac, commit, now, ephemeral);
}

/// The Mac starts showing a code at `createdAt`. It pairs for two minutes at most, the typed code
/// included; `ttlMs` may only shorten that.
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
