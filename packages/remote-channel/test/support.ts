import { expect } from "vitest";
import {
  type Bytes,
  type Channel,
  type ChannelOptions,
  REMOTE_CHANNEL_MESSAGES,
  RemoteChannelError,
  type RandomBytes,
  acceptSession,
  startSession,
} from "../src/index";
import ephemeralKeys from "./fixtures/ephemeral-keys.json";

/// Shared fixtures. The host id is the relay vectors' test-only host id
/// (`apps/api/test/fixtures/relay-v1-vectors.json`), so these tests name a Mac the relay would
/// accept; the device ids are made up.

export const HOST_ID = "GnOvYLqZ2OHWO6ttlRtTcGTPJe7LvdxH1_QGvKsS3b8";
export const OTHER_HOST_ID = "q4XcGnOvYLqZ2OHWO6ttlRtTcGTPJe7LvdxH1_QGvKs";
export const DEVICE_ID = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
export const OTHER_DEVICE_ID = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";

/// Random bytes that are the same on every run: byte i of the stream is `seed + i`, so two
/// sources with different seeds give different values and a test can say exactly what it drew.
export function seededRandom(seed: number): RandomBytes {
  let next = seed;
  return (length) => Uint8Array.from({ length }, () => next++ & 0xff);
}

export function bytesOf(length: number, fill: number): Bytes {
  return new Uint8Array(length).fill(fill);
}

/// A copy of `bytes` with one bit of one byte changed.
export function flipBit(bytes: Uint8Array, index: number, mask = 0x01): Bytes {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  copy[index] = (copy[index] ?? 0) ^ mask;
  return copy;
}

/// Runs `step` and returns the problem it was refused with, failing the test if it was not
/// refused or if the refusal carried anything but one of the package's fixed sentences.
export async function refusal(step: () => Promise<unknown>): Promise<string> {
  try {
    await step();
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteChannelError);
    const refused = error as RemoteChannelError;
    expect(REMOTE_CHANNEL_MESSAGES).toContain(refused.message);
    return refused.problem;
  }
  throw new Error("expected a refusal, and the step went through");
}

/// A finished session between a phone and the Mac that share `secret`.
export async function openSession(
  secret: Uint8Array,
  options: { phone?: ChannelOptions; mac?: ChannelOptions; hostId?: string } = {},
): Promise<{ phone: Channel; mac: Channel }> {
  const hostId = options.hostId ?? HOST_ID;
  const started = await startSession({ hostId, deviceId: DEVICE_ID, secret }, { channel: options.phone ?? {} });
  const accepted = await acceptSession(started.hello, { hostId, secretFor: () => secret }, { channel: options.mac ?? {} });
  const { finish, channel: phone } = await started.phone.receiveWelcome(accepted.welcome);
  const mac = await accepted.mac.receiveFinish(finish);
  return { phone, mac };
}

/// One of the fixed throwaway key pairs in `fixtures/ephemeral-keys.json`, so a handshake can be
/// run twice with the same bytes.
export async function fixedKeyPair(name: keyof typeof ephemeralKeys.keys): Promise<CryptoKeyPair> {
  const jwk = ephemeralKeys.keys[name];
  const params = { name: "ECDH", namedCurve: "P-256" };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, params, false, ["deriveBits"]);
  const { d: _private, ...publicJwk } = jwk;
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, params, true, []);
  return { privateKey, publicKey };
}

export const text = (value: string): Bytes => new TextEncoder().encode(value) as Bytes;
export const read = (value: Uint8Array | null): string | null => (value === null ? null : new TextDecoder().decode(value));
