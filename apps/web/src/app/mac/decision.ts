/// The answers a phone signs with its passkey, and every wire field they use, in one place so they are matched to the
/// Mac's serve.ts here and only here.
///
/// Allow once (apps/desktop/src/remote/serve.ts, item 78b): step one `{"t":"allow",chat,ask,revision}`; the Mac answers
/// `{"t":"challenge",chat,ask,revision,option:"once",nonce,expiresAt}`; step two is the same request with
/// `option:"once"` and the passkey's answer under `answer`.
///
/// An answer to a question goes through the same two steps. A security review on 26 Nov 2026 found that answering a
/// question needed no Face ID, which a stolen unlocked phone could use, and item 115 changes the Mac so that it issues
/// the same one-use challenge for an answer, bound to the device, the ask, its revision and a digest of the exact
/// answer. Its final wire shape was not known when this was written, so:
///   - step one is today's `reply` with the answer, which a Mac from before item 115 simply takes (`done`);
///   - when the Mac answers with a challenge instead, the challenge is bound to `answerOption` below, and step two
///     repeats the request with the passkey's answer under `passkey`.
/// Both are marked to be checked against item 115 when it lands. Saying No to an approval stays a single unsigned
/// `reply` (remote.ts), as the design says.
import { toBase64Url } from "@manut/remote-channel";
import type { Assertion } from "./passkeys";
import type { Message } from "./session";

export interface SignedDecision {
  /// The request as step one sends it, and step two repeats.
  readonly request: Message;
  /// What the challenge binds besides the device, the ask and the revision.
  readonly optionId: string;
  /// Added to step two besides the passkey's answer.
  readonly second: Message;
  /// The field step two carries the passkey's answer in.
  readonly proofField: string;
  /// What the ask shows while it waits, and once it is done.
  readonly busy: "allow" | "answer";
  readonly done: "allowed" | "answered";
}

/// The passkey's answer as the Mac reads it (serve.ts `#settleAllow`): the challenge named by its nonce, and the
/// browser's four values, base64url.
export function proofOf(nonce: string, passkey: Assertion): Message {
  return {
    challengeId: nonce,
    credentialId: toBase64Url(passkey.credentialId),
    clientDataJSON: toBase64Url(passkey.clientDataJSON),
    authenticatorData: toBase64Url(passkey.authenticatorData),
    signature: toBase64Url(passkey.signature),
  };
}

export function allowDecision(chat: string, ask: string, revision: number): SignedDecision {
  return { request: { t: "allow", chat, ask, revision }, optionId: "once", second: { option: "once" }, proofField: "answer", busy: "allow", done: "allowed" };
}

/// The choice an answer's challenge is bound to: base64url of the SHA-256 of the answer's JSON exactly as it is sent.
/// To be checked against item 115's Mac.
export async function answerOption(given: string | Record<string, string | null>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(given)));
  return toBase64Url(new Uint8Array(digest));
}

export async function answerDecision(chat: string, ask: string, revision: number, given: string | Record<string, string | null>): Promise<SignedDecision> {
  const field = typeof given === "string" ? { answer: given } : { answers: given };
  return { request: { t: "reply", chat, ask, revision, ...field }, optionId: await answerOption(given), second: {}, proofField: "passkey", busy: "answer", done: "answered" };
}
