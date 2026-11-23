/// Owner messages on LINE: their records (docs/pilot-api.md, "Owner messages on
/// LINE"), kept in the objects that already own each concern:
///
/// - Globally, in AuthObject (`/owner-line/*`): Manut AI's own LINE account
///   (which vault connection holds its secrets; never the secrets), each shop's
///   live link code, kept only as a keyed hash, and the wrong codes each LINE
///   user has sent lately. Only the Worker reaches these paths, and writes need
///   its `x-admin` header, as the registry's do.
/// - Per shop, in its TenantObject (`/pilot-owner/*`): the owner's LINE user id
///   on the shop's record, each reply's card on the reply's record, and one
///   brief record per day. They use pilot-store.ts's records and keys, so the
///   tenant export carries them and the tenant deletion wipes them with the
///   rest. Writes need the Worker's `x-pilot` header, as the pilot's do.

import { APPROVAL_LINK_TTL_MS } from "./approval-link";
import { readJsonBody } from "./body";
import { LINE_USER_ID } from "./connectors/line";
import type { BriefCounts } from "./owner-line-messages";
import { GUESS_LIMIT, GUESS_WINDOW_MS } from "./owner-line-rules";
import { pilotKeys, type InboundMessage, type Payment, type PilotReplyRecord, type PilotShopRecord } from "./pilot-store";

const MAX_BODY_BYTES = 256 * 1024;
/// How long a claimed send holds its claim. A card or brief still marked
/// sending after this was cut off (the Worker stopped) and may be claimed
/// again; its retry key keeps LINE from showing it twice.
export const CLAIM_LEASE_MS = 2 * 60 * 1000;
/// A code's keyed hash: HMAC-SHA256, hex (owner-line.ts).
const CODE_HASH = /^[0-9a-f]{64}$/;
const BRIEF_DATE = /^\d{4}-\d{2}-\d{2}$/;
/// A LINE basic ID as the owner types it to add the account ("@manutai").
/// Shown to operators only; it is never sent anywhere.
export const BASIC_ID = /^@[0-9A-Za-z._-]{1,40}$/;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function bounded(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  return isRecord(parsed.value) ? parsed.value : json({ error: "invalid_request" }, 400);
}

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// AuthObject: Manut AI's account, link codes and guesses
// ---------------------------------------------------------------------------

/// Manut AI's own LINE Official Account. Its channel secret and access token
/// are sealed in the credential vault under `connectionId`, the way a shop's
/// are; this record only says which connection that is.
export type OwnerLineAccountRecord = {
  connectionId: string;
  channelId: string;
  botUserId: string;
  basicId?: string;
  connectedAt: string;
};

/// One link code, under the keyed hash of its digits. `claimedBy` is the LINE
/// user who used it: the same user sending it again (LINE's redelivery, or a
/// second tap) is linked again, anyone else is refused.
type LinkCodeRecord = { tenant: string; expiresAtMs: number; createdAtMs: number; claimedBy?: string };

/// Wrong codes from one LINE user since `windowStartMs`.
type GuessRecord = { windowStartMs: number; failures: number };

/// What sending a code did. A wrong, used or expired code all answer `wrong`.
export type RedeemOutcome = { outcome: "linked"; tenant: string } | { outcome: "wrong" } | { outcome: "limited" };

const ACCOUNT_KEY = "owner-line-account";
const codeKey = (hash: string) => `owner-link-code:${hash}`;
const shopCodeKey = (tenant: string) => `owner-link-shop:${enc(tenant)}`;
const guessKey = (lineUserId: string) => `owner-link-guesses:${lineUserId}`;

