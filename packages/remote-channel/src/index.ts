/// The channel between a paired phone and the Mac, through the relay in `apps/api`, which must
/// not be able to read or change it (`docs/remote-access.md`, phase 1, item 78a). Both sides use
/// these same functions: the desktop's page and the web app on the phone. Pure functions over
/// bytes with Web Crypto only; no socket, no storage and no UI, which belong to 78b and 78c.
///
/// - Pairing (`offer.ts`, `pairing.ts`, `grant.ts`): the QR code's offer, the handshake that
///   proves both sides know its secret and gives both screens the same check code, and the grant
///   that hands the phone its id, its relay door and K.
/// - Each connection (`session.ts`, `channel.ts`): a fresh key exchange proved with K, and the
///   numbered, encrypted records it opens, split to fit the relay's frame.
/// - Each decision (`decision.ts`, `webauthn.ts`): a one-use, 60-second challenge bound to one
///   device, request, revision and choice, answered with a passkey the Mac checks.
///
/// See README.md for every byte layout and where each part came from in GoSpark.

export * from "./errors";
export {
  type Bytes,
  type RandomBytes,
  DEVICE_ID,
  equalBytes,
  fromBase64Url,
  fromHex,
  systemRandom,
  toBase64Url,
  toHex,
  uuidFromBytes,
  uuidToBytes,
} from "./bytes";
export { importSharedSecret, SECRET_BYTES } from "./keys";
export {
  type Channel,
  type ChannelOptions,
  type ChannelRole,
  DEFAULT_MAX_MESSAGE_BYTES,
  MAX_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  RECORD_LIMIT,
} from "./channel";
export {
  type PairingOffer,
  DOOR_TOKEN_BYTES,
  PAIRING_TTL_MS,
  decodePairingOffer,
  encodePairingOffer,
  newPairingOffer,
  pairingLink,
  readPairingLink,
} from "./offer";
export { type MacPairing, type PairingOptions, type PhonePairing, macPairing, startPairing } from "./pairing";
export { type PairingGrant, decodePairingGrant, doorTokenHash, encodePairingGrant, newPairingGrant } from "./grant";
export {
  type AssertionResult,
  type PasskeyAssertion,
  type PasskeyRefusal,
  type PasskeyRegistration,
  type RegistrationResult,
  type RelyingParty,
  type StoredPasskey,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
} from "./webauthn";
export {
  type DecisionAnswer,
  type DecisionBinding,
  type DecisionRefusal,
  type DecisionResult,
  type IssuedChallenge,
  DECISION_LIMIT,
  DECISION_TTL_MS,
  DecisionChallenges,
  decisionChallenge,
} from "./decision";
export {
  type MacSessionHandshake,
  type PhoneSessionHandshake,
  type SessionHandshakeOptions,
  acceptSession,
  startSession,
} from "./session";
