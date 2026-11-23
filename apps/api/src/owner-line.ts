/// Owner messages on LINE (docs/pilot-api.md, "Owner messages on LINE"):
/// Manut AI's own LINE Official Account messages each shop's owner. Behind the
/// `ownerLine` flag, off in every environment until the owner turns it on.
///
/// - Manut AI's account is a connection in the credential vault, held the way
///   a shop's is: its channel secret and access token are sealed together and
///   never answered or logged. An operator sets it; its webhook has a path of
///   its own and is verified with its own channel secret.
/// - An owner is linked with a one-time code an operator asks for: eight
///   digits, half an hour, single use, kept only as a keyed hash. The owner
///   adds Manut AI's account as a friend and sends the code in the chat; the
///   webhook puts the owner's LINE user id on the shop.
/// - Each reply proposed for a linked owner's shop gets one card: the
///   customer's message, the draft, and one button that opens the existing
///   signed approval page. The card decides nothing: the page shows the exact
///   action and settles once, under the existing rules. A card that fails never
///   fails the proposal; it is recorded on the reply and the operator can retry.
/// - At 08:00 Bangkok time each linked owner of a live shop gets yesterday's
///   counts, once per shop per day however many runs arrive.
///
/// Every push carries a retry key derived from what it is about, so a push sent
/// again (a retried run, an operator's retry) is never shown twice. These are
/// messages from Manut AI to the owner who asked for them by sending a code:
/// nothing here sends, posts, pays or deletes anything for the shop, and the
/// card's one way to act is the approval page's single settle-once decision.