/// `/owner-line/*` on AuthObject:
/// - `GET /owner-line/account`: Manut AI's account record, or null;
/// - `POST /owner-line/account`: record a new one, answering the one it replaced;
/// - `POST /owner-line/codes`: keep a shop's new code, retiring its previous one;
/// - `POST /owner-line/codes/forget`: forget a shop's code;
/// - `POST /owner-line/redeem`: check a code sent by a LINE user, under the guess limit;
/// - `POST /owner-line/prune`: drop expired codes and guess windows.
export async function ownerLineAuthRoute(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/owner-line/account") {
    return json({ account: (await storage.get<OwnerLineAccountRecord>(ACCOUNT_KEY)) ?? null });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-admin") !== "1") return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  switch (url.pathname) {
    case "/owner-line/account":
      return writeAccount(storage, body);
    case "/owner-line/codes":
      return issueCode(storage, body);
    case "/owner-line/codes/forget":
      if (!bounded(body.tenant)) return json({ error: "invalid_request" }, 400);
      await forgetOwnerLinkCode(storage, body.tenant);
      return json({ forgotten: true });
    case "/owner-line/redeem":
      return redeemCode(storage, body);
    case "/owner-line/prune":
      return pruneOwnerLine(storage, body);
  }
  return json({ error: "not_found" }, 404);
}

async function writeAccount(storage: DurableObjectStorage, body: Record<string, unknown>) {
  const { connectionId, channelId, botUserId, basicId } = body;
  if (!bounded(connectionId) || !bounded(channelId, 64) || typeof botUserId !== "string" || !LINE_USER_ID.test(botUserId) ||
      (basicId !== undefined && (typeof basicId !== "string" || !BASIC_ID.test(basicId)))) {
    return json({ error: "invalid_request" }, 400);
  }
  const previous = await storage.get<OwnerLineAccountRecord>(ACCOUNT_KEY);
  const account: OwnerLineAccountRecord = {
    connectionId,
    channelId,
    botUserId,
    ...(typeof basicId === "string" ? { basicId } : {}),
    connectedAt: new Date().toISOString(),
  };
  await storage.put(ACCOUNT_KEY, account);
  return json({ account, previous: previous?.connectionId ?? null });
}

/// Keeps a shop's new code and retires the one it had, in one transaction, so a
/// shop never has two codes that could link it. A hash that is already a live
/// code (two random codes alike, about one chance in a hundred million) answers
/// 409, and the Worker draws another.
async function issueCode(storage: DurableObjectStorage, body: Record<string, unknown>) {
  const { tenant, codeHash, expiresAtMs } = body;
  if (!bounded(tenant) || typeof codeHash !== "string" || !CODE_HASH.test(codeHash) || typeof expiresAtMs !== "number" ||
      !Number.isSafeInteger(expiresAtMs)) {
    return json({ error: "invalid_request" }, 400);
  }
  const issued = await storage.transaction(async (txn) => {
    const now = Date.now();
    const taken = await txn.get<LinkCodeRecord>(codeKey(codeHash));
    if (taken && taken.expiresAtMs > now) return false;
    const previous = await txn.get<string>(shopCodeKey(tenant));
    if (previous) await txn.delete(codeKey(previous));
    await txn.put({
      [codeKey(codeHash)]: { tenant, expiresAtMs, createdAtMs: now } satisfies LinkCodeRecord,
      [shopCodeKey(tenant)]: codeHash,
    });
    return true;
  });
  return issued ? json({ issued: true }) : json({ error: "code_taken" }, 409);
}

/// Forgets a shop's code: when its owner is unlinked, and when the shop is
/// deleted (AuthObject's tenant wipe), so no code outlives what it links.
export async function forgetOwnerLinkCode(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const hash = await storage.get<string>(shopCodeKey(tenant));
  await storage.delete([shopCodeKey(tenant), ...(hash ? [codeKey(hash)] : [])]);
}

