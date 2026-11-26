import { type Bytes, type RandomBytes, DEVICE_ID, draw, lengthPrefixed, systemRandom, toBase64Url, u32, utf8 } from "./bytes";
import { RemoteChannelError } from "./errors";
import { sha256 } from "./keys";
import { type PasskeyAssertion, type PasskeyRefusal, type RelyingParty, type StoredPasskey, verifyPasskeyAssertion } from "./webauthn";

/// The one-use challenge behind every Allow from a phone, ported from GoSpark's
/// `RemoteDecisionChallenges` (`Shared/Remote/RemoteDecisionChallenges.swift`): it lasts 60
/// seconds, at most 16 wait at once, and an answer spends it whether it holds or not, so no
/// challenge can be tried twice. GoSpark bound the challenge to the device, the command id and the
/// whole command through the bytes the phone signed (`RemoteAuthentication.signingPayload`); here
/// it is bound to the device, the approval request, the revision the person saw and the option
/// they chose (approval-core's `Decision`), through the challenge the passkey signs:
///
/// ```text
/// challenge = SHA-256("manut-remote-v1 decision" || 0x00 || nonce (32)
///                     || len16 device id || len16 request id || u32 revision || len16 option id)
/// ```
///
/// with each text as UTF-8 after a 16-bit big-endian length. The phone computes the same bytes
/// from the nonce and what its screen shows, so it signs what the person sees, and the Mac
/// checks the answer against the entry it issued, never against the answer's own claims. Only
/// when this says `ok` does the Mac pass the decision to approval-core's `settleApproval`, which
/// settles a request once.

export const DECISION_TTL_MS = 60_000;
export const DECISION_LIMIT = 16;
const MAX_ID_CHARS = 1_024;
const LABEL = utf8("manut-remote-v1 decision");

export interface DecisionBinding {
  /// The paired device asking, from its proved session.
  readonly deviceId: string;
  readonly requestId: string;
  /// The revision of the request the person saw (approval-core's `seenRevision`).
  readonly revision: number;
  /// The option chosen (approval-core's `optionId`).
  readonly optionId: string;
}

export interface IssuedChallenge {
  /// The nonce as base64url, which names this challenge in the answer.
  readonly id: string;
  readonly nonce: Bytes;
  /// The bytes the passkey signs: `navigator.credentials.get({ publicKey: { challenge } })`.
  readonly challenge: Bytes;
  /// The first instant at which an answer is refused as expired.
  readonly expiresAt: number;
}

/// The phone's answer: which challenge, what it decided, and the passkey's assertion over it.
export interface DecisionAnswer extends PasskeyAssertion {
  readonly challengeId: string;
  readonly requestId: string;
  readonly revision: number;
  readonly optionId: string;
}

/// Why an answer was refused, beyond the passkey's own reasons.
/// - `unknown`: no such challenge waits: never issued, issued by another Mac, or already spent.
/// - `expired`: answered 60 seconds or more after it was issued.
/// - `other_device`, `other_request`, `other_revision`, `other_choice`: the answer is not for
///   what the challenge was issued for.
export type DecisionRefusal = "unknown" | "expired" | "other_device" | "other_request" | "other_revision" | "other_choice" | PasskeyRefusal;

export type DecisionResult =
  | { readonly ok: true; readonly binding: DecisionBinding; readonly signCount: number }
  | { readonly ok: false; readonly refused: DecisionRefusal };

function checkedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) throw new RemoteChannelError("invalid");
  return value;
}

function checkedBinding(binding: DecisionBinding): DecisionBinding {
  if (typeof binding.deviceId !== "string" || !DEVICE_ID.test(binding.deviceId)) throw new RemoteChannelError("invalid");
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1 || binding.revision > 0xffff_ffff) {
    throw new RemoteChannelError("invalid");
  }
  return {
    deviceId: binding.deviceId,
    requestId: checkedText(binding.requestId),
    revision: binding.revision,
    optionId: checkedText(binding.optionId),
  };
}

const ANSWER_LABEL = utf8("manut-remote-v1 answer");

/// A phone's answer to an agent's question: one text, or for an interview each question's id with
/// its text or null (skipped), in the order the ask lists its questions.
export type QuestionAnswer = string | readonly (readonly [string, string | null])[];

