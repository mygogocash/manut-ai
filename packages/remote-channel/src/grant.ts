import {
  type Bytes,
  type RandomBytes,
  concatBytes,
  copyBytes,
  draw,
  redactedWhenPrinted,
  systemRandom,
  toBase64Url,
  uuidFromBytes,
  uuidToBytes,
  uuidV4,
} from "./bytes";
import { RemoteChannelError } from "./errors";
import { SECRET_BYTES, sha256 } from "./keys";
import { DOOR_TOKEN_BYTES } from "./offer";

/// What the Mac hands the phone over the pairing channel once the person pressed Allow: the
/// phone's own device id, its own door on the relay, and K, the secret every later session is
/// proved with (`docs/remote-access.md`, "Pairing"). GoSpark's `RemotePairResponse` carried the
/// device id and key the same way, inside its TLS session; the relay door is the one its relay
/// grant (`docs/relay-protocol-v1.md`, section 12) added later.
///
/// ```text
/// type        1   0x40
/// version     1   0x01
/// device id  16   the UUID's bytes; the relay's text form is upper case 8-4-4-4-12
/// door token 32   the relay keeps only its SHA-256 (`doorTokenHash`)
/// K          32
/// ```
///
/// It travels only inside the pairing channel, which the relay cannot read.

const TYPE = 0x40;
const VERSION = 0x01;
const GRANT_BYTES = 2 + 16 + DOOR_TOKEN_BYTES + SECRET_BYTES;

export interface PairingGrant {
  readonly deviceId: string;
  readonly doorToken: Bytes;
  readonly secret: Bytes;
}

/// A new device: id, door token and K drawn in that order from `random`.
export function newPairingGrant(random: RandomBytes = systemRandom): PairingGrant {
  const grant: PairingGrant = {
    deviceId: uuidV4(draw(random, 16)),
    doorToken: draw(random, DOOR_TOKEN_BYTES),
    secret: draw(random, SECRET_BYTES),
  };
  return redactedWhenPrinted(grant, ["doorToken", "secret"]);
}

export function encodePairingGrant(grant: PairingGrant): Bytes {
  if (grant.doorToken.length !== DOOR_TOKEN_BYTES || grant.secret.length !== SECRET_BYTES) throw new RemoteChannelError("invalid");
  return concatBytes(Uint8Array.of(TYPE, VERSION), uuidToBytes(grant.deviceId), grant.doorToken, grant.secret);
}

export function decodePairingGrant(bytes: Uint8Array): PairingGrant {
  if (bytes.length !== GRANT_BYTES || bytes[0] !== TYPE || bytes[1] !== VERSION) throw new RemoteChannelError("malformed");
  const grant: PairingGrant = {
    deviceId: uuidFromBytes(bytes.subarray(2, 18)),
    doorToken: copyBytes(bytes.subarray(18, 50)),
    secret: copyBytes(bytes.subarray(50, 82)),
  };
  return redactedWhenPrinted(grant, ["doorToken", "secret"]);
}

/// The token hash the Mac registers with the relay's `device` message: base64url of the SHA-256
/// of the 32 token bytes, not of their text, as `relay-object.ts`'s `tokenOpens` checks it.
export async function doorTokenHash(token: Uint8Array): Promise<string> {
  if (token.length !== DOOR_TOKEN_BYTES) throw new RemoteChannelError("invalid");
  return toBase64Url(await sha256(token));
}