/// Checks one code a LINE user sent, in one transaction. The guess limit comes
/// first and is never skipped: a user past it is refused without the code being
/// looked at, so the right code teaches a guesser nothing either. Only a wrong
/// code counts against the limit; ordinary chat never reaches here.
async function redeemCode(storage: DurableObjectStorage, body: Record<string, unknown>) {
  const { codeHash, lineUserId } = body;
  if (typeof codeHash !== "string" || !CODE_HASH.test(codeHash) || typeof lineUserId !== "string" ||
      !LINE_USER_ID.test(lineUserId)) {
    return json({ error: "invalid_request" }, 400);
  }
  const outcome = await storage.transaction(async (txn): Promise<RedeemOutcome> => {
    const now = Date.now();
    const guesses = await txn.get<GuessRecord>(guessKey(lineUserId));
    const window = guesses && now - guesses.windowStartMs < GUESS_WINDOW_MS ? guesses : null;
    if (window && window.failures >= GUESS_LIMIT) return { outcome: "limited" };
    const code = await txn.get<LinkCodeRecord>(codeKey(codeHash));
    if (code && code.expiresAtMs > now && (code.claimedBy === undefined || code.claimedBy === lineUserId)) {
      await txn.put(codeKey(codeHash), { ...code, claimedBy: lineUserId } satisfies LinkCodeRecord);
      return { outcome: "linked", tenant: code.tenant };
    }
    await txn.put(guessKey(lineUserId), window
      ? { windowStartMs: window.windowStartMs, failures: window.failures + 1 }
      : { windowStartMs: now, failures: 1 } satisfies GuessRecord);
    return { outcome: "wrong" };
  });
  return json(outcome);
}

/// Drops what has stopped mattering: codes past their expiry, with their
/// shops' pointers, and guess windows that have closed, so no LINE user id is
/// kept longer than the limit needs it. The clock comes from the Worker's
/// daily run and is clamped to this object's, so no caller can expire a code
/// early.
async function pruneOwnerLine(storage: DurableObjectStorage, body: Record<string, unknown>) {
  const nowMs = typeof body.nowMs === "number" && Number.isFinite(body.nowMs) ? Math.min(body.nowMs, Date.now()) : Date.now();
  const doomed: string[] = [];
  let codesPruned = 0;
  for (const [key, code] of await storage.list<LinkCodeRecord>({ prefix: "owner-link-code:" })) {
    if (code.expiresAtMs > nowMs) continue;
    doomed.push(key);
    codesPruned++;
    const hash = key.slice("owner-link-code:".length);
    if ((await storage.get<string>(shopCodeKey(code.tenant))) === hash) doomed.push(shopCodeKey(code.tenant));
  }
  let guessesPruned = 0;
  for (const [key, guesses] of await storage.list<GuessRecord>({ prefix: "owner-link-guesses:" })) {
    if (nowMs - guesses.windowStartMs < GUESS_WINDOW_MS) continue;
    doomed.push(key);
    guessesPruned++;
  }
  for (let i = 0; i < doomed.length; i += 128) await storage.delete(doomed.slice(i, i + 128));
  return json({ codesPruned, guessesPruned });
}

// ---------------------------------------------------------------------------
// TenantObject: the owner's link, cards and briefs
// ---------------------------------------------------------------------------

export type OwnerCardState = "sending" | "sent" | "failed" | "unknown";

/// The owner's card for one reply, as its reply record keeps it: the latest
/// push's outcome, how many pushes were tried (every one under the same retry
/// key), when the latest began, when LINE took one, and why the latest did not
/// go through (`provider_429`, `provider_unreachable`, `account_not_set`, ...).
export type OwnerCard = {
  state: OwnerCardState;
  attempts: number;
  lastTriedAt: string;
  sentAt?: string;
  reason?: string;
};

export type OwnerBriefState = "sending" | "sent" | "failed" | "unknown" | "skipped";

/// One morning brief, at most one per shop per Bangkok date. `skipped` is a day
/// with nothing to say, when nothing is sent.
export type OwnerBriefRecord = {
  date: string;
  state: OwnerBriefState;
  attempts: number;
  claimedAt: string;
  settledAt?: string;
  counts?: BriefCounts;
  reason?: string;
};

/// A reply the morning brief looks at: proposed recently enough to have been
/// sent yesterday or to be waiting now.
export type BriefReply = { taskId: string; actionId: string; proposedAt: string };

