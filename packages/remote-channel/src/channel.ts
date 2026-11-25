import { type Bytes, concatBytes, copyBytes } from "./bytes";
import { RemoteChannelError, guarded } from "./errors";
import type { DirectionKeys, HandshakeKeys } from "./keys";

/// The records of an open session, after a handshake (`pairing.ts` or `session.ts`) gave both
/// sides the same keys. It replaces the TLS records of GoSpark's TLS-PSK session: every message
/// is encrypted and authenticated with AES-256-GCM under a key for its direction, and numbered by
/// a counter that is never sent, as TLS 1.3 numbers its records (RFC 8446, section 5.3). So a
/// changed, repeated, reordered, dropped, reflected or earlier session's record cannot be opened,
/// and the first one that cannot closes the session for good, as a TLS alert would.
///
/// One record is one binary message on the relay:
///
/// ```text
/// type   1 byte   0x30
/// box    n bytes  AES-256-GCM ciphertext of (flags || chunk), then its 16-byte tag
///                 AAD = 0x30 0x01 (the type and the protocol version)
///                 nonce = the direction's 12-byte IV XOR the record number, as a 64-bit
///                         big-endian number right-aligned in 12 bytes (RFC 8446, section 5.3)
/// flags  1 byte   inside the box: 0x00 more chunks follow, 0x01 the last chunk of a message
/// ```
///
/// A message is split into chunks so each record fits the relay's limit of 65,532 bytes for one
/// message from a phone (`MAX_PAYLOAD_BYTES` in `apps/api/src/relay-object.ts`). The Mac's frames
/// carry 4 more bytes, the stream number, which its socket adds outside this package.

export const RECORD_TYPE = 0x30;
const VERSION = 0x01;
const TAG_BYTES = 16;
/// The relay's largest payload in one binary message (relay protocol v1, section 9).
export const MAX_FRAME_BYTES = 65_532;
/// Type byte, flags byte and tag.
export const RECORD_OVERHEAD = 1 + 1 + TAG_BYTES;
export const MAX_CHUNK_BYTES = MAX_FRAME_BYTES - RECORD_OVERHEAD;
/// Records one key may seal in one direction. RFC 8446, section 5.5: AES-GCM keeps a safety
/// margin of about 2^-57 up to 2^24.5 full-size records on one connection, so the session stops
/// at 2^24 and a new handshake brings new keys. The counter therefore never wraps and a nonce is
/// never used twice under one key.
export const RECORD_LIMIT = 2 ** 24;
/// The largest whole message, before splitting. A chat's catch-up from the journal is at most
/// about 1 MB (`docs/remote-access.md`), so 4 MiB leaves room while keeping a phone's memory safe
/// from a peer that never sends the last chunk.
export const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_CEILING = 64 * 1024 * 1024;

const AAD = Uint8Array.of(RECORD_TYPE, VERSION);
const MORE = 0x00;
const LAST = 0x01;

export interface ChannelOptions {
  /// Lower than `RECORD_LIMIT` only, as a test does to reach the end of the counter.
  readonly recordLimit?: number;
  /// The largest whole message this side seals or opens. Both sides should agree.
  readonly maxMessageBytes?: number;
}

export type ChannelRole = "mac" | "phone";

function checkedOptions(options: ChannelOptions): { recordLimit: number; maxMessageBytes: number } {
  const recordLimit = options.recordLimit ?? RECORD_LIMIT;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (!Number.isSafeInteger(recordLimit) || recordLimit < 1 || recordLimit > RECORD_LIMIT) throw new RemoteChannelError("invalid");
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0 || maxMessageBytes > MAX_MESSAGE_CEILING) {
    throw new RemoteChannelError("invalid");
  }
  return { recordLimit, maxMessageBytes };
}

export function validateChannelOptions(options: ChannelOptions): void {
  checkedOptions(options);
}

function nonce(iv: Bytes, counter: number): Bytes {
  const out = copyBytes(iv);
  const view = new DataView(out.buffer);
  view.setUint32(4, view.getUint32(4) ^ Math.floor(counter / 2 ** 32));
  view.setUint32(8, view.getUint32(8) ^ counter % 2 ** 32);
  return out;
}

/// One open session, from one side. Sealing and opening are each serialised in call order, so a
/// caller that does not wait for one message before the next still gets frames in counter order.
export class Channel {
  readonly role: ChannelRole;
  /// The device the handshake proved, or null on a pairing channel, where the phone has no id yet.
  readonly deviceId: string | null;