/// The choice (`optionId`) an answer's challenge is bound to: `answer:` and the base64url
/// SHA-256 of "manut-remote-v1 answer" || 0x00 || the answer as JSON, `["text", <text>]` or
/// `["answers", [[<id>, <text or null>], ...]]`. An answer steers the agent as much as an Allow
/// does, so the passkey signs the exact words: a phone that sends other words than it signed, or
/// signs other words than it was challenged for, is refused. Arrays, not an object, so the order
/// is the ask's and never the engine's (which puts number-like keys first).
export async function answerOption(answer: QuestionAnswer): Promise<string> {
  const json = typeof answer === "string" ? JSON.stringify(["text", answer]) : JSON.stringify(["answers", answer]);
  return `answer:${toBase64Url(await sha256(ANSWER_LABEL, Uint8Array.of(0), utf8(json)))}`;
}

/// The bytes a passkey signs for one decision, as the Mac issues them and the phone recomputes.
export async function decisionChallenge(nonce: Uint8Array, binding: DecisionBinding): Promise<Bytes> {
  if (nonce.length !== 32) throw new RemoteChannelError("invalid");
  const b = checkedBinding(binding);
  return sha256(
    LABEL,
    Uint8Array.of(0),
    nonce,
    lengthPrefixed(b.deviceId),
    lengthPrefixed(b.requestId),
    u32(b.revision),
    lengthPrefixed(b.optionId),
  );
}

interface Entry {
  readonly binding: DecisionBinding;
  readonly challenge: Bytes;
  readonly expiresAt: number;
}

/// The Mac's open challenges. Keep one per Mac, or one per connection as GoSpark did; either way
/// it lives in memory only, so a restart spends every open challenge. Two answers from one device
/// checked at once each return a counter; the caller stores them in the order it checked them,
/// or checks one device's answers one at a time.
export class DecisionChallenges {
  readonly #random: RandomBytes;
  readonly #entries = new Map<string, Entry>();

  constructor(options: { random?: RandomBytes } = {}) {
    this.#random = options.random ?? systemRandom;
  }

  /// How many challenges wait, expired ones included until the next issue clears them.
  get size(): number {
    return this.#entries.size;
  }

  /// A new challenge for one decision. Refused as `busy` while sixteen unexpired ones wait.
  async issue(binding: DecisionBinding, now: number): Promise<IssuedChallenge> {
    const bound = checkedBinding(binding);
    const nonce = draw(this.#random, 32);
    const challenge = await decisionChallenge(nonce, bound);
    // From here to the insert nothing awaits, so two issues at once cannot both pass the cap.
    for (const [id, entry] of this.#entries) if (!(now < entry.expiresAt)) this.#entries.delete(id);
    if (this.#entries.size >= DECISION_LIMIT) throw new RemoteChannelError("busy");
    const id = toBase64Url(nonce);
    const expiresAt = now + DECISION_TTL_MS;
    this.#entries.set(id, { binding: bound, challenge, expiresAt });
    return { id, nonce, challenge, expiresAt };
  }

  /// Drops every challenge that waits for `deviceId`, and says how many. The Mac calls it at
  /// Unpair, with closing that device's channels itself: the relay's own `revoke` is not trusted
  /// to end anything, and a phone on another road has no relay at all.
  revoke(deviceId: string): number {
    let dropped = 0;
    for (const [id, entry] of this.#entries) {
      if (entry.binding.deviceId === deviceId) {
        this.#entries.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  /// Checks one answer from the device whose session it arrived on. The challenge is spent before
  /// anything else is read and before anything awaits, so a second answer, even one sent at the
  /// same moment, finds nothing.
  async verify(
    answer: DecisionAnswer,
    context: { readonly deviceId: string; readonly passkey: StoredPasskey; readonly rp: RelyingParty; readonly now: number },
  ): Promise<DecisionResult> {
    const id = typeof answer.challengeId === "string" ? answer.challengeId : null;
    const entry = id === null ? undefined : this.#entries.get(id);
    if (id !== null) this.#entries.delete(id);
    if (entry === undefined) return { ok: false, refused: "unknown" };
    if (!(context.now < entry.expiresAt)) return { ok: false, refused: "expired" };
    const bound = entry.binding;
    if (context.deviceId !== bound.deviceId) return { ok: false, refused: "other_device" };
    if (answer.requestId !== bound.requestId) return { ok: false, refused: "other_request" };
    if (answer.revision !== bound.revision) return { ok: false, refused: "other_revision" };
    if (answer.optionId !== bound.optionId) return { ok: false, refused: "other_choice" };
    const passkey = await verifyPasskeyAssertion(answer, { challenge: entry.challenge, rp: context.rp, passkey: context.passkey });
    if (!passkey.ok) return passkey;
    return { ok: true, binding: bound, signCount: passkey.signCount };
  }
}
