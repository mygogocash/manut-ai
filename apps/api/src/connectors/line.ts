/// LINE Messaging API connector for the Manut AI pilot (docs/pilot-api.md):
/// one shop's LINE Official Account. Three things live here and nothing else:
/// checking a webhook delivery's signature, reading the text messages users
/// sent out of a verified delivery, and the push call the broker makes once
/// the owner has approved one exact reply. Everything is a pure function over
/// an injected fetch, so tests run it against stubs and production passes the
/// global fetch, the same arrangement as the Linear connector.
///
/// Every endpoint, header, limit and format below is taken from LINE's own
/// documentation, cited beside it. Nothing here is a guess: when the docs are
/// silent the code takes the reading that can never send twice.

import type { FetchImpl } from "./types";

/// The broker operation for one approved reply. Adding it to the task
/// object's allowlist is what lets a proposal name it at all.
export const LINE_PUSH_OPERATION = "line.message.push";

/// https://developers.line.biz/en/reference/messaging-api/#send-push-message
/// ("POST https://api.line.me/v2/bot/message/push").
export const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/// https://developers.line.biz/en/reference/messaging-api/#get-profile
/// ("GET https://api.line.me/v2/bot/profile/{userId}").
const LINE_PROFILE_URL = "https://api.line.me/v2/bot/profile/";

/// https://developers.line.biz/en/reference/messaging-api/#text-message
/// ("Max character limit: 5000"). LINE does not say whether it counts UTF-16
/// units or code points; JavaScript's `length` counts UTF-16 units, which is
/// never fewer than code points, so a text that passes here passes there under
/// either reading. Thai script sits in the Basic Multilingual Plane, so for
/// the pilot's replies the two counts agree; only emoji count double here.
export const LINE_TEXT_MAX = 5000;

/// https://developers.line.biz/en/docs/messaging-api/getting-user-ids/
/// ("The LINE Platform issues a user ID as a string, formatted as
/// `U[0-9a-f]{32}`"). A bot's own user id, the webhook's `destination`, has
/// the same form (https://developers.line.biz/en/reference/messaging-api/#request-body).
export const LINE_USER_ID = /^U[0-9a-f]{32}$/;

/// https://developers.line.biz/en/reference/messaging-api/#retry-api-request
/// ("Arbitrarily generated UUID in hexadecimal notation (e.g.
/// 123e4567-e89b-12d3-a456-426614174000)"). Action ids are minted by
/// `crypto.randomUUID()`, which always has this form.
const LINE_RETRY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/// https://developers.line.biz/en/reference/messaging-api/#signature-validation:
/// `x-line-signature` is the Base64 (standard alphabet, padded) HMAC-SHA256
/// digest of the request body. A 32-byte digest is always 43 characters and
/// one `=`.
const LINE_SIGNATURE = /^[A-Za-z0-9+/]{43}=$/;

/// https://developers.line.biz/en/reference/messaging-api/#common-properties:
/// `webhookEventId` is "a string in ULID format". Deduplication only needs a
/// bounded opaque key, so this accepts any short alphanumeric id rather than
/// insisting on the exact ULID alphabet.
const WEBHOOK_EVENT_ID = /^[0-9A-Za-z]{1,128}$/;

/// The same bound the Linear issue call uses: a push that has not answered
/// in 15 seconds is treated as an ambiguous outcome, never as a failure.
const PUSH_TIMEOUT_MS = 15_000;
/// The display-name lookup runs after the webhook has already answered, so
/// it only needs to stay well inside the Worker's waitUntil budget.
const PROFILE_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// What the vault holds for one LINE connection. The vault seals one opaque
/// string per connection, so the channel access token (for pushes and
/// profile reads) and the channel secret (for webhook signatures) travel
/// sealed together as this envelope. Neither ever leaves the vault except
/// through the broker-only unseal, and no route returns either.
export type LineCredentials = {
  channelAccessToken: string;
  channelSecret: string;
};

export function sealableLineCredentials(credentials: LineCredentials): string {
  return JSON.stringify({ v: 1, channelAccessToken: credentials.channelAccessToken, channelSecret: credentials.channelSecret });
}

/// Reads the envelope back, or null for anything that is not one: a
/// connection stored through another route holds a bare token, and that must
/// fail closed rather than be mistaken for a usable pair.
export function openLineCredentials(sealed: string): LineCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sealed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  const { channelAccessToken, channelSecret } = parsed;
  if (typeof channelAccessToken !== "string" || !channelAccessToken) return null;
  if (typeof channelSecret !== "string" || !channelSecret) return null;
  return { channelAccessToken, channelSecret };
}

