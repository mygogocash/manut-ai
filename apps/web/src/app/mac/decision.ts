/// The answers a phone signs with its passkey, and every wire field they use, in one place so they are matched to the
/// Mac's serve.ts here and only here.
///
/// Allow once (apps/desktop/src/remote/serve.ts, item 78b): step one `{"t":"allow",chat,ask,revision}`; the Mac answers
/// `{"t":"challenge",chat,ask,revision,option:"once",nonce,expiresAt}`; step two is the same request with
/// `option:"once"` and the passkey's answer under `answer`.
///
/// An answer to a question goes through the same two steps (item 115, after a security review on 26 Nov 2026 found that
/// answering a question needed no Face ID, which a stolen unlocked phone could use). Step one is
/// `{"t":"reply",chat,ask,revision,answer}`, or `answers` (one text or null per question) for an interview; the Mac
/// answers `{"t":"challenge",chat,ask,revision,option,nonce,expiresAt}` with `option` the package's `answerOption` of
/// the exact answer, an interview's questions in the order the ask lists them; step two repeats the request with the
/// passkey's answer under `passkey`. The Mac refuses an answer whose words differ from the ones challenged and signed.
/// Saying No to an approval stays a single unsigned `reply` (remote.ts), as the design says.
import { type QuestionAnswer, answerOption, toBase64Url } from "@manut/remote-channel";
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

/// An answer as the Mac reads and binds it: one text, or for an interview a text or null for each question the screen
/// shows, in the ask's order and nothing else, so the words sent are exactly the words the passkey signs.
export async function answerDecision(
  chat: string,
  ask: string,
  revision: number,
  given: string | Record<string, string | null>,
  questions: readonly string[] = [],
): Promise<SignedDecision> {
  let field: Message;
  let bound: QuestionAnswer;
  if (typeof given === "string") {
    field = { answer: given };
    bound = given;
  } else {
    const pairs = questions.map((id) => [id, Object.hasOwn(given, id) ? (given[id] ?? null) : null] as const);
    field = { answers: Object.fromEntries(pairs) };
    bound = pairs;
  }
  return { request: { t: "reply", chat, ask, revision, ...field }, optionId: await answerOption(bound), second: {}, proofField: "passkey", busy: "answer", done: "answered" };
}