  readonly #send: DirectionKeys;
  readonly #receive: DirectionKeys;
  readonly #recordLimit: number;
  readonly #maxMessageBytes: number;
  #sent = 0;
  #received = 0;
  #chunks: Bytes[] = [];
  #pendingBytes = 0;
  #closed = false;
  #sendChain: Promise<unknown> = Promise.resolve();
  #receiveChain: Promise<unknown> = Promise.resolve();

  /// Made by the handshakes only; a caller never builds one from keys.
  constructor(role: ChannelRole, deviceId: string | null, keys: HandshakeKeys, options: ChannelOptions) {
    const { recordLimit, maxMessageBytes } = checkedOptions(options);
    this.role = role;
    this.deviceId = deviceId;
    this.#send = role === "phone" ? keys.phoneToMac : keys.macToPhone;
    this.#receive = role === "phone" ? keys.macToPhone : keys.phoneToMac;
    this.#recordLimit = recordLimit;
    this.#maxMessageBytes = maxMessageBytes;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /// Ends the session: nothing more is sealed or opened, and a partly received message is dropped.
  close(): void {
    this.#closed = true;
    this.#chunks = [];
    this.#pendingBytes = 0;
  }

  /// Encrypts one whole message into the frames to send, in order. Refusing to seal sends
  /// nothing, so the session goes on; only the peer's refusal ends it.
  seal(message: Uint8Array): Promise<Bytes[]> {
    const copy = copyBytes(message);
    const result = this.#sendChain.then(() => this.#sealNow(copy));
    this.#sendChain = result.catch(() => undefined);
    return result;
  }

  /// Opens one frame. Returns the whole message when this frame was its last chunk, and null
  /// while more chunks are to come. Any refusal closes the session.
  open(frame: Uint8Array): Promise<Bytes | null> {
    const copy = copyBytes(frame);
    const result = this.#receiveChain.then(() => this.#openNow(copy));
    this.#receiveChain = result.catch(() => undefined);
    return result;
  }

  async #sealNow(message: Bytes): Promise<Bytes[]> {
    if (this.#closed) throw new RemoteChannelError("closed");
    if (message.length > this.#maxMessageBytes) throw new RemoteChannelError("too_large");
    const count = Math.max(1, Math.ceil(message.length / MAX_CHUNK_BYTES));
    if (this.#sent + count > this.#recordLimit) throw new RemoteChannelError("exhausted");
    const first = this.#sent;
    this.#sent += count;
    try {
      const frames: Bytes[] = [];
      for (let i = 0; i < count; i++) {
        const chunk = message.subarray(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
        const plain = concatBytes(Uint8Array.of(i === count - 1 ? LAST : MORE), chunk);
        const box = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce(this.#send.iv, first + i), additionalData: AAD, tagLength: 128 },
          this.#send.key,
          plain,
        );
        frames.push(concatBytes(Uint8Array.of(RECORD_TYPE), new Uint8Array(box)));
      }
      return frames;
    } catch {
      // Counters were spent and nothing can be sent in their place, so the session cannot go on.
      this.close();
      throw new RemoteChannelError("closed");
    }
  }

  async #openNow(frame: Bytes): Promise<Bytes | null> {
    if (this.#closed) throw new RemoteChannelError("closed");
    try {
      if (frame.length > MAX_FRAME_BYTES) throw new RemoteChannelError("too_large");
      if (frame.length < RECORD_OVERHEAD || frame[0] !== RECORD_TYPE) throw new RemoteChannelError("malformed");
      if (this.#received >= this.#recordLimit) throw new RemoteChannelError("exhausted");
      const counter = this.#received;
      const plain = copyBytes(new Uint8Array(await guarded("unauthenticated", () => crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce(this.#receive.iv, counter), additionalData: AAD, tagLength: 128 },
        this.#receive.key,
        frame.subarray(1),
      ))));
      this.#received = counter + 1;
      const flags = plain[0];
      if (flags !== MORE && flags !== LAST) throw new RemoteChannelError("malformed");
      const chunk = plain.subarray(1);
      if (this.#pendingBytes + chunk.length > this.#maxMessageBytes) throw new RemoteChannelError("too_large");
      this.#chunks.push(chunk);
      this.#pendingBytes += chunk.length;
      if (flags === MORE) return null;
      const message = concatBytes(...this.#chunks);
      this.#chunks = [];
      this.#pendingBytes = 0;
      return message;
    } catch (error) {
      this.close();
      throw error instanceof RemoteChannelError ? error : new RemoteChannelError("malformed");
    }
  }
}