/// Whether a header could be a LINE signature at all. The webhook route asks
/// this before unsealing the channel secret, so a request without one costs
/// no vault work.
export function hasLineSignatureShape(header: string | null): header is string {
  return header !== null && LINE_SIGNATURE.test(header);
}

/// Checks `x-line-signature` against the exact received bytes under the
/// channel secret. `crypto.subtle.verify` compares in constant time, so a
/// forger learns nothing from how long a refusal takes. A missing secret or a
/// header of the wrong shape fails closed.
export async function verifyLineSignature(
  channelSecret: string | undefined,
  raw: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (!channelSecret || !hasLineSignatureShape(header)) return false;
  const binary = atob(header);
  const digest = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) digest[i] = binary.charCodeAt(i);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, digest, raw);
}

/// One text message a user sent the shop, as much of it as the pilot keeps.
export type LineTextEvent = {
  webhookEventId: string;
  lineUserId: string;
  text: string;
};

/// The text messages from users in a verified delivery. Shape follows
/// https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects:
/// `{ destination, events: [{ type: "message", message: { type: "text",
/// text }, source: { type: "user", userId }, webhookEventId, ... }] }`.
///
/// A delivery addressed to another bot (`destination` differs from the
/// connection's bot user id) yields nothing, so a channel secret shared by
/// mistake between two connections cannot file one shop's customers under
/// another. Group and multi-person chats, stickers, images, follows and every
/// other kind are skipped: the pilot answers one customer at a time, in
/// text. Reply tokens, quote tokens and read tokens are never kept.
export function lineTextEvents(payload: unknown, botUserId: string): LineTextEvent[] {
  if (!isRecord(payload) || payload.destination !== botUserId || !Array.isArray(payload.events)) return [];
  const events: LineTextEvent[] = [];
  for (const event of payload.events) {
    if (!isRecord(event) || event.type !== "message") continue;
    const { message, source, webhookEventId } = event;
    if (!isRecord(message) || message.type !== "text") continue;
    if (typeof message.text !== "string" || message.text.length === 0) continue;
    if (!isRecord(source) || source.type !== "user") continue;
    if (typeof source.userId !== "string" || !LINE_USER_ID.test(source.userId)) continue;
    if (typeof webhookEventId !== "string" || !WEBHOOK_EVENT_ID.test(webhookEventId)) continue;
    events.push({ webhookEventId, lineUserId: source.userId, text: message.text });
  }
  return events;
}

/// The reply text out of a `line.message.push` payload, or null when the
/// payload is anything other than exactly `{ text }` with 1 to 5,000
/// characters. Extra keys are refused rather than ignored: the owner approves
/// the whole payload, so nothing may ride along unseen.
export function lineReplyText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 1 || keys[0] !== "text") return null;
  const text = payload.text;
  if (typeof text !== "string" || text.length < 1 || text.length > LINE_TEXT_MAX) return null;
  return text;
}

/// Propose-time shape of a `line.message.push`: exactly one recipient, a LINE
/// user id; the target is the bot's own user id; the payload is exactly one
/// reply text. Whether that recipient wrote the message being answered is a
/// fact about stored messages the task object cannot see, so the broker
/// checks it again from the shop's records before any traffic.
export function isValidLinePushProposal(input: {
  payload: unknown;
  recipients: unknown[];
  targetResourceId: string;
}): boolean {
  return (
    lineReplyText(input.payload) !== null &&
    input.recipients.length === 1 &&
    typeof input.recipients[0] === "string" &&
    LINE_USER_ID.test(input.recipients[0]) &&
    LINE_USER_ID.test(input.targetResourceId)
  );
}

/// What a confirmed push leaves on the action. Ids only, never the text.
export type LinePushReceipt = {
  providerOperationId: string;
  /// `x-line-request-id` of this call.
  requestId?: string;
  /// Set only on a 409: `x-line-accepted-request-id`, the earlier request
  /// LINE had already accepted under the same retry key.
  acceptedRequestId?: string;
  sentMessageIds: string[];
  alreadyAccepted: boolean;
};

/// The broker's three settle outcomes, decided here so the classification
/// sits beside the documentation it rests on.
export type LinePushOutcome =
  | { outcome: "confirmed"; receipt: LinePushReceipt }
  | { outcome: "failed" | "unknown"; reason: string };

function sentMessageIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.sentMessages)) return [];
  const ids: string[] = [];
  for (const sent of body.sentMessages) {
    // Documented as a Number, shown as a string in every example, and too
    // large for a double either way; both spellings are kept as text.
    if (isRecord(sent) && (typeof sent.id === "string" || typeof sent.id === "number")) ids.push(String(sent.id));
  }
  return ids;
}

