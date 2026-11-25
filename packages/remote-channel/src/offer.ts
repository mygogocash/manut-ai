import {
  type Bytes,
  type RandomBytes,
  concatBytes,
  copyBytes,
  draw,
  fromBase64Url,
  redactedWhenPrinted,
  systemRandom,
  toBase64Url,
  uuidFromBytes,
  uuidToBytes,
  uuidV4,
} from "./bytes";
import { RemoteChannelError } from "./errors";
import { SECRET_BYTES } from "./keys";
import { hostIdBytes } from "./session";

/// What the QR code on the Mac carries, ported from GoSpark's `RemotePairingInvitation`
/// (`Shared/Remote/RemoteHandshake.swift`). GoSpark's code named LAN addresses, a port and a
/// 256-bit key; here it names the Mac's relay host, a one-use door on that relay and the same
/// 256-bit secret, because pairing crosses the relay (`docs/remote-access.md`). The door is a
/// relay device the Mac registers only for these two minutes, so a phone that has never paired
/// can reach it; the secret is what proves the phone saw the code.
///
/// The code, 113 bytes as base64url (151 characters):
///
/// ```text
/// version     1   0x01
/// host id    32   the SHA-256 of the Mac's relay key, as the relay names the Mac
/// door id    16   the one-use relay device id, as the UUID's bytes
/// door token 32   that door's token; the relay keeps only its SHA-256
/// secret     32   the pairing secret
/// ```
///
/// In a link it goes after `#pair=`: a fragment is never sent to a server, so the secret reaches
/// no log, unlike a query string.

const VERSION = 0x01;
const OFFER_BYTES = 1 + 32 + 16 + 32 + SECRET_BYTES;
/// The longest text `readPairingLink` reads, as GoSpark's 4,096-byte cap on a pairing link.
const MAX_LINK_CHARS = 4_096;
/// How long a code can pair, from when the Mac shows it.
export const PAIRING_TTL_MS = 120_000;
export const DOOR_TOKEN_BYTES = 32;

export interface PairingOffer {
  readonly hostId: string;
  readonly doorId: string;
  readonly doorToken: Bytes;
  readonly secret: Bytes;
}

/// A new code for this Mac: a fresh door and a fresh secret, drawn in that order (door id, door
/// token, secret) from `random`.
export function newPairingOffer(hostId: string, random: RandomBytes = systemRandom): PairingOffer {
  hostIdBytes(hostId);
  const offer: PairingOffer = {
    hostId,
    doorId: uuidV4(draw(random, 16)),
    doorToken: draw(random, DOOR_TOKEN_BYTES),
    secret: draw(random, SECRET_BYTES),
  };
  return redactedWhenPrinted(offer, ["doorToken", "secret"]);
}

export function encodePairingOffer(offer: PairingOffer): string {
  if (offer.doorToken.length !== DOOR_TOKEN_BYTES || offer.secret.length !== SECRET_BYTES) throw new RemoteChannelError("invalid");
  return toBase64Url(concatBytes(Uint8Array.of(VERSION), hostIdBytes(offer.hostId), uuidToBytes(offer.doorId), offer.doorToken, offer.secret));
}

/// The strict inverse of `encodePairingOffer`: exactly 113 bytes of version 1, or `malformed`.
export function decodePairingOffer(text: string): PairingOffer {
  const bytes = fromBase64Url(text);
  if (bytes.length !== OFFER_BYTES || bytes[0] !== VERSION) throw new RemoteChannelError("malformed");
  const offer: PairingOffer = {
    hostId: toBase64Url(bytes.subarray(1, 33)),
    doorId: uuidFromBytes(bytes.subarray(33, 49)),
    doorToken: copyBytes(bytes.subarray(49, 81)),
    secret: copyBytes(bytes.subarray(81, 113)),
  };
  return redactedWhenPrinted(offer, ["doorToken", "secret"]);
}

/// The link the Mac shows as a QR code and copies: the app's address with the code in its
/// fragment. The address must be https, or plain http to this machine during development, with
/// no query or fragment of its own.
export function pairingLink(appUrl: string, offer: PairingOffer): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new RemoteChannelError("invalid");
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !local) || url.search !== "" || url.hash !== "" || appUrl.includes("#")) {
    throw new RemoteChannelError("invalid");
  }
  return `${url.href}#pair=${encodePairingOffer(offer)}`;
}

/// Reads a scanned or pasted code: a whole link with `#pair=`, or the bare code. A link that
/// carries a code in its query is refused, so that form never works anywhere and nobody builds
/// links that send the secret to a server.
export function readPairingLink(text: string): PairingOffer {
  if (text.length > MAX_LINK_CHARS) throw new RemoteChannelError("malformed");
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  if (hash === -1) return decodePairingOffer(trimmed);
  const before = trimmed.slice(0, hash);
  const fragment = trimmed.slice(hash + 1);
  if (before.includes("pair=") || !fragment.startsWith("pair=")) throw new RemoteChannelError("malformed");
  return decodePairingOffer(fragment.slice("pair=".length));
}