/// `/pilot-owner/*` on a TenantObject:
/// - `GET /pilot-owner/brief-counts?tenant=&from=&to=`: yesterday's messages and payments, and the replies to check;
/// - `POST /pilot-owner/link`, `/unlink`: set or clear the owner's LINE user id on the shop;
/// - `POST /pilot-owner/card-claim`, `/card-settle`: claim a reply's card for a push, and record what LINE said;
/// - `POST /pilot-owner/brief-claim`, `/brief-settle`: the same for one day's brief.
export async function ownerLineTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/pilot-owner/brief-counts") {
    const tenant = url.searchParams.get("tenant") ?? "";
    const fromMs = Number(url.searchParams.get("from"));
    const toMs = Number(url.searchParams.get("to"));
    if (!bounded(tenant) || !Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs) {
      return json({ error: "invalid_request" }, 400);
    }
    return briefCounts(storage, tenant, fromMs, toMs);
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-pilot") !== "1") return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (!bounded(body.tenant)) return json({ error: "invalid_request" }, 400);
  const tenant = body.tenant;
  switch (url.pathname) {
    case "/pilot-owner/link":
      return linkOwner(storage, tenant, body);
    case "/pilot-owner/unlink":
      return unlinkOwner(storage, tenant);
    case "/pilot-owner/card-claim":
      return claimCard(storage, tenant, body);
    case "/pilot-owner/card-settle":
      return settleCard(storage, tenant, body);
    case "/pilot-owner/brief-claim":
      return claimBrief(storage, tenant, body);
    case "/pilot-owner/brief-settle":
      return settleBrief(storage, tenant, body);
  }
  return json({ error: "not_found" }, 404);
}

/// Puts the owner's LINE user id on the shop. A newer link replaces an older
/// one: the code was handed to whoever the operator chose.
async function linkOwner(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { lineUserId } = body;
  if (typeof lineUserId !== "string" || !LINE_USER_ID.test(lineUserId)) return json({ error: "invalid_request" }, 400);
  const shop = await storage.get<PilotShopRecord>(pilotKeys.shop(tenant));
  if (!shop) return json({ error: "not_found" }, 404);
  await storage.put(pilotKeys.shop(tenant), { ...shop, ownerLineUserId: lineUserId, ownerLinkedAt: new Date().toISOString() });
  return json({ shopName: shop.name });
}

async function unlinkOwner(storage: DurableObjectStorage, tenant: string) {
  const shop = await storage.get<PilotShopRecord>(pilotKeys.shop(tenant));
  if (!shop) return json({ error: "not_found" }, 404);
  if (shop.ownerLineUserId === undefined) return json({ unlinked: false });
  const { ownerLineUserId: _id, ownerLinkedAt: _at, ...rest } = shop;
  await storage.put(pilotKeys.shop(tenant), rest);
  return json({ unlinked: true });
}

/// Claims a reply's card for one push. The first push after a proposal claims a
/// reply that has no card yet; only the operator's retry (`retry: true`) claims
/// one that failed, is unknown, or was cut off while sending. A card already
/// sent, or one another push holds, is answered as it stands and not claimed.
async function claimCard(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.actionId)) return json({ error: "invalid_request" }, 400);
  const key = pilotKeys.reply(tenant, body.actionId);
  const reply = await storage.get<PilotReplyRecord>(key);
  if (!reply) return json({ error: "reply_not_found" }, 404);
  const now = Date.now();
  const card = reply.ownerCard;
  if (card) {
    const held = card.state === "sending" && now - Date.parse(card.lastTriedAt) < CLAIM_LEASE_MS;
    if (card.state === "sent" || held || body.retry !== true) return json({ claimed: false, card });
  }
  const next: OwnerCard = { state: "sending", attempts: (card?.attempts ?? 0) + 1, lastTriedAt: new Date(now).toISOString() };
  await storage.put(key, { ...reply, ownerCard: next } satisfies PilotReplyRecord);
  return json({ claimed: true, card: next });
}

/// Records what LINE said to a claimed card's push.
async function settleCard(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { actionId, state, reason } = body;
  if (!bounded(actionId) || (state !== "sent" && state !== "failed" && state !== "unknown") ||
      (reason !== undefined && !bounded(reason, 64))) {
    return json({ error: "invalid_request" }, 400);
  }
  const key = pilotKeys.reply(tenant, actionId);
  const reply = await storage.get<PilotReplyRecord>(key);
  if (!reply) return json({ error: "reply_not_found" }, 404);
  if (!reply.ownerCard) return json({ error: "not_claimed" }, 409);
  const { attempts, lastTriedAt } = reply.ownerCard;
  const card: OwnerCard = {
    state,
    attempts,
    lastTriedAt,
    ...(state === "sent" ? { sentAt: new Date().toISOString() } : typeof reason === "string" ? { reason } : {}),
  };
  await storage.put(key, { ...reply, ownerCard: card } satisfies PilotReplyRecord);
  return json({ card });
}