/// Sends one approved reply as a push message, with the action id as LINE's
/// retry key (`X-Line-Retry-Key`) on the first and only request.
///
/// Classification, consistent with the Linear call's rule that `failed`
/// means nothing happened and anything doubtful is `unknown`:
///
/// - 2xx: LINE accepted the push. Confirmed.
/// - 409 carrying `x-line-accepted-request-id`: "An API request with the same
///   retry key has already been accepted"
///   (https://developers.line.biz/en/reference/messaging-api/#status-codes).
///   An earlier request with this exact key, which is this exact approved
///   action, already went through, and LINE answers with that request's id
///   and the same `sentMessages`
///   (https://developers.line.biz/en/docs/messaging-api/retrying-api-request/).
///   Sending again is precisely the duplicate the key exists to stop, so this
///   settles confirmed, marked `alreadyAccepted`, never failed (which would
///   tell the owner nothing went out when it did) and never unknown (LINE has
///   answered the question). LINE's own caveat applies to every confirmed
///   push alike: accepted means accepted by the platform, not read by the
///   customer, who may have blocked the account. A 409 without that header is
///   not the documented answer and settles unknown.
/// - Any other 4xx: refused, and "The messages aren't sent if an error is
///   returned" (https://developers.line.biz/en/reference/messaging-api/#send-push-message-error-response).
///   LINE also says retrying a 4xx does not change the result. Failed. This
///   includes 429, LINE's rate and monthly-quota refusal, which is stricter
///   than the Linear call's reading of 429 only because LINE documents that
///   nothing was sent.
/// - 5xx, a timeout or a network error: the request may or may not have been
///   accepted. Unknown, which the broker never retries on its own.
///
/// The key only deduplicates within 24 hours of the first request ("If you
/// use the same retry key for more than 24 hours, the request will succeed as
/// a new API request"). The broker sends each action at most once, its
/// approval link and proposal expire 24 hours after proposal, and an unknown
/// outcome is never retried automatically, so no request with a stale key is
/// ever made.
export async function pushLineMessage(
  fetchImpl: FetchImpl,
  channelAccessToken: string,
  input: { to: string; text: string; retryKey: string },
): Promise<LinePushOutcome> {
  if (!LINE_USER_ID.test(input.to) || !LINE_RETRY_KEY.test(input.retryKey) || lineReplyText({ text: input.text }) === null) {
    return { outcome: "failed", reason: "invalid_payload" };
  }
  let response: Response;
  try {
    response = await fetchImpl(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelAccessToken}`,
        "content-type": "application/json",
        "x-line-retry-key": input.retryKey,
      },
      body: JSON.stringify({ to: input.to, messages: [{ type: "text", text: input.text }] }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
  } catch {
    return { outcome: "unknown", reason: "provider_unreachable" };
  }
  const requestId = response.headers.get("x-line-request-id") ?? undefined;
  const acceptedRequestId = response.headers.get("x-line-accepted-request-id") ?? undefined;
  // The body only names the sent message ids. An unreadable body does not
  // undo an acceptance the status already reported.
  const body: unknown = await response.json().catch(() => null);
  const ids = sentMessageIds(body);
  if (response.ok || (response.status === 409 && acceptedRequestId)) {
    const alreadyAccepted = response.status === 409;
    const providerOperationId =
      ids[0] ?? (alreadyAccepted ? acceptedRequestId : requestId) ?? input.retryKey;
    return {
      outcome: "confirmed",
      receipt: {
        providerOperationId,
        ...(requestId ? { requestId } : {}),
        ...(alreadyAccepted && acceptedRequestId ? { acceptedRequestId } : {}),
        sentMessageIds: ids,
        alreadyAccepted,
      },
    };
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 409) {
    return { outcome: "failed", reason: `provider_${response.status}` };
  }
  return { outcome: "unknown", reason: `provider_${response.status}` };
}

/// The customer's LINE display name, or null whenever it cannot be had: the
/// user has not consented, has blocked the account, the call fails or times
/// out. Only `displayName` is kept; the picture, status message and language
/// in the same answer are dropped.
export async function fetchLineDisplayName(
  fetchImpl: FetchImpl,
  channelAccessToken: string,
  lineUserId: string,
): Promise<string | null> {
  if (!LINE_USER_ID.test(lineUserId)) return null;
  try {
    const response = await fetchImpl(`${LINE_PROFILE_URL}${lineUserId}`, {
      headers: { authorization: `Bearer ${channelAccessToken}` },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.displayName !== "string") return null;
    const name = body.displayName.trim();
    return name.length > 0 && name.length <= 256 ? name : null;
  } catch {
    return null;
  }
}