import { mintApprovalToken } from "./approval-link";
import { readBodyBytes, readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import {
  hasLineSignatureShape,
  LINE_USER_ID,
  lineReplyText,
  lineRetryKey,
  lineTextEventsWithReply,
  openLineCredentials,
  pushLineMessages,
  replyLineMessages,
  sealableLineCredentials,
  verifyLineSignature,
  type LineCredentials,
} from "./connectors/line";
import { readConnectionSecret } from "./cred-broker";
import type { FeatureFlags } from "./index";
import { codeAnswers, morningBriefMessage, ownerCardMessage, type BriefCounts, type TextMessage } from "./owner-line-messages";
import { briefDay, LINK_CODE_DIGITS, LINK_CODE_TTL_MS, linkCodeAttempt } from "./owner-line-rules";
import {
  BASIC_ID,
  type BriefReply,
  type OwnerCard,
  type OwnerLineAccountRecord,
  type RedeemOutcome,
} from "./owner-line-store";
import { isLive, noShop, originOf, readAction, readShop, viewState, type PilotEnv } from "./pilot";
import type { InboundMessage, PilotReplyRecord, PilotShopRecord } from "./pilot-store";
import type { ActionProposalJSON } from "./task-object";
import { authCall, credStub, tenantCall } from "./tenant-data";

/// The credential vault that holds Manut AI's own account. Shops are
/// `pilot:<uuid>` and sessions `apple:<subject>`, so no tenant can ever be it.
export const OWNER_LINE_VAULT = "manut:owner-line";
/// Manut AI's webhook: one account, so one fixed path, which stays the same
/// when the account's token or secret is replaced.
export const OWNER_LINE_WEBHOOK = "/v1/inbound/owner-line";
const ADMIN_BASE = "/v1/admin/pilot/owner-line";
const MAX_BODY_BYTES = 256 * 1024;
/// Codes are hashed under the approval links' secret, in a domain of their own,
/// so a copy of storage reveals no code without the secret, and a code's hash
/// can never pass for any link's MAC.
const CODE_DOMAIN = "manut-ai/owner-link-code/v1.";
const MIN_SECRET_LENGTH = 32;
const UNKNOWN_CUSTOMER = "a customer";

type OwnerFlags = () => Promise<Pick<FeatureFlags, "ownerLine">>;

/// What the console sees of Manut AI's account: never a secret.
export type OwnerLineAccount = {
  channelId: string;
  botUserId: string;
  basicId?: string;
  webhookUrl: string;
  connectedAt: string;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bounded(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function disabled(): Response {
  return json({ error: "feature_disabled", feature: "ownerLine" }, 403);
}

function usableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

/// Entry point from the Worker, after the ingress rate gate and the admin
/// gate. Answers null for any path that is not one of these.
export async function ownerLineRoute(
  request: Request,
  url: URL,
  env: PilotEnv,
  ctx: ExecutionContext,
  flags: OwnerFlags,
): Promise<Response | null> {
  if (url.pathname === OWNER_LINE_WEBHOOK && request.method === "POST") return receiveWebhook(request, env, ctx, flags);
  if (url.pathname === ADMIN_BASE || url.pathname.startsWith(`${ADMIN_BASE}/`)) return operatorRoute(request, url, env, flags);
  return null;
}

// ---------------------------------------------------------------------------
// Manut AI's account
// ---------------------------------------------------------------------------

async function readAccount(env: PilotEnv): Promise<OwnerLineAccountRecord | null> {
  const response = await authCall(env, "/owner-line/account");
  if (!response.ok) throw new Error(`owner_line_account_${response.status}`);
  return ((await response.json()) as { account: OwnerLineAccountRecord | null }).account;
}

/// The account's two secrets, unsealed for one call, or null when the vault
/// cannot give them.
async function openAccount(env: PilotEnv, account: OwnerLineAccountRecord): Promise<LineCredentials | null> {
  try {
    return openLineCredentials(await readConnectionSecret(env, account.connectionId, OWNER_LINE_VAULT));
  } catch {
    return null;
  }
}

function publicAccount(env: PilotEnv, account: OwnerLineAccountRecord): OwnerLineAccount {
  const origin = originOf(env.PUBLIC_API_ORIGIN);
  return {
    channelId: account.channelId,
    botUserId: account.botUserId,
    ...(account.basicId ? { basicId: account.basicId } : {}),
    webhookUrl: origin ? `${origin}${OWNER_LINE_WEBHOOK}` : "",
    connectedAt: account.connectedAt,
  };
}

function revoke(env: PilotEnv, connectionId: string) {
  return credStub(env, OWNER_LINE_VAULT)
    .fetch(new Request(`https://cred/connections/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
      headers: { "x-tenant": OWNER_LINE_VAULT },
    }))
    .catch(() => undefined);
}

/// `POST /v1/admin/pilot/owner-line/account`: sets Manut AI's account. Both
/// secrets go straight into the vault, sealed together as a shop's are, and no
/// route answers either. The connection grants no actions, so no task can ever
/// name it for a dispatch: only this module unseals it, to message owners.
/// Setting a new account revokes the old connection, wiping its secrets, so a
/// rotated token or secret leaves nothing usable behind. It works with the flag
/// off, so the account can be ready before owner messages are turned on.
async function setAccount(env: PilotEnv, body: Record<string, unknown>): Promise<Response> {
  const { channelId, botUserId, channelSecret, channelAccessToken, basicId } = body;
  if (!bounded(channelId, 64) || typeof botUserId !== "string" || !LINE_USER_ID.test(botUserId) ||
      !bounded(channelSecret, 256) || !bounded(channelAccessToken, 4096) ||
      (basicId !== undefined && (typeof basicId !== "string" || !BASIC_ID.test(basicId)))) {
    return json({ error: "invalid_request" }, 400);
  }
  if (!originOf(env.PUBLIC_API_ORIGIN)) return json({ error: "not_configured", setting: "PUBLIC_API_ORIGIN" }, 503);
  const stored = await credStub(env, OWNER_LINE_VAULT).fetch(new Request("https://cred/connections", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tenant": OWNER_LINE_VAULT },
    body: JSON.stringify({
      tenant: OWNER_LINE_VAULT,
      provider: "line",
      accountId: channelId,
      scopes: [],
      refreshToken: sealableLineCredentials({ channelAccessToken, channelSecret }),
      resourceIds: [botUserId],
      allowsActions: false,
    }),
  })).catch(() => null);
  if (!stored?.ok) return json({ error: "vault_unavailable" }, 503);
  const { id: connectionId } = (await stored.json()) as { id: string };
  const written = await authCall(env, "/owner-line/account", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ connectionId, channelId, botUserId, ...(typeof basicId === "string" ? { basicId } : {}) }),
  }).catch(() => null);
  if (!written?.ok) {
    await revoke(env, connectionId);
    return json({ error: "account_unavailable" }, 503);
  }
  const { account, previous } = (await written.json()) as { account: OwnerLineAccountRecord; previous: string | null };
  if (previous && previous !== connectionId) await revoke(env, previous);
  return json(publicAccount(env, account));
}

// ---------------------------------------------------------------------------
// Operator routes (behind the admin gate: Access audience, operator bearer,
// and an exact ADMIN_METHODS entry, all checked before this runs)
// ---------------------------------------------------------------------------

async function operatorRoute(request: Request, url: URL, env: PilotEnv, flags: OwnerFlags): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (route === `GET ${ADMIN_BASE}`) {
    const account = await readAccount(env).catch(() => undefined);
    if (account === undefined) return json({ error: "account_unavailable" }, 503);
    return json({ enabled: (await flags()).ownerLine, account: account ? publicAccount(env, account) : null });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const body = parsed.value;
  if (route === `POST ${ADMIN_BASE}/account`) return setAccount(env, body);
  // Every other route names an existing pilot shop.
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  const shop = await readShop(env, body.tenant);
  if (!shop) return noShop(env, body.tenant);
  if (route === `POST ${ADMIN_BASE}/link-codes`) return issueLinkCode(env, shop, flags);
  if (route === `POST ${ADMIN_BASE}/unlink`) return unlinkOwner(env, shop);
  if (route === `POST ${ADMIN_BASE}/cards`) return retryCard(env, shop, body, flags);
  return json({ error: "not_found" }, 404);
}

/// A uniformly random code of LINK_CODE_DIGITS digits: draws past the largest
/// multiple of 10^8 below 2^32 are thrown away, so no code is likelier than
/// another.
function randomCode(): string {
  const span = 10 ** LINK_CODE_DIGITS;
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word); while (word[0]! >= limit);
  return String(word[0]! % span).padStart(LINK_CODE_DIGITS, "0");
}

/// The keyed hash a code is kept under: HMAC-SHA256 under the approval links'
/// secret, in its own domain, as hex.
async function hashCode(secret: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(CODE_DOMAIN + code)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// `POST /v1/admin/pilot/owner-line/link-codes`: a new code for the shop's
/// owner, answered once and kept only as its hash. It retires the shop's
/// previous code. It needs the flag on and the account set, since without
/// them the owner's message would get no answer.
async function issueLinkCode(env: PilotEnv, shop: PilotShopRecord, flags: OwnerFlags): Promise<Response> {
  if (!(await flags()).ownerLine) return disabled();
  const account = await readAccount(env).catch(() => undefined);
  if (account === undefined) return json({ error: "account_unavailable" }, 503);
  if (!account) return json({ error: "account_not_set" }, 409);
  const secret = env.APPROVAL_LINK_SECRET;
  if (!usableSecret(secret)) return json({ error: "not_configured", setting: "APPROVAL_LINK_SECRET" }, 503);
  // Two live codes alike are about one chance in a hundred million; a clash is answered 409 and a new code drawn.
  for (let draw = 0; draw < 3; draw++) {
    const code = randomCode();
    const expiresAtMs = Date.now() + LINK_CODE_TTL_MS;
    const issued = await authCall(env, "/owner-line/codes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify({ tenant: shop.tenant, codeHash: await hashCode(secret, code), expiresAtMs }),
    }).catch(() => null);
    if (issued?.status === 409) continue;
    if (!issued?.ok) break;
    return json({ code, expiresAt: new Date(expiresAtMs).toISOString() });
  }
  return json({ error: "code_unavailable" }, 503);
}

/// `POST /v1/admin/pilot/owner-line/unlink`: the owner gets no more cards or
/// briefs until linked again. The shop's live code goes first, so no code
/// issued before this can link the owner back. It works with the flag off.
async function unlinkOwner(env: PilotEnv, shop: PilotShopRecord): Promise<Response> {
  const forgot = await authCall(env, "/owner-line/codes/forget", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ tenant: shop.tenant }),
  }).catch(() => null);
  if (!forgot?.ok) return json({ error: "unlink_unavailable" }, 503);
  const unlinked = await tenantCall(env, shop.tenant, "/pilot-owner/unlink", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant: shop.tenant }),
  }).catch(() => null);
  if (!unlinked?.ok) return json({ error: "unlink_unavailable" }, 503);
  return json((await unlinked.json()) as { unlinked: boolean });
}

// ---------------------------------------------------------------------------
// Manut AI's webhook: link codes
// ---------------------------------------------------------------------------

/// `POST /v1/inbound/owner-line`. Public, because LINE holds no session: the
/// channel secret's signature is the credential. The same order as a shop's
/// webhook: a closed flag or an unset account answers an empty 404 before
/// anything is read, the signature is checked before a byte of the body is
/// parsed, and only then are codes looked at. Every correctly signed delivery
/// answers 200 with no body. A message that is not a code (`linkCodeAttempt`)
/// is neither kept nor answered. A code is answered through its reply token
/// once LINE has its 200; storage that cannot be reached answers 503, so LINE's
/// redelivery can try again, and a code its owner already used links them again.
async function receiveWebhook(request: Request, env: PilotEnv, ctx: ExecutionContext, flags: OwnerFlags): Promise<Response> {
  if (!(await flags()).ownerLine) return empty(404);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return empty(413);
  const account = await readAccount(env).catch(() => undefined);
  if (account === undefined) return empty(503);
  if (!account) return empty(404);
  // A request with no plausible signature costs no unseal.
  const signature = request.headers.get("x-line-signature");
  if (!hasLineSignatureShape(signature)) return empty(401);
  const credentials = await openAccount(env, account);
  if (!credentials) return empty(503);
  const body = await readBodyBytes(request, MAX_BODY_BYTES);
  if (!body.ok) return empty(body.status);
  if (!(await verifyLineSignature(credentials.channelSecret, body.value, signature))) return empty(401);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body.value));
  } catch {
    return empty(200);
  }
  const answers: { replyToken: string; message: TextMessage }[] = [];
  for (const event of lineTextEventsWithReply(payload, account.botUserId)) {
    const code = linkCodeAttempt(event.text);
    if (!code) continue;
    let answer: TextMessage;
    try {
      answer = await redeem(env, code, event.lineUserId);
    } catch {
      return empty(503);
    }
    if (event.replyToken) answers.push({ replyToken: event.replyToken, message: answer });
  }
  if (answers.length > 0) {
    ctx.waitUntil(Promise.all(answers.map(({ replyToken, message }) =>
      replyLineMessages(fetch, credentials.channelAccessToken, { replyToken, messages: [message] }))).catch(() => undefined));
  }
  return empty(200);
}

/// Checks one code under the guess limit and, when it is a live one, puts the
/// sender on the code's shop. A shop deleted since its code was issued answers
/// as a wrong code does.
async function redeem(env: PilotEnv, code: string, lineUserId: string): Promise<TextMessage> {
  const secret = env.APPROVAL_LINK_SECRET;
  // Without the secret no code could have been issued.
  if (!usableSecret(secret)) return codeAnswers.wrong;
  const checked = await authCall(env, "/owner-line/redeem", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ codeHash: await hashCode(secret, code), lineUserId }),
  });
  if (!checked.ok) throw new Error(`owner_line_redeem_${checked.status}`);
  const result = (await checked.json()) as RedeemOutcome;
  if (result.outcome === "limited") return codeAnswers.limited;
  if (result.outcome !== "linked") return codeAnswers.wrong;
  const linked = await tenantCall(env, result.tenant, "/pilot-owner/link", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant: result.tenant, lineUserId }),
  });
  if (linked.status === 404) return codeAnswers.wrong;
  if (!linked.ok) throw new Error(`owner_line_link_${linked.status}`);
  return codeAnswers.linked(((await linked.json()) as { shopName: string }).shopName);
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

/// The signed approval page for one reply, minted exactly as the proposal and
/// the console mint it (deterministic, at the reply's own expiry), or null when
/// WEB_ORIGIN or the link secret is missing.
async function approvalUrlOf(env: PilotEnv, tenant: string, taskId: string, actionId: string, expiresAt: string) {
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin) return null;
  const token = await mintApprovalToken(env.APPROVAL_LINK_SECRET, { tenant, taskId, actionId,
    expiresAtMs: Date.parse(expiresAt) }).catch(() => null);
  return token ? `${webOrigin}/approve/${token}` : null;
}

function tenantPost(env: PilotEnv, tenant: string, path: string, body: Record<string, unknown>) {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

type CardAttempt = { refused: { status: number; error: string } } | { card: OwnerCard };

/// Pushes the owner's card for one reply that still waits for them, at most
/// once per claim. The first push follows the proposal; only the operator's
/// retry (`retry`) pushes one that failed, is unknown, or was cut off. Every
/// push for one reply carries the same retry key, so LINE shows the card once
/// however many pushes reach it. Once claimed, every way out records what
/// became of the push on the reply.
async function pushCard(env: PilotEnv, shop: PilotShopRecord, actionId: string, retry: boolean): Promise<CardAttempt> {
  const owner = shop.ownerLineUserId;
  if (!owner) return { refused: { status: 409, error: "owner_not_linked" } };
  const tenant = shop.tenant;
  const contextResponse = await tenantCall(env, tenant,
    `/pilot/context?tenant=${encodeURIComponent(tenant)}&actionId=${encodeURIComponent(actionId)}`);
  if (!contextResponse.ok) return { refused: { status: 503, error: "card_unavailable" } };
  const context = (await contextResponse.json()) as { reply: PilotReplyRecord | null; message: InboundMessage | null };
  if (!context.reply) return { refused: { status: 404, error: "reply_not_found" } };
  const action = await readAction(env, tenant, context.reply.taskId, actionId);
  if (!action) return { refused: { status: 404, error: "reply_not_found" } };
  // A card is only ever for a reply the owner can still decide.
  if (viewState(action, Date.now()) !== "proposed") return { refused: { status: 409, error: "reply_not_waiting" } };

  const claim = await tenantPost(env, tenant, "/pilot-owner/card-claim", { actionId, retry });
  if (!claim.ok) return { refused: { status: 503, error: "card_unavailable" } };
  const claimed = (await claim.json()) as { claimed: boolean; card: OwnerCard };
  if (!claimed.claimed) {
    if (retry && claimed.card.state === "sending") return { refused: { status: 409, error: "card_sending" } };
    return { card: claimed.card };
  }
  // A card whose outcome cannot be recorded stays `sending`, and a retry may claim it once its claim lapses.
  const settle = async (state: "sent" | "failed" | "unknown", reason?: string): Promise<CardAttempt> => {
    try {
      const settled = await tenantPost(env, tenant, "/pilot-owner/card-settle", { actionId, state,
        ...(reason ? { reason } : {}) });
      if (settled.ok) return { card: ((await settled.json()) as { card: OwnerCard }).card };
    } catch {
      // Answered below.
    }
    return { refused: { status: 503, error: "card_unavailable" } };
  };
  let prepared: { token: string; card: Record<string, unknown>; retryKey: string };
  try {
    const account = await readAccount(env);
    if (!account) return await settle("failed", "account_not_set");
    const credentials = await openAccount(env, account);
    if (!credentials) return await settle("failed", "vault_unavailable");
    const approvalUrl = await approvalUrlOf(env, tenant, context.reply.taskId, actionId, action.expiresAt);
    if (!approvalUrl) return await settle("failed", "not_configured");
    prepared = {
      token: credentials.channelAccessToken,
      card: ownerCardMessage({
        shopName: shop.name,
        customerName: context.message?.displayName ?? UNKNOWN_CUSTOMER,
        customerMessage: context.message?.text ?? "",
        replyText: lineReplyText(action.payload) ?? "",
        approvalUrl,
      }),
      retryKey: await lineRetryKey("owner-card", tenant, actionId),
    };
  } catch {
    // Nothing reached LINE.
    return settle("failed", "card_unavailable");
  }
  // The push never throws: LINE's answer, or its absence, is its outcome.
  const pushed = await pushLineMessages(fetch, prepared.token, { to: owner, messages: [prepared.card],
    retryKey: prepared.retryKey });
  return pushed.outcome === "confirmed" ? settle("sent") : settle(pushed.outcome, pushed.reason);
}

/// Listens for a proposed reply (pilot.ts's `replyProposed`), after the
/// proposal has answered. Nothing here can delay or fail the proposal: with
/// the flag off or no owner linked it does nothing, and any failure is the
/// card's, recorded on the reply for the console.
export async function ownerCardOnProposal(env: PilotEnv, flags: OwnerFlags, tenant: string, actionId: string): Promise<void> {
  try {
    if (!(await flags()).ownerLine) return;
    const shop = await readShop(env, tenant);
    if (!shop?.ownerLineUserId) return;
    await pushCard(env, shop, actionId, false);
  } catch {
    // The proposal has already answered; the reply shows no card, and the operator can retry it.
  }
}

/// `POST /v1/admin/pilot/owner-line/cards`: the operator's retry of one
/// reply's card. Refused, pushing nothing, while the flag is off, when the
/// owner is not linked, or when the reply no longer waits; a card already sent
/// is answered as it stands, and one being pushed right now answers 409.
async function retryCard(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>, flags: OwnerFlags) {
  if (!(await flags()).ownerLine) return disabled();
  if (!bounded(body.actionId)) return json({ error: "invalid_request" }, 400);
  const attempt = await pushCard(env, shop, body.actionId, true);
  if ("refused" in attempt) return json({ error: attempt.refused.error }, attempt.refused.status);
  return json({ ownerCard: attempt.card });
}

// ---------------------------------------------------------------------------
// The morning brief
// ---------------------------------------------------------------------------

export type BriefRun = { date: string; sent: number; skipped: number; failed: number; unknown: number };

/// Yesterday's counts for one shop, the replies waiting now, and the page of
/// the one waiting longest. Fails rather than guesses when a record cannot be
/// read: a brief claimed but not sent is claimed again by the next run.
async function gatherBrief(env: PilotEnv, shop: PilotShopRecord, day: { fromMs: number; toMs: number }, nowMs: number) {
  const tenant = shop.tenant;
  const response = await tenantCall(env, tenant, `/pilot-owner/brief-counts?tenant=${encodeURIComponent(tenant)}` +
    `&from=${day.fromMs}&to=${day.toMs}`);
  if (!response.ok) throw new Error(`brief_counts_${response.status}`);
  const listed = (await response.json()) as { messages: number; payments: number; replies: BriefReply[] };
  let repliesSent = 0;
  const waiting: { reply: BriefReply; action: ActionProposalJSON }[] = [];
  for (const reply of listed.replies) {
    const action = await readAction(env, tenant, reply.taskId, reply.actionId);
    if (!action) continue;
    const began = Date.parse(action.dispatch?.at ?? "");
    if (action.state === "confirmed" && began >= day.fromMs && began < day.toMs) repliesSent++;
    if (viewState(action, nowMs) === "proposed") waiting.push({ reply, action });
  }
  waiting.sort((a, b) => Date.parse(a.reply.proposedAt) - Date.parse(b.reply.proposedAt));
  const oldest = waiting[0];
  const counts: BriefCounts = { messages: listed.messages, repliesSent, repliesWaiting: waiting.length,
    payments: listed.payments };
  const waitingUrl = oldest
    ? await approvalUrlOf(env, tenant, oldest.reply.taskId, oldest.reply.actionId, oldest.action.expiresAt)
    : null;
  return { counts, waitingUrl };
}

/// One shop's brief for `day`, or null when the shop gets none: no owner
/// linked, not live, or already claimed for the day.
async function briefShop(
  env: PilotEnv,
  credentials: LineCredentials,
  tenant: string,
  day: { date: string; fromMs: number; toMs: number },
  nowMs: number,
): Promise<"sent" | "skipped" | "failed" | "unknown" | null> {
  const shop = await readShop(env, tenant);
  if (!shop?.ownerLineUserId) return null;
  // Only a live shop's owner hears from its shop: a shop being set up has nothing to tell.
  if ((await isLive(env, shop)) !== true) return null;
  const claim = await tenantPost(env, tenant, "/pilot-owner/brief-claim", { date: day.date });
  if (!claim.ok || !((await claim.json()) as { claimed: boolean }).claimed) return null;
  const { counts, waitingUrl } = await gatherBrief(env, shop, day, nowMs);
  const settle = async (state: "sent" | "skipped" | "failed" | "unknown", reason?: string) => {
    await tenantPost(env, tenant, "/pilot-owner/brief-settle", { date: day.date, state, counts, ...(reason ? { reason } : {}) });
    return state;
  };
  const message = morningBriefMessage({ shopName: shop.name, counts, waitingUrl });
  // A day with nothing to say sends nothing (docs/pilot-api.md says why); the record says it was skipped.
  if (!message) return settle("skipped");
  const pushed = await pushLineMessages(fetch, credentials.channelAccessToken, {
    to: shop.ownerLineUserId,
    messages: [message],
    retryKey: await lineRetryKey("owner-brief", tenant, day.date),
  });
  return pushed.outcome === "confirmed" ? settle("sent") : settle(pushed.outcome, pushed.reason);
}

/// The morning brief for every linked owner of a live shop, from the Worker's
/// cron trigger (index.ts): at 08:00 Bangkok time, and again at 08:30 to
/// retry what the first run could not finish. `scheduledMs` picks the day:
/// the brief's date is its Bangkok date, and its counts cover the Bangkok day
/// before. Each shop's brief is claimed for the date before anything is sent
/// and carries a retry key made from the shop and the date, so a shop gets at
/// most one brief a day across runs, retries and LINE's own deduplication.
/// With the flag off, or no account set, it sends nothing and writes nothing.
/// Shops are briefed one after another; one shop's failure is left for the
/// next run and never stops the rest.
export async function runMorningBriefs(env: PilotEnv, flags: OwnerFlags, scheduledMs: number, nowMs = Date.now()): Promise<BriefRun> {
  const day = briefDay(scheduledMs);
  const run: BriefRun = { date: day.date, sent: 0, skipped: 0, failed: 0, unknown: 0 };
  if (!(await flags()).ownerLine) return run;
  const account = await readAccount(env).catch(() => null);
  if (!account) return run;
  const credentials = await openAccount(env, account);
  if (!credentials) return run;
  const registry = await authCall(env, "/pilot-shops").catch(() => null);
  if (!registry?.ok) return run;
  const { tenants } = (await registry.json()) as { tenants: string[] };
  for (const tenant of tenants) {
    const outcome = await briefShop(env, credentials, tenant, day, nowMs).catch(() => null);
    if (outcome) run[outcome]++;
  }
  return run;
}

/// The owner-line records that stop mattering with time, dropped once a day by
/// the same cron run, flag on or off: expired codes and closed guess windows.
export async function pruneOwnerLine(env: PilotEnv, nowMs: number): Promise<void> {
  await authCall(env, "/owner-line/prune", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ nowMs }),
  }).catch(() => undefined);
}