/// Claims one day's brief for a push. A brief already sent, refused by LINE or
/// skipped is final for that day; one LINE never answered (`unknown`) or one cut
/// off while sending is claimed again by a later run that day, and goes out
/// under the same retry key, so LINE shows it once.
async function claimBrief(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (typeof body.date !== "string" || !BRIEF_DATE.test(body.date)) return json({ error: "invalid_request" }, 400);
  if (!(await storage.get(pilotKeys.shop(tenant)))) return json({ error: "not_found" }, 404);
  const key = pilotKeys.brief(tenant, body.date);
  const brief = await storage.get<OwnerBriefRecord>(key);
  const now = Date.now();
  if (brief) {
    const held = brief.state === "sending" && now - Date.parse(brief.claimedAt) < CLAIM_LEASE_MS;
    if (held || (brief.state !== "sending" && brief.state !== "unknown")) return json({ claimed: false, brief });
  }
  const next: OwnerBriefRecord = {
    date: body.date,
    state: "sending",
    attempts: (brief?.attempts ?? 0) + 1,
    claimedAt: new Date(now).toISOString(),
  };
  await storage.put(key, next);
  return json({ claimed: true, brief: next });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBriefCounts(value: unknown): value is BriefCounts {
  return isRecord(value) && isCount(value.messages) && isCount(value.repliesSent) && isCount(value.repliesWaiting) &&
    isCount(value.payments);
}

async function settleBrief(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { date, state, counts, reason } = body;
  if (typeof date !== "string" || !BRIEF_DATE.test(date) || !isBriefCounts(counts) ||
      (state !== "sent" && state !== "failed" && state !== "unknown" && state !== "skipped") ||
      (reason !== undefined && !bounded(reason, 64))) {
    return json({ error: "invalid_request" }, 400);
  }
  const key = pilotKeys.brief(tenant, date);
  const brief = await storage.get<OwnerBriefRecord>(key);
  if (!brief) return json({ error: "not_claimed" }, 409);
  const { reason: _previous, ...rest } = brief;
  const next: OwnerBriefRecord = {
    ...rest,
    state,
    counts,
    settledAt: new Date().toISOString(),
    ...(state !== "sent" && state !== "skipped" && typeof reason === "string" ? { reason } : {}),
  };
  await storage.put(key, next);
  return json({ brief: next });
}

function within(iso: string, fromMs: number, toMs: number): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
}

/// Yesterday's customer messages and order payments, counted here, and the
/// replies the Worker checks on their tasks: any proposed in the 24 hours before
/// yesterday began or since, since a reply sent yesterday or waiting now was
/// proposed at most one approval window before. Messages are kept 7 days and
/// replies are few, so a full walk stays small.
async function briefCounts(storage: DurableObjectStorage, tenant: string, fromMs: number, toMs: number) {
  let messages = 0;
  for (const message of (await storage.list<InboundMessage>({ prefix: pilotKeys.messages(tenant) })).values()) {
    if (within(message.receivedAt, fromMs, toMs)) messages++;
  }
  let payments = 0;
  for (const payment of (await storage.list<Payment>({ prefix: pilotKeys.payments(tenant) })).values()) {
    if (within(payment.confirmedAt, fromMs, toMs)) payments++;
  }
  const replies: BriefReply[] = [];
  for (const reply of (await storage.list<PilotReplyRecord>({ prefix: pilotKeys.replies(tenant) })).values()) {
    if (Date.parse(reply.proposedAt) >= fromMs - APPROVAL_LINK_TTL_MS) {
      replies.push({ taskId: reply.taskId, actionId: reply.actionId, proposedAt: reply.proposedAt });
    }
  }
  return json({ messages, payments, replies });
}
