/// The Manut AI pilot's routes (docs/pilot-api.md): the LINE webhook, the
/// owner's signed approval and deletion links, and the operator console under
/// `/v1/admin/pilot/*`. In the pilot people play the shop's AI team: an
/// operator reads a customer's LINE message, drafts a reply, and the shop
/// owner approves or declines that one exact reply through a link.
///
/// Nothing here adds a way around the lifted backend's guarantees. A reply is
/// an ordinary exact-action proposal on the shop's task, stored with the
/// approval-core request that alone decides it (a `reply`, naming the draft
/// and its one recipient), decided once through that request in the task
/// object, dispatched at most once by the broker's begin gate, checked
/// against the live connection grant before any LINE traffic, and settled
/// confirmed, failed or unknown. The link adds only who decides: whoever
/// holds a link this backend signed for that one action, before it expires,
/// is the owner. Approving still needs the shop's cloud-work consent, which
/// only the owner can record, through the link or their own shop session, and
/// the same kill switches as the session routes.
///
/// Deleting a live shop's data is the same shape: the operator's request opens
/// one owner confirmation in approval-core's store (pilot-store.ts), the
/// owner's link names exactly that confirmation, and the wipe starts only once
/// the owner's yes is settled there.

import type { ApprovalRecord, DecideResult } from "@manut/approval-core";
import {
  APPROVAL_LINK_TTL_MS,
  checkApprovalToken,
  checkDeletionToken,
  mintApprovalToken,
  mintDeletionToken,
  type ApprovalClaim,
  type DeletionClaim,
} from "./approval-link";
import { appendAudit, countAuditMiss, type AuditActor } from "./audit-log";
import { readBodyBytes, readJsonBody } from "./body";
import { beginDispatchAction, finishDispatchAction } from "./broker-actions";
import { isValidTenant } from "./companies";
import {
  fetchLineDisplayName,
  hasLineSignatureShape,
  LINE_PUSH_OPERATION,
  LINE_TEXT_MAX,
  LINE_USER_ID,
  lineReplyText,
  lineTextEvents,
  openLineCredentials,
  sealableLineCredentials,
  verifyLineSignature,
} from "./connectors/line";
import { readConnectionSecret } from "./cred-broker";
import type { FeatureFlags } from "./index";
import type { OwnerAccount, PeopleView } from "./people-store";
import { pilotGate, type GateShopInput } from "./pilot-gate";
import {
  approvedDeletion,
  confirmationOpen,
  isDeletionDetail,
  type DecidedConfirmation,
  type DeletionDetail,
  type DeletionGoes,
  type InboundMessage,
  type OpenedConfirmation,
  type Payment,
  type PilotDeletionRecord,
  type PilotReplyRecord,
  type PilotShopRecord,
  type StoredDeletion,
  type SubscriptionPayment,
} from "./pilot-store";
import type { ShopTemplate } from "@manut/shop-templates";
import { checkedTemplate, newShopSetup } from "./routine-setup";
import { beginMake, twice } from "./shops-store";
import { REPLY_REVISION, type ActionProposalJSON } from "./task-object";
import type { GoogleEnv } from "./google";
import { authCall, credStub, tenantCall, tenantDelete, tenantExport, type TenantDataEnv } from "./tenant-data";

export type PilotEnv = TenantDataEnv & GoogleEnv & {
  /// Where the owner's approval page lives: `approvalUrl` is
  /// `${WEB_ORIGIN}/approve/{token}`, and only this origin may call the
  /// approval routes from a browser.
  WEB_ORIGIN?: string;
  /// This Worker's public origin, for the `webhookUrl` an operator pastes into
  /// the LINE Developers Console.
  PUBLIC_API_ORIGIN?: string;
  /// Signs approval links (`wrangler secret put APPROVAL_LINK_SECRET`).
  /// Without it no link is minted and every link is invalid.
  APPROVAL_LINK_SECRET?: string;
};

type Flags = () => Promise<Pick<FeatureFlags, "officeCloud" | "officeExternalWrites" | "officeInbound">>;

const MAX_BODY_BYTES = 256 * 1024;
/// The pilot's single AI team member, as the owner's page presents it.
const MEMBER_NAME = "Nam";
const MEMBER_ROLE = "sales chat";
const UNKNOWN_CUSTOMER = "a customer";
/// Vault ids are `crypto.randomUUID()`. Anything else in the webhook path is
/// not a connection and is answered before any object wakes.
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/// A reply still open: answering the same message again would put two
/// replies in front of the owner at once.
const OPEN_STATES = new Set(["proposed", "approved", "dispatching"]);

type ViewState = ActionProposalJSON["state"];

export type ApprovalView = {
  shopName: string;
  memberName: string;
  memberRole: string;
  kind: "line.reply";
  customerName: string;
  customerMessage: string;
  replyText: string;
  state: ViewState;
  decidedAt?: string;
  /// The name the owner gave the helper who approved or declined this reply, when a helper did (docs/people.md). The
  /// owner's own decisions, from this link, the shop's session or a linked account, carry no name: this is the owner's
  /// page.
  decidedByHelper?: string;
  expiresAt: string;
  needsConsent: boolean;
};

/// Where an owner confirmation of a shop's deletion stands:
/// - `awaiting_owner`: open, and nothing is deleted;
/// - `deleting`: the owner said yes and the wipe has not finished (running,
///   or stopped part way until the operator's same request finishes it);
/// - `deleted`: the shop's data is deleted (the wipe's last step, taking the
///   shop off the console's list, may still be left for that same request);
/// - `declined`: the owner kept the data, and nothing was deleted;
/// - `expired`: nobody answered in time, and nothing was deleted.
export type DeletionState = "awaiting_owner" | "deleting" | "deleted" | "declined" | "expired";

/// What the owner's deletion page shows. `goes` is counted afresh while the
/// shop's data is there, and once it is gone, is what the shop held when the
/// operator asked.
export type DeletionView = {
  shopName: string;
  goes: DeletionGoes;
  state: DeletionState;
  expiresAt: string;
  decidedAt?: string;
};

/// A shop's latest deletion request as the console's shop list shows it. The
/// link is re-minted on each read at the same expiry, like a reply's.
export type DeletionRequest = {
  state: DeletionState;
  confirmUrl: string;
  expiresAt: string;
  decidedAt?: string;
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

/// A configured origin, normalized, or null when unset or not a URL. Routes
/// that need one refuse up front rather than hand out a broken link.
function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/// A proposal still waiting for its decision past its own deadline has
/// expired, whether or not anything has touched it since: the task object
/// marks expiry lazily, when a decision or dispatch finds it.
function viewState(action: ActionProposalJSON, nowMs: number): ViewState {
  if (action.state === "proposed" && Date.parse(action.expiresAt) <= nowMs) return "expired";
  return action.state;
}

async function readAction(env: PilotEnv, tenant: string, taskId: string, actionId: string): Promise<ActionProposalJSON | null> {
  const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(
    new Request(`https://task/actions/${encodeURIComponent(actionId)}`, { headers: { "x-tenant": tenant } }),
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`action_read_${response.status}`);
  return (await response.json()) as ActionProposalJSON;
}

type SettledBy = { decidedBy: string; role: string; decidedAt: number };

/// Who settled a reply's request, and when, as approval-core recorded it (a reply's request shares its action's id).
/// Null while it is open, when it ran out with nobody deciding, or when it cannot be read: the page then says only when
/// the reply was answered, as it did before helpers could decide, so this read never stops the page from loading.
async function settledBy(env: PilotEnv, claim: ApprovalClaim): Promise<SettledBy | null> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(claim.taskId)).fetch(
      new Request(`https://task/requests/${encodeURIComponent(claim.actionId)}`, { headers: { "x-tenant": claim.tenant } }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const record = ((await response.json()) as { record?: ApprovalRecord }).record;
    if (record?.status !== "decided") return null;
    const { decidedBy, role, decidedAt } = record.decision;
    return typeof decidedBy === "string" && typeof role === "string" && typeof decidedAt === "number"
      ? { decidedBy, role, decidedAt }
      : null;
  } catch {
    return null;
  }
}

/// The name the owner gave a helper, from the shop's people record (people-store.ts), which keeps the names of removed
/// helpers too, so what a helper decided stays theirs after they leave. Read directly rather than through people.ts,
/// which imports this module. Undefined when there is no such name or the record cannot be read.
async function helperName(env: PilotEnv, tenant: string, helperId: string): Promise<string | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/people?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const names = ((await response.json()) as { names?: Record<string, unknown> }).names;
    const name = names && Object.hasOwn(names, helperId) ? names[helperId] : undefined;
    return typeof name === "string" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

async function shopConsent(env: PilotEnv, tenant: string): Promise<boolean> {
  const response = await tenantCall(env, tenant, `/consent?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return false;
  const record = (await response.json().catch(() => null)) as { cloudWork?: unknown } | null;
  return record?.cloudWork === true;
}

async function readShop(env: PilotEnv, tenant: string): Promise<PilotShopRecord | null> {
  const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return null;
  return ((await response.json()) as { shop: PilotShopRecord }).shop;
}

function pilotWrite(env: PilotEnv, tenant: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

/// Entry point from the Worker, after the ingress rate gate and the admin
/// gate. Answers null for any path that is not the pilot's.
export async function pilotRoute(
  request: Request,
  url: URL,
  env: PilotEnv,
  ctx: ExecutionContext,
  flags: Flags,
): Promise<Response | null> {
  const line = url.pathname.match(/^\/v1\/inbound\/line\/([^/]+)$/);
  if (line && request.method === "POST") return receiveLineWebhook(request, env, ctx, line[1] ?? "", flags);
  const approval = url.pathname.match(/^\/v1\/pilot\/approvals\/([^/]+)(?:\/(consent|decision))?$/);
  if (approval) return approvalRoute(request, env, ctx, approval[1] ?? "", approval[2], flags);
  const deletion = url.pathname.match(/^\/v1\/pilot\/deletions\/([^/]+)(?:\/(decision))?$/);
  if (deletion) return deletionLinkRoute(request, env, deletion[1] ?? "", deletion[2]);
  if (url.pathname.startsWith("/v1/admin/pilot/")) return operatorRoute(request, url, env, flags, ctx);
  return null;
}

// ---------------------------------------------------------------------------
// LINE webhook
// ---------------------------------------------------------------------------

/// `POST /v1/inbound/line/{connectionId}`. Public, because LINE holds no
/// session: the channel secret's signature is the credential. Answers carry
/// no body. Order matters: the connection is found first (its secret is what
/// the signature is checked against), the signature is checked before a byte
/// of the body is parsed, and nothing is stored unless both hold.
///
/// A closed `officeInbound` flag and a connection that does not exist, is
/// revoked or is not a LINE connection all answer the same empty 404, so the
/// route tells a caller nothing about which shops exist. Every correctly
/// signed delivery answers 200, whether it stored messages, only repeated
/// ones already stored, or held nothing the pilot keeps (LINE's empty
/// "verify" delivery among them). A storage failure answers 503 so that
/// LINE's webhook redelivery, when the operator has turned it on, can try
/// again; the event-id record makes that retry safe.
async function receiveLineWebhook(
  request: Request,
  env: PilotEnv,
  ctx: ExecutionContext,
  connectionId: string,
  flags: Flags,
): Promise<Response> {
  if (!(await flags()).officeInbound) return empty(404);
  if (!CONNECTION_ID.test(connectionId)) return empty(404);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return empty(413);

  // Which tenant vault holds the connection. Only the operator's
  // line-connections route writes these rows; the vault stays authoritative.
  const indexed = await authCall(env, `/inbound-routes?provider=line&account=${encodeURIComponent(connectionId)}`);
  if (!indexed.ok) return empty(503);
  const listed = (await indexed.json().catch(() => null)) as { routes?: { tenant?: unknown; connectionId?: unknown }[] } | null;
  const route = (listed?.routes ?? []).find((entry) => entry.connectionId === connectionId && bounded(entry.tenant));
  if (!route || !bounded(route.tenant)) return empty(404);
  const tenant = route.tenant;
  const metaResponse = await credStub(env, tenant).fetch(
    new Request(`https://cred/connections/${connectionId}`, { headers: { "x-tenant": tenant } }),
  );
  if (metaResponse.status === 404) return empty(404);
  if (!metaResponse.ok) return empty(503);
  const meta = (await metaResponse.json().catch(() => null)) as { provider?: unknown; resourceIds?: unknown } | null;
  const botUserId = Array.isArray(meta?.resourceIds) ? meta.resourceIds[0] : undefined;
  if (meta?.provider !== "line" || typeof botUserId !== "string" || !LINE_USER_ID.test(botUserId)) return empty(404);

  // A request with no plausible signature costs no unseal.
  const signature = request.headers.get("x-line-signature");
  if (!hasLineSignatureShape(signature)) return empty(401);
  let credentials;
  try {
    credentials = openLineCredentials(await readConnectionSecret(env, connectionId, tenant));
  } catch {
    return empty(503);
  }
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
  const events = lineTextEvents(payload, botUserId);
  if (events.length === 0) return empty(200);
  const stored = await pilotWrite(env, tenant, "/pilot/messages", { connectionId, events });
  if (!stored.ok) return empty(503);
  const result = (await stored.json().catch(() => null)) as { created?: { lineUserId: string; named: boolean }[] } | null;
  // Display names are a courtesy for the owner's page ("a customer"
  // otherwise), so the lookup runs after LINE has its answer and never
  // delays or fails the delivery.
  const unnamed = [...new Set((result?.created ?? []).filter((entry) => !entry.named).map((entry) => entry.lineUserId))];
  if (unnamed.length > 0) {
    ctx.waitUntil(fillDisplayNames(env, tenant, credentials.channelAccessToken, unnamed.slice(0, 10)).catch(() => undefined));
  }
  return empty(200);
}

async function fillDisplayNames(env: PilotEnv, tenant: string, channelAccessToken: string, lineUserIds: string[]) {
  for (const lineUserId of lineUserIds) {
    const displayName = await fetchLineDisplayName(fetch, channelAccessToken, lineUserId);
    if (displayName) await pilotWrite(env, tenant, "/pilot/names", { lineUserId, displayName });
  }
}

// ---------------------------------------------------------------------------
// Owner's approval link
// ---------------------------------------------------------------------------

/// The page at WEB_ORIGIN calls these routes from the owner's browser, so
/// they answer CORS for that one origin and no other. CORS grants nothing
/// the link does not: it only lets that page read the answers. Every answer
/// carries `cache-control: no-store`, because it holds the customer's words
/// and sits behind a capability URL.
function linkResponse(response: Response, request: Request, env: PilotEnv): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.append("vary", "origin");
  const allowed = originOf(env.WEB_ORIGIN);
  if (allowed && request.headers.get("origin") === allowed) headers.set("access-control-allow-origin", allowed);
  return new Response(response.body, { status: response.status, headers });
}

function linkPreflight(request: Request, env: PilotEnv): Response {
  const preflight = empty(204);
  preflight.headers.set("access-control-allow-methods", "GET, POST");
  preflight.headers.set("access-control-allow-headers", "content-type");
  preflight.headers.set("access-control-max-age", "600");
  return linkResponse(preflight, request, env);
}

async function approvalRoute(
  request: Request,
  env: PilotEnv,
  ctx: ExecutionContext,
  token: string,
  leaf: string | undefined,
  flags: Flags,
): Promise<Response> {
  if (request.method === "OPTIONS") return linkPreflight(request, env);
  const answer = await (async (): Promise<Response> => {
    const checked = await checkApprovalToken(env.APPROVAL_LINK_SECRET, token, Date.now());
    if (!checked.ok) return json({ error: checked.error }, checked.error === "link_expired" ? 410 : 404);
    const claim = checked.claim;
    if (!leaf && request.method === "GET") {
      const loaded = await loadView(env, claim);
      if (!loaded) return json({ error: "link_invalid" }, 404);
      // An approval whose send never began (the begin gate was unreachable
      // just after the decision was recorded) would otherwise sit at
      // "approved" for ever, with the owner's page polling it. The owner has
      // already said yes, so reading the link starts the send they approved.
      // The begin gate is one-use, so however many reads arrive, at most one
      // send begins; the same switches and consent are checked again first.
      if (loaded.action.state === "approved" && !loaded.view.needsConsent) {
        const current = await flags();
        if (current.officeCloud && current.officeExternalWrites) {
          await startSend(env, ctx, claim, loaded.action);
          const after = await loadView(env, claim);
          if (after) return json(after.view);
        }
      }
      return json(loaded.view);
    }
    if (leaf === "consent" && request.method === "POST") return recordOwnerConsent(request, env, claim);
    if (leaf === "decision" && request.method === "POST") return decideByLink(request, env, ctx, claim, flags);
    return json({ error: "not_found" }, 404);
  })().catch(() => json({ error: "unavailable" }, 503));
  return linkResponse(answer, request, env);
}

/// Reads everything the owner's page shows. Null when the action or its
/// reply record is gone, which the link reports as invalid: the tenant was
/// deleted, or the link names something this backend never proposed.
async function loadView(env: PilotEnv, claim: ApprovalClaim): Promise<{ view: ApprovalView; action: ActionProposalJSON } | null> {
  const [action, contextResponse, consent, settled] = await Promise.all([
    readAction(env, claim.tenant, claim.taskId, claim.actionId),
    tenantCall(env, claim.tenant, `/pilot/context?tenant=${encodeURIComponent(claim.tenant)}&actionId=${encodeURIComponent(claim.actionId)}`),
    shopConsent(env, claim.tenant),
    settledBy(env, claim),
  ]);
  if (!action || !contextResponse.ok) return null;
  const context = (await contextResponse.json()) as {
    shop: PilotShopRecord | null;
    reply: PilotReplyRecord | null;
    message: InboundMessage | null;
  };
  if (!context.shop || !context.reply || context.reply.taskId !== claim.taskId) return null;
  // A reply decided from a session has no time on the pilot's reply record, and a declined one none on its action, so
  // the settled request's time is the last word.
  const decidedAt = context.reply.decidedAt ?? action.approval?.at
    ?? (settled ? new Date(settled.decidedAt).toISOString() : undefined);
  // approval-core's role is the server's, taken from the session that decided, so a name is shown only for a helper.
  const decidedByHelper = settled?.role === "helper" ? await helperName(env, claim.tenant, settled.decidedBy) : undefined;
  const view: ApprovalView = {
    shopName: context.shop.name,
    memberName: MEMBER_NAME,
    memberRole: MEMBER_ROLE,
    kind: "line.reply",
    customerName: context.message?.displayName ?? UNKNOWN_CUSTOMER,
    // A message past the retention window is gone; the reply still shows.
    customerMessage: context.message?.text ?? "",
    replyText: lineReplyText(action.payload) ?? "",
    state: viewState(action, Date.now()),
    ...(decidedAt ? { decidedAt } : {}),
    ...(decidedByHelper ? { decidedByHelper } : {}),
    expiresAt: new Date(claim.expiresAtMs).toISOString(),
    needsConsent: !consent,
  };
  return { view, action };
}

/// `POST /v1/pilot/approvals/{token}/consent`. One of the two ways a pilot
/// shop's consent is recorded, both the owner's: through a live link, or from
/// the owner's own shop session once their account is linked (shops.ts).
/// Operators have no route that writes it. The body must say
/// `{ "cloudWork": true }` exactly; withdrawing is not something this link
/// offers, and the owner's session does.
async function recordOwnerConsent(request: Request, env: PilotEnv, claim: ApprovalClaim): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || parsed.value.cloudWork !== true) return json({ error: "invalid_request" }, 400);
  if (!(await loadView(env, claim))) return json({ error: "link_invalid" }, 404);
  const recorded = await tenantCall(env, claim.tenant, "/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: claim.tenant, cloudWork: true }),
  });
  if (!recorded.ok) return json({ error: "consent_unavailable" }, 503);
  const loaded = await loadView(env, claim);
  return loaded ? json(loaded.view) : json({ error: "link_invalid" }, 404);
}

/// `POST /v1/pilot/approvals/{token}/decision`. The same gates as the session
/// decision and dispatch routes, in the same order: the officeCloud switch
/// for any decision; for an approval, the officeExternalWrites switch and the
/// shop's consent, all checked before anything is recorded, so a refusal
/// leaves the reply waiting. The task object then settles the decision once,
/// through the reply's approval-core request, as the owner (approval-core's
/// rules: settle once, before the reply's expiry, the one revision a reply
/// has, an option it offers), and moves the reply with it.
/// An approval goes straight on to the broker's begin gate (one-use,
/// re-checking freshness, grant revision and task state) and the provider
/// call runs after the answer, in waitUntil, exactly as the session dispatch
/// route runs it, re-checking connection health and grant before any LINE
/// traffic.
async function decideByLink(
  request: Request,
  env: PilotEnv,
  ctx: ExecutionContext,
  claim: ApprovalClaim,
  flags: Flags,
): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || typeof parsed.value.approve !== "boolean") return json({ error: "invalid_request" }, 400);
  const approve = parsed.value.approve;
  const current = await flags();
  if (!current.officeCloud) return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
  if (approve && !current.officeExternalWrites) {
    return json({ error: "feature_disabled", feature: "officeExternalWrites" }, 403);
  }
  const before = await loadView(env, claim);
  if (!before) return json({ error: "link_invalid" }, 404);
  if (before.action.state !== "proposed") return json({ error: "already_decided", view: before.view }, 409);
  if (approve && before.view.needsConsent) return json({ error: "consent_required" }, 403);

  // The reply's approval-core request decides it, and the task object moves the reply with it in one transaction.
  // Whoever holds the link is the owner, so the role is set here and never read from the request; a reply is never
  // revised, so the owner saw its one revision.
  const stub = env.TASK.get(env.TASK.idFromName(claim.taskId));
  const decided = await stub.fetch(
    new Request(`https://task/requests/${encodeURIComponent(claim.actionId)}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": claim.tenant },
      body: JSON.stringify({ optionId: approve ? "approve" : "decline", seenRevision: REPLY_REVISION,
        decidedBy: "owner-link", role: "owner" }),
    }),
  );
  if (decided.status === 404) return json({ error: "link_invalid" }, 404);
  if (decided.status === 409) return raced(env, claim);
  if (!decided.ok) return json({ error: "decision_unavailable" }, 503);
  const settled = (await decided.json()) as { result: DecideResult; action: ActionProposalJSON };
  if (!settled.result.ok) {
    // Lost a race with another decision on the same reply.
    if (settled.result.refused === "already_decided") return raced(env, claim);
    if (settled.result.refused === "expired") return json({ error: "link_expired" }, 410);
    // Withdrawn, not permitted, or an option or revision the link never showed: nothing this link can decide.
    return json({ error: "link_invalid" }, 404);
  }
  const action = settled.action;
  // The decision time and the audit log's entry for the owner's decision share one write. Neither may hold up the
  // decision the task object already settled, so a failed write is only counted as a miss in the log.
  const recorded = await pilotWrite(env, claim.tenant, "/pilot/reply-decided", {
    actionId: claim.actionId,
    decidedAt: action.approval?.at ?? new Date().toISOString(),
    approve,
  }).catch(() => null);
  if (!recorded?.ok) await countAuditMiss(env, claim.tenant, "reply.decided");

  if (approve) await startSend(env, ctx, claim, action);
  const after = await loadView(env, claim);
  return after ? json(after.view) : json({ error: "link_invalid" }, 404);
}

/// The answer to a decision that another one beat to the reply: the view as it now stands.
async function raced(env: PilotEnv, claim: ApprovalClaim): Promise<Response> {
  const loaded = await loadView(env, claim);
  return loaded ? json({ error: "already_decided", view: loaded.view }, 409) : json({ error: "link_invalid" }, 404);
}

/// Begins the send of an approved reply. The begin gate compares against the
/// revision the proposal was approved under; the broker's finish half then
/// compares that against the live connection's revision before any LINE
/// traffic, and settles failed on a mismatch. If begin refuses (the task was
/// settled meanwhile, the stored content no longer matches its hash, or the
/// send already began) nothing is sent by this call. A begin that could not
/// be reached leaves the reply approved, and the next read of the link tries
/// again.
async function startSend(env: PilotEnv, ctx: ExecutionContext, claim: ApprovalClaim, action: ActionProposalJSON): Promise<void> {
  const dispatch = { tenant: claim.tenant, grantRevision: action.grantRevision };
  const begun = await beginDispatchAction(env, claim.taskId, claim.actionId, dispatch).catch(() => null);
  if (begun?.ok) {
    ctx.waitUntil(
      finishDispatchAction(env, claim.taskId, claim.actionId, { ...dispatch, proposal: begun.proposal }).catch(
        () => undefined,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Owner's deletion link
// ---------------------------------------------------------------------------

/// `/v1/pilot/deletions/{token}`: the owner reads and answers one confirmation
/// of deleting their shop's data. The same rate limit, CORS and no-store as
/// the approval link; the token is a deletion token, which no reply link can
/// pass for (approval-link.ts).
async function deletionLinkRoute(
  request: Request,
  env: PilotEnv,
  token: string,
  leaf: string | undefined,
): Promise<Response> {
  if (request.method === "OPTIONS") return linkPreflight(request, env);
  const answer = await (async (): Promise<Response> => {
    const checked = await checkDeletionToken(env.APPROVAL_LINK_SECRET, token, Date.now());
    if (!checked.ok) return json({ error: checked.error }, checked.error === "link_expired" ? 410 : 404);
    if (!leaf && request.method === "GET") {
      const loaded = await loadDeletion(env, checked.claim);
      return loaded ? json(await deletionView(env, loaded)) : json({ error: "link_invalid" }, 404);
    }
    if (leaf === "decision" && request.method === "POST") return decideDeletionByLink(request, env, checked.claim);
    return json({ error: "not_found" }, 404);
  })().catch(() => json({ error: "unavailable" }, 503));
  return linkResponse(answer, request, env);
}

type LoadedDeletion = { deletion: PilotDeletionRecord | null; confirmation: ApprovalRecord; detail: DeletionDetail };

/// The confirmation a deletion link names, with the shop's deletion record.
/// Null when this backend holds no such confirmation for that shop.
function asLoaded(stored: StoredDeletion, claim: DeletionClaim): LoadedDeletion | null {
  const { deletion, confirmation } = stored;
  if (!confirmation || confirmation.request.id !== claim.confirmationId) return null;
  const detail = confirmation.request.detail;
  if (!isDeletionDetail(detail) || detail.tenant !== claim.tenant) return null;
  return { deletion, confirmation, detail };
}

async function loadDeletion(env: PilotEnv, claim: DeletionClaim): Promise<LoadedDeletion | null> {
  const response = await authCall(env, `/pilot-deletions/confirmation?tenant=${encodeURIComponent(claim.tenant)}` +
    `&id=${encodeURIComponent(claim.confirmationId)}`);
  if (!response.ok) throw new Error(`deletion_read_${response.status}`);
  return asLoaded((await response.json()) as StoredDeletion, claim);
}

/// When the shop's data was deleted by the deletion this confirmation started:
/// the time on its record or, if the wipe finished but completing the record
/// failed, the tenant's tombstone, which the wipe writes last of the data.
/// Null while any data is left. The owner's page reads `deleted` from here
/// even while the deletion's very last step, taking the shop off the
/// console's list, is still to run: none of the owner's data is left.
async function deletionFinishedAt(env: PilotEnv, tenant: string, deletion: PilotDeletionRecord | null): Promise<string | null> {
  if (deletion?.deletedAt) return deletion.deletedAt;
  const response = await tenantCall(env, tenant, `/tombstone?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) throw new Error(`tombstone_read_${response.status}`);
  const { tombstone } = (await response.json()) as { tombstone: { deletedAt?: unknown } | null };
  return typeof tombstone?.deletedAt === "string" ? tombstone.deletedAt : null;
}

async function deletionLinkState(env: PilotEnv, loaded: LoadedDeletion, nowMs: number): Promise<DeletionState> {
  const { confirmation, deletion, detail } = loaded;
  if (confirmation.status === "decided") {
    if (!approvedDeletion(confirmation)) return "declined";
    return (await deletionFinishedAt(env, detail.tenant, deletion)) ? "deleted" : "deleting";
  }
  // A withdrawn confirmation is one that expired unanswered before a new request replaced it.
  if (confirmation.status === "withdrawn") return "expired";
  return confirmationOpen(confirmation, nowMs) ? "awaiting_owner" : "expired";
}

/// What a deletion would take from the shop now, or null once the shop is gone.
async function liveGoes(env: PilotEnv, tenant: string): Promise<DeletionGoes | null> {
  const response = await tenantCall(env, tenant, `/pilot/summary?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) throw new Error(`summary_read_${response.status}`);
  const summary = (await response.json()) as { shop: PilotShopRecord | null; messages: number; replies: number;
    payments: number };
  if (!summary.shop) return null;
  return {
    messages: summary.messages,
    replies: summary.replies,
    payments: summary.payments,
    lineConnected: Boolean(summary.shop.lineConnectionId),
  };
}

async function deletionView(env: PilotEnv, loaded: LoadedDeletion): Promise<DeletionView> {
  const { confirmation, detail } = loaded;
  const state = await deletionLinkState(env, loaded, Date.now());
  const goes = state === "deleted" ? detail.goes : ((await liveGoes(env, detail.tenant)) ?? detail.goes);
  return {
    shopName: detail.shopName,
    goes,
    state,
    expiresAt: new Date(confirmation.request.expiresAt ?? 0).toISOString(),
    ...(confirmation.status === "decided" ? { decidedAt: new Date(confirmation.decision.decidedAt).toISOString() } : {}),
  };
}

/// `POST /v1/pilot/deletions/{token}/decision`. The owner's answer is settled
/// in AuthObject by approval-core's rules before anything is deleted: whoever
/// holds the link is the owner, as for replies, so the role is set here and
/// never read from the request, and the kind is owner-only. Approving then runs
/// the tenant deletion and completes the record; if the wipe stops part way
/// the decision still stands, the page shows `deleting`, and the operator's
/// same request finishes it without asking the owner again. Declining deletes
/// nothing.
async function decideDeletionByLink(request: Request, env: PilotEnv, claim: DeletionClaim): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || typeof parsed.value.approve !== "boolean") return json({ error: "invalid_request" }, 400);
  const approve = parsed.value.approve;
  const response = await authCall(env, "/pilot-deletions/decide", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ tenant: claim.tenant, id: claim.confirmationId, approve, role: "owner",
      decidedBy: "owner-link" }),
  });
  if (!response.ok) return json({ error: "decision_unavailable" }, 503);
  const decided = (await response.json()) as DecidedConfirmation;
  const loaded = asLoaded(decided, claim);
  if (!loaded) return json({ error: "link_invalid" }, 404);
  if (!decided.result.ok) {
    if (decided.result.refused === "already_decided") {
      return json({ error: "already_decided", view: await deletionView(env, loaded) }, 409);
    }
    if (decided.result.refused === "expired") return json({ error: "link_expired" }, 410);
    // Not found, withdrawn, not permitted, or an option or revision the link never showed: nothing this link can
    // decide.
    return json({ error: "link_invalid" }, 404);
  }
  // The owner's answer, settled in AuthObject above, goes to the shop's log before any wipe; a yes then takes the
  // log with the rest of the shop, and the deletion record in AuthObject keeps who asked and when.
  await appendAudit(env, claim.tenant, { actor: { kind: "owner" }, action: "deletion.decided",
    subject: { confirmationId: claim.confirmationId }, outcome: approve ? "approved" : "declined" });
  if (approve && loaded.deletion) {
    const wiped = await wipeShop(env, loaded.deletion);
    return json(await deletionView(env, { ...loaded, deletion: wiped.record }));
  }
  return json(await deletionView(env, loaded));
}

// ---------------------------------------------------------------------------
// Operator console (behind adminGate: Access audience, operator bearer, and
// an exact ADMIN_METHODS entry, all checked before this runs)
// ---------------------------------------------------------------------------

async function operatorRoute(request: Request, url: URL, env: PilotEnv, flags: Flags, ctx: ExecutionContext): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    if (route === "GET /v1/admin/pilot/shops") return listShops(env);
    if (route === "GET /v1/admin/pilot/gate") return readGate(env);
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
    if (!(await readShop(env, tenant))) return noShop(env, tenant);
    if (route === "GET /v1/admin/pilot/messages") return listFrom(env, tenant, "/pilot/messages", "messages");
    if (route === "GET /v1/admin/pilot/payments") return listFrom(env, tenant, "/pilot/payments", "payments");
    if (route === "GET /v1/admin/pilot/subscription-payments") {
      return listFrom(env, tenant, "/pilot/subscription-payments", "payments");
    }
    if (route === "GET /v1/admin/pilot/actions") return listActions(env, tenant);
    // Everything stored for the shop, at its request: the same tenant export
    // a shop's own session gets, so LINE secrets never appear in it.
    if (route === "GET /v1/admin/pilot/export") return tenantExport(env, tenant);
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const body = parsed.value;
  // Who the shop's audit log names for this write: the operator's Access identity (audit-log.ts).
  const actor: AuditActor = { kind: "operator", email: await operatorIdentity(ctx) };
  if (route === "POST /v1/admin/pilot/shops") return createShop(env, body, actor);
  // Every other write names an existing pilot shop.
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  if (route === "POST /v1/admin/pilot/deletions") {
    // A deletion can stop after it has removed the shop's own record, and the same request finishes it. So the
    // record is read strictly here: one that cannot be read is never taken for one that is gone, which would skip
    // asking the owner of a shop that went live since its deletion stopped.
    const found = await shopRecord(env, body.tenant).catch(() => undefined);
    if (found === undefined) return json({ error: "shop_unavailable" }, 503);
    return found ? deleteShop(env, found, body, ctx) : finishDeletion(env, body.tenant, body);
  }
  const shop = await readShop(env, body.tenant);
  if (!shop) return noShop(env, body.tenant);
  if (route === "POST /v1/admin/pilot/line-connections") return connectLine(env, shop, body, actor);
  if (route === "POST /v1/admin/pilot/replies") return proposeReply(env, shop, body, flags, actor);
  if (route === "POST /v1/admin/pilot/payments") return recordPayment(env, shop, body, actor);
  if (route === "POST /v1/admin/pilot/subscription-payments") return recordSubscriptionPayment(env, shop, body, actor);
  if (route === "POST /v1/admin/pilot/gate/cohort") return setCohort(env, shop, body, actor);
  return json({ error: "not_found" }, 404);
}

/// A tenant with no shop record: deleted, saying when and by whom, or never a
/// shop at all. A shop whose wipe finished but whose record could not be
/// completed is known by the tombstone the wipe writes last of the shop's
/// data; so is one whose deletion has only its last step left, taking the
/// shop off the console's list, since its data is gone.
async function noShop(env: PilotEnv, tenant: string): Promise<Response> {
  const deletion = (await readDeletionState(env, tenant))?.deletion ?? null;
  const deletedAt = deletion ? await deletionFinishedAt(env, tenant, deletion).catch(() => null) : null;
  if (deletion && deletedAt) {
    return json({ error: "tenant_deleted", deletedAt, deletedBy: deletion.deletedBy }, 404);
  }
  return json({ error: "shop_not_found" }, 404);
}

/// The shop's deletion record and its current owner confirmation, or null when
/// they cannot be read.
async function readDeletionState(env: PilotEnv, tenant: string): Promise<StoredDeletion | null> {
  const response = await authCall(env, `/pilot-deletions?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return null;
  return (await response.json()) as StoredDeletion;
}

/// The shop's deletion when one has started and not finished: a shop that never went live is wiped as its deletion is
/// recorded, and a live one once its owner says yes. Null when there is none, when the owner has not said yes (the
/// confirmation waits, was declined or expired), or once the record says it finished.
function unfinishedDeletion({ deletion, confirmation }: StoredDeletion): PilotDeletionRecord | null {
  if (!deletion || deletion.deletedAt) return null;
  if (!deletion.confirmationId) return deletion;
  return approvedDeletion(confirmation) && confirmation?.request.id === deletion.confirmationId ? deletion : null;
}

/// Whether the shop is still on the registry, the operator console's list. Taking it off is the deletion's last step
/// (tenant-data.ts), so a deletion that started is finished once the shop is not. Null when it cannot be read.
async function isRegistered(env: PilotEnv, tenant: string): Promise<boolean | null> {
  const response = await authCall(env, `/pilot-shops?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return null;
  return ((await response.json()) as { registered?: unknown }).registered === true;
}

/// `POST /v1/admin/pilot/deletions` for a tenant with no shop record. A deletion can stop after it has removed the
/// record and before its last step, and the console still lists the shop as deleting (`listShops`), so the same
/// request finishes it: the record of the deletion says one started, and the shop is still on the registry. The name
/// is checked against that record, which kept the shop's name, so a request for the wrong shop still deletes nothing.
/// Anything else answers as every route does for a shop that is not there: deleted, or never a shop.
async function finishDeletion(env: PilotEnv, tenant: string, body: Record<string, unknown>): Promise<Response> {
  const stored = await readDeletionState(env, tenant);
  if (!stored) return json({ error: "audit_unavailable" }, 503);
  const started = unfinishedDeletion(stored);
  if (!started) return noShop(env, tenant);
  const listed = await isRegistered(env, tenant);
  if (listed === null) return json({ error: "shops_unavailable" }, 503);
  // Off the registry, the wipe finished and only completing its record did not; the tombstone says when.
  if (!listed) return noShop(env, tenant);
  if (!sameName(body.confirmName, started.name)) return json({ error: "name_mismatch" }, 409);
  return (await wipeShop(env, started)).response;
}

function writeDeletion(env: PilotEnv, record: PilotDeletionRecord): Promise<Response> {
  return authCall(env, "/pilot-deletions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify(record),
  });
}

/// The operator's Access identity. Access gives an email for a person and nothing for a service token.
/// The model gateway's cap route records it the same way (model-gateway.ts).
export async function operatorIdentity(ctx: ExecutionContext): Promise<string | null> {
  try {
    const identity = (await ctx.access?.getIdentity()) as { email?: unknown } | undefined;
    return typeof identity?.email === "string" ? identity.email : null;
  } catch {
    return null;
  }
}

/// A typed name and a stored one are the same name when they differ only in outer spaces or in how an accented
/// letter was composed (é typed as one character or as e and a combining accent).
function sameName(typed: unknown, stored: string): boolean {
  return typeof typed === "string" && typed.normalize("NFC").trim() === stored.normalize("NFC").trim();
}

/// Deletes everything stored for one pilot shop, at the shop's request,
/// through the same tenant deletion a shop's own session uses: its task with
/// every reply, the sealed LINE secrets and the webhook route, messages,
/// payments and consent, leaving a tombstone that records when, and last its
/// registry row. Nothing can bring the data back, so the operator types the
/// shop's exact name as well as sending its id, and an id pasted for the
/// wrong shop deletes nothing. A partial wipe answers 500 wipe_incomplete
/// naming what is left; the shop stays on the console's list as deleting,
/// and sending the same request again finishes it (`finishDeletion` once the
/// wipe has taken the shop's own record).
/// Pilot shops belong to no company, so unlike the session route there are
/// no company indexes to prune afterwards.
///
/// A live shop (`isLive`) also needs its owner's confirmation (the owner's
/// decision of 23 Nov 2026): the request deletes nothing and answers 202 with
/// the link to send the owner, the same link while that confirmation waits.
/// The owner's yes runs the deletion. Once the owner has said yes, this same
/// request finishes a wipe that stopped part way, without asking again. A shop
/// that never went live is deleted at once, as before, and its deletion that
/// stopped part way is finished as it was asked for, unless the shop has gone
/// live since, when its owner is asked.
///
/// The record of the deletion is written before anything is wiped, and a
/// deletion that cannot be recorded does not start. It is completed with the
/// time and the counts once the wipe finishes. If only that last write fails,
/// the data is gone and the record still shows who asked and when.
async function deleteShop(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
  if (!sameName(body.confirmName, shop.name)) return json({ error: "name_mismatch" }, 409);
  // Whether the owner has already said yes comes first, and is never guessed: without the record, nothing starts.
  const current = await readDeletionState(env, shop.tenant);
  if (!current) return json({ error: "audit_unavailable" }, 503);
  if (current.deletion && approvedDeletion(current.confirmation) &&
      current.deletion.confirmationId === current.confirmation?.request.id) {
    return (await wipeShop(env, current.deletion)).response;
  }
  const live = await isLive(env, shop);
  if (live === null) return json({ error: "consent_unavailable" }, 503);
  if (live) return askOwner(env, shop, ctx);
  // A deletion of this shop that started and stopped part way is the same request: its record keeps who asked and
  // when, so finishing it neither moves them nor logs a second request.
  const started = unfinishedDeletion(current);
  if (started) return (await wipeShop(env, started)).response;
  const record: PilotDeletionRecord = {
    tenant: shop.tenant,
    name: shop.name,
    requestedAt: new Date().toISOString(),
    deletedBy: await operatorIdentity(ctx),
  };
  if (!(await writeDeletion(env, record)).ok) return json({ error: "audit_unavailable" }, 503);
  // Wiped with the shop once the deletion finishes; an entry that outlives a wipe that stopped part way says who
  // asked for it.
  await appendAudit(env, shop.tenant, { actor: { kind: "operator", email: record.deletedBy },
    action: "deletion.requested", subject: {}, outcome: "ok" });
  return (await wipeShop(env, record)).response;
}

/// A shop is live once its owner has given consent or a LINE connection
/// exists: from then on it holds what its customers and its owner gave it, so
/// deleting it needs the owner's own yes. Null when consent cannot be read,
/// because a deletion never guesses that a shop is not live.
///
/// Only the owner writes a pilot shop's consent record (their link, or their
/// own session, shops.ts), so a record of either value means the owner has
/// answered. A shop stays live after its owner withdraws consent: withdrawing
/// stops the team's work, and must not also let an operator delete what the
/// shop holds without the owner's yes. A shop with no record answers
/// `{ cloudWork: false }` with no `updatedAt` (tenant-object.ts), which is
/// how the schedule object tells an answer from none as well
/// (schedule-object.ts, `liveConsent`).
async function isLive(env: PilotEnv, shop: PilotShopRecord): Promise<boolean | null> {
  if (shop.lineConnectionId) return true;
  const response = await tenantCall(env, shop.tenant, `/consent?tenant=${encodeURIComponent(shop.tenant)}`);
  if (!response.ok) return null;
  const record = (await response.json().catch(() => null)) as { cloudWork?: unknown; updatedAt?: unknown } | null;
  if (typeof record?.cloudWork !== "boolean") return null;
  return record.cloudWork || typeof record.updatedAt === "string";
}

/// Opens the owner's confirmation, or answers the one already open, with the
/// link to send the owner. AuthObject records who asked in the same write that
/// opens it, so no link is handed out for a request it could not record. If
/// the owner said yes in the moment since this request read the record, it
/// finishes their deletion instead.
async function askOwner(env: PilotEnv, shop: PilotShopRecord, ctx: ExecutionContext): Promise<Response> {
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin) return json({ error: "not_configured", setting: "WEB_ORIGIN" }, 503);
  if (!env.APPROVAL_LINK_SECRET || env.APPROVAL_LINK_SECRET.length < 32) {
    return json({ error: "not_configured", setting: "APPROVAL_LINK_SECRET" }, 503);
  }
  const goes = await liveGoes(env, shop.tenant).catch(() => null);
  if (!goes) return json({ error: "shop_unavailable" }, 503);
  const detail: DeletionDetail = { tenant: shop.tenant, shopName: shop.name, goes };
  const response = await authCall(env, "/pilot-deletions/open", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ tenant: shop.tenant, name: shop.name, deletedBy: await operatorIdentity(ctx), detail }),
  });
  if (!response.ok) return json({ error: "audit_unavailable" }, 503);
  const opened = (await response.json()) as OpenedConfirmation;
  if (opened.outcome === "approved") return (await wipeShop(env, opened.deletion)).response;
  // A new confirmation is a new request; asking again while one waits only answers its link again.
  if (opened.outcome === "opened") {
    await appendAudit(env, shop.tenant, { actor: { kind: "operator", email: opened.deletion.deletedBy },
      action: "deletion.requested", subject: { confirmationId: opened.confirmation.request.id },
      outcome: "awaiting_owner" });
  }
  const expiresAtMs = opened.confirmation.request.expiresAt ?? 0;
  const token = await mintDeletionToken(env.APPROVAL_LINK_SECRET, {
    tenant: shop.tenant,
    confirmationId: opened.confirmation.request.id,
    expiresAtMs,
  });
  return json({
    status: "awaiting_owner",
    confirmUrl: `${webOrigin}/delete/${token}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  }, 202);
}

/// Runs the tenant deletion for a recorded request and completes its record
/// with the time and counts. Answers the deletion's own response (the counts,
/// or 500 wipe_incomplete) and the record as it now stands.
async function wipeShop(env: PilotEnv, record: PilotDeletionRecord): Promise<{ response: Response; record: PilotDeletionRecord }> {
  const wiped = await tenantDelete(env, record.tenant);
  if (!wiped.ok) return { response: wiped, record };
  const summary = (await wiped.json()) as Record<string, unknown>;
  const counts = Object.fromEntries(Object.entries(summary).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number"));
  const deletedAt = typeof summary.deletedAt === "string" ? summary.deletedAt : new Date().toISOString();
  const completed: PilotDeletionRecord = { ...record, deletedAt, counts };
  await writeDeletion(env, completed).catch(() => undefined);
  return { response: json(summary), record: completed };
}

/// What an owner's own deletion of one of their shops came to (account-deletion.ts): done, with what the wipe removed; or
/// stopped, with the reason (`wipe_incomplete` and the step that stopped it, or a record that could not be read or
/// written). Sending the same request again finishes a stopped one.
export type OwnerShopDeletion =
  | { ok: true; summary: Record<string, unknown> }
  | { ok: false; error: string; failed?: unknown };

async function wiped(env: PilotEnv, record: PilotDeletionRecord): Promise<OwnerShopDeletion> {
  const { response } = await wipeShop(env, record);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok && body) return { ok: true, summary: body };
  return { ok: false, error: typeof body?.error === "string" ? body.error : "wipe_incomplete", failed: body?.failed };
}

/// The owner deletes their own shop, signed in, as part of deleting their account (item 124; docs/pilot-api.md, "Deleting
/// your own account"). It runs through the very deletion record and wipe the operator's request and the owner's link use:
/// one owner confirmation is opened (or the one already open is answered), and decided in AuthObject by approval-core's
/// rules as `owner`, naming the linked account by its id, before anything is wiped; then the tenant deletion runs and the
/// record is completed. The person's own signed-in session and the shop's name typed in the app are the owner's yes
/// (account-deletion.ts checks both before this runs), so no link is minted and none is needed. The shop's log gets
/// `deletion.requested` and `deletion.decided` as for the link, and they go with the shop; the record outlives it, with
/// `askedBy`, the account's id.
///
/// A deletion already approved, by the link or by an earlier try of this one, is finished without opening another. A shop
/// whose own record a stopped wipe already removed is finished as the operator's same request finishes it. A shop that is
/// gone already is done.
///
/// Only while `accountId` is the shop's owner now (item 140): a shop whose people record links no account, or another
/// one, is answered `not_owner_now` and left as it is, with nothing opened, decided, logged or wiped.
export async function ownerDeletesShop(env: PilotEnv, tenant: string, accountId: string): Promise<OwnerShopDeletion> {
  const stored = await readDeletionState(env, tenant);
  if (!stored) return { ok: false, error: "audit_unavailable" };
  const shop = await shopRecord(env, tenant).catch(() => undefined);
  if (shop === undefined) return { ok: false, error: "shop_unavailable" };
  if (!shop) {
    const started = unfinishedDeletion(stored);
    if (!started) return { ok: true, summary: {} };
    const listed = await isRegistered(env, tenant);
    if (listed === null) return { ok: false, error: "shops_unavailable" };
    return listed ? wiped(env, started) : { ok: true, summary: {} };
  }
  // The caller's account must be the one the shop's people record links now. An account deletion that stopped part way
  // keeps the shops it covered, each with the account it was asked under, and finishes them when it is sent again; an
  // operator may have unlinked that account meanwhile, or linked someone else. Without this check the former owner would
  // decide the confirmation as `owner` and wipe a shop that is no longer theirs. The wipe takes the shop's record and its
  // people together, so a shop still here still has the record that says who owns it; one already gone (above) has
  // nobody left to ask, and only what its stopped wipe left is finished.
  const owner = await linkedOwnerOf(env, tenant);
  if (owner === undefined) return { ok: false, error: "people_unavailable" };
  if (owner?.id !== accountId) return { ok: false, error: "not_owner_now" };
  if (stored.deletion && approvedDeletion(stored.confirmation) &&
      stored.deletion.confirmationId === stored.confirmation?.request.id) {
    return wiped(env, stored.deletion);
  }
  const goes = await liveGoes(env, tenant).catch(() => null);
  if (!goes) return { ok: false, error: "shop_unavailable" };
  const detail: DeletionDetail = { tenant, shopName: shop.name, goes };
  const opening = await authCall(env, "/pilot-deletions/open", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ tenant, name: shop.name, deletedBy: null, askedBy: accountId, detail }),
  });
  if (!opening.ok) return { ok: false, error: "audit_unavailable" };
  const opened = (await opening.json()) as OpenedConfirmation;
  if (opened.outcome === "approved") return wiped(env, opened.deletion);
  const actor: AuditActor = { kind: "owner", id: accountId };
  const confirmationId = opened.confirmation.request.id;
  if (opened.outcome === "opened") {
    await appendAudit(env, tenant, { actor, action: "deletion.requested", subject: { confirmationId }, outcome: "ok" });
  }
  const deciding = await authCall(env, "/pilot-deletions/decide", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ tenant, id: confirmationId, approve: true, role: "owner", decidedBy: accountId }),
  });
  if (!deciding.ok) return { ok: false, error: "decision_unavailable" };
  const decided = (await deciding.json()) as DecidedConfirmation;
  // Another answer may have settled it a moment before: a yes is finished, anything else deletes nothing.
  if (!decided.result.ok && !(decided.result.refused === "already_decided" && approvedDeletion(decided.confirmation))) {
    return { ok: false, error: "decision_refused" };
  }
  if (decided.result.ok) {
    await appendAudit(env, tenant, { actor, action: "deletion.decided", subject: { confirmationId }, outcome: "approved" });
  }
  const record = decided.deletion ?? opened.deletion;
  return wiped(env, record);
}

/// The account linked as the shop's owner, from its people record (people-store.ts): null when none is linked, and
/// undefined when the record cannot be read, so no deletion takes an unreadable record for a shop with no owner. The same
/// read as people.ts's `readPeople`, which this file does not import: people.ts imports this one, and the two would then
/// import each other.
async function linkedOwnerOf(env: PilotEnv, tenant: string): Promise<OwnerAccount | null | undefined> {
  const response = await tenantCall(env, tenant, `/people?tenant=${encodeURIComponent(tenant)}`).catch(() => null);
  if (!response?.ok) {
    await response?.body?.cancel();
    return undefined;
  }
  const people = (await response.json().catch(() => null)) as Pick<PeopleView, "ownerAccount"> | null;
  return people ? people.ownerAccount ?? null : undefined;
}

/// A shop the person began to make themselves and never finished (shops-store.ts, `personMakes`), deleted with their
/// account: it is on no list and has no customers, so, as for a shop that never went live, its deletion is recorded and
/// run at once, with `askedBy` the person's account. One whose object holds no shop is done: taking its make off the
/// journal is AuthObject's (account-store.ts). One that is listed by now is an owned shop like any other, and is left to
/// that list.
export async function deleteUnfinishedMake(env: PilotEnv, tenant: string, askedBy: string): Promise<OwnerShopDeletion> {
  const shop = await shopRecord(env, tenant).catch(() => undefined);
  if (shop === undefined) return { ok: false, error: "shop_unavailable" };
  const stored = await readDeletionState(env, tenant);
  if (!stored) return { ok: false, error: "audit_unavailable" };
  const started = unfinishedDeletion(stored);
  if (!shop && !started) return { ok: true, summary: {} };
  const listed = await isRegistered(env, tenant);
  if (listed === null) return { ok: false, error: "shops_unavailable" };
  if (started) return listed || shop ? wiped(env, started) : { ok: true, summary: {} };
  if (listed || !shop) return { ok: true, summary: {} };
  const record: PilotDeletionRecord = { tenant, name: shop.name, requestedAt: new Date().toISOString(), deletedBy: null,
    askedBy };
  if (!(await writeDeletion(env, record)).ok) return { ok: false, error: "audit_unavailable" };
  return wiped(env, record);
}

/// A pilot shop is a tenant of its own (`pilot:<uuid>`), so every existing
/// per-tenant boundary (vault, task ownership, consent, export, deletion)
/// applies to it unchanged. No session can ever carry such a tenant: session
/// tenants come from a verified provider subject.
async function createShop(env: PilotEnv, body: Record<string, unknown>, actor: AuditActor): Promise<Response> {
  // Names are stored as a person reads them, without outer spaces, so the name the console shows is the name an
  // operator can type back to confirm a deletion.
  const name = typeof body.name === "string" ? body.name.trim() : body.name;
  const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : body.ownerName;
  if (!bounded(name, 200) || !bounded(ownerName, 200)) return json({ error: "invalid_request" }, 400);
  // A shop template (routine-setup.ts) is checked before anything is made, so a shop never starts half set up. None,
  // or null, is a shop as before templates: every worker on, nothing scheduled, nothing to ask.
  const asked = body.template ?? null;
  const template = asked === null ? null : checkedTemplate(asked);
  if (asked !== null && !template) return json({ error: "unknown_template" }, 400);
  // The make goes on AuthObject's journal before anything of the shop is written. If this same shop (the same names and
  // template) is already there, an earlier try stopped part way, and this one finishes that shop: asking again never makes
  // a second one.
  const begun = await beginMake(env, { tenant: newShopTenant(), name, ownerName, template: template?.id ?? null });
  // An operator's make never meets a person's limits; an answer that names one is AuthObject going wrong.
  if (begun === null || begun === "too_many" || "full" in begun) return json({ error: "shop_unavailable" }, 503);
  const { tenant } = begun;
  if (!(await writeNewShop(env, tenant, { name, ownerName, template }, actor))) {
    return json({ error: "shop_unavailable" }, 503);
  }
  // Listed last, and asked twice if need be: the answer to the first may only have been lost, and the shop is whole.
  if (!(await twice(() => listNewShop(env, tenant)))) return json({ error: "shop_unavailable" }, 503);
  return json({ tenant, name, ownerName, ...(template ? { template: template.id } : {}) });
}

/// Puts a whole new shop on the console's list and ends its make (AuthObject's `POST /pilot-shops`). Safe to repeat.
async function listNewShop(env: PilotEnv, tenant: string): Promise<boolean> {
  try {
    const response = await authCall(env, "/pilot-shops", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify({ tenant }),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/// A new pilot shop's tenant. See `createShop`.
export function newShopTenant(): string {
  return `pilot:${crypto.randomUUID()}`;
}

/// The owner a shop is made with when its owner makes it (self-serve.ts): the account's link id and verified subject, and
/// the hash, id and end of their device's first owner session, whose token only the Worker ever holds.
export type NewShopOwner = { accountId: string; subject: string; sessionId: string; tokenHash: string; expiresAt: number };

/// Writes a new shop's own records, as the operator's route and the owner's own both make one: the shop with its
/// `shop.created` entry, the template's setup with its entries (routine-setup.ts, the one way it is applied) and, for a
/// shop its owner makes, `owner`'s link and first session with their entries, all in one write to the shop's object
/// (pilot-store.ts), so that object holds the shop whole or nothing of it. Its clocks are written before it, and a clock a
/// stopped try left is for a routine that never came to be (routine-setup.ts).
///
/// Answers `created` when it wrote the shop, `existing` when the shop was already there because an earlier try of this
/// same make wrote it and then stopped (its answer lost, or a later step failing), which it leaves as it is, so the shop's
/// log never says it was made twice; or null when the shop could not be written, and then nothing of it is. It does not
/// list the shop: each caller does that last, so a shop that stopped part way is never listed, and asking again finishes it.
export async function writeNewShop(env: PilotEnv, tenant: string,
  shop: { name: string; ownerName: string; template: ShopTemplate | null }, actor: AuditActor, owner?: NewShopOwner):
  Promise<"created" | "existing" | null> {
  const present = await shopRecord(env, tenant).catch(() => undefined);
  if (present === undefined) return null;
  if (present) return "existing";
  const setup = shop.template ? await newShopSetup(env, tenant, shop.template) : null;
  if (shop.template && !setup) return null;
  const created = await pilotWrite(env, tenant, "/pilot/shop", {
    name: shop.name,
    ownerName: shop.ownerName,
    taskId: `pilot-task-${crypto.randomUUID()}`,
    ...(shop.template ? { template: shop.template.id } : {}),
    ...(setup ? { setup } : {}),
    ...(owner ? { owner } : {}),
    actor,
  }).catch(() => null);
  await created?.body?.cancel();
  // Another try of the same make wrote it in the meantime: the shop is there all the same.
  if (created?.status === 409) return "existing";
  return created?.ok ? "created" : null;
}

/// Every pilot shop, with its latest deletion request when it has one, so the
/// console shows a shop waiting for its owner after any reload. A deletion
/// request that cannot be read fails the list rather than vanishing from it: a
/// shop shown without one reads as nobody having asked. A shop whose record
/// cannot be read fails it too, rather than drop off the list.
///
/// A shop stays on the registry until its deletion has finished, because
/// taking it off is the deletion's last step (tenant-data.ts). So a shop whose
/// deletion started and stopped part way is still here, marked `deleting`,
/// and the operator's same deletion request finishes it. If the deletion
/// stopped after it had removed the shop's own record, the row is what the
/// record of the deletion kept, the tenant and the shop's name: enough to
/// find the shop and send the request again, and nothing of its data.
async function listShops(env: PilotEnv): Promise<Response> {
  const registry = await authCall(env, "/pilot-shops");
  if (!registry.ok) return json({ error: "shops_unavailable" }, 503);
  const { tenants } = (await registry.json()) as { tenants: string[] };
  const shops = await Promise.all(
    tenants.map(async (tenant) => {
      const [shop, consent, stored] = await Promise.all([
        shopRecord(env, tenant),
        shopConsent(env, tenant),
        readDeletionState(env, tenant),
      ]);
      if (!stored) throw new Error("deletion_unavailable");
      const started = unfinishedDeletion(stored);
      if (!shop) {
        // With no deletion under way here, only the session route's deletion, which keeps no pilot record, can have
        // stopped part way to leave such a row. It is not listed, as before, and running that deletion again ends it.
        if (!started) return null;
        return { tenant, name: started.name, ownerName: "", consent: false, deleting: { shopRecord: false } };
      }
      const deletion = await shopDeletion(env, tenant, stored);
      return {
        tenant,
        name: shop.name,
        ownerName: shop.ownerName,
        ...(shop.lineConnectionId ? { lineConnectionId: shop.lineConnectionId } : {}),
        ...(shop.template ? { template: shop.template } : {}),
        ...(shop.selfServe ? { selfServe: true } : {}),
        consent,
        ...(deletion ? { deletion } : {}),
        ...(started ? { deleting: { shopRecord: true } } : {}),
      };
    }),
  ).catch(() => null);
  if (!shops) return json({ error: "shops_unavailable" }, 503);
  return json({ shops: shops.filter((shop) => shop !== null) });
}

/// The shop's record: null when it has none, which a deletion that stopped part way can leave, and an error when it
/// cannot be read, so neither the list nor a deletion ever takes an unreadable record for a missing one.
async function shopRecord(env: PilotEnv, tenant: string): Promise<PilotShopRecord | null> {
  const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${encodeURIComponent(tenant)}`);
  // An answer left unread keeps its request open on the shop's object, which then cannot hibernate or be evicted until
  // the runtime gives up on it: every new shop's first read is this 404.
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`shop_read_${response.status}`);
  return ((await response.json()) as { shop: PilotShopRecord }).shop;
}

/// The shop's current owner confirmation as the console shows it, its link
/// re-minted at the same expiry (minting is deterministic, so a read never
/// extends it). Null when no deletion of this shop was ever put to its owner.
async function shopDeletion(env: PilotEnv, tenant: string, stored: StoredDeletion): Promise<DeletionRequest | null> {
  const { confirmation } = stored;
  if (!confirmation) return null;
  const loaded = asLoaded(stored, { tenant, confirmationId: confirmation.request.id, expiresAtMs: 0 });
  if (!loaded) return null;
  const expiresAtMs = confirmation.request.expiresAt ?? 0;
  const webOrigin = originOf(env.WEB_ORIGIN);
  const token = await mintDeletionToken(env.APPROVAL_LINK_SECRET, {
    tenant,
    confirmationId: confirmation.request.id,
    expiresAtMs,
  }).catch(() => null);
  return {
    state: await deletionLinkState(env, loaded, Date.now()),
    confirmUrl: webOrigin && token ? `${webOrigin}/delete/${token}` : "",
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(confirmation.status === "decided" ? { decidedAt: new Date(confirmation.decision.decidedAt).toISOString() } : {}),
  };
}

async function listFrom(env: PilotEnv, tenant: string, path: string, field: string): Promise<Response> {
  const response = await tenantCall(env, tenant, `${path}?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return json({ error: `${field}_unavailable` }, 503);
  const listed = (await response.json()) as Record<string, unknown>;
  return json({ [field]: listed[field] ?? [] });
}

/// Connects the shop's LINE Official Account. Both secrets go straight into
/// the shop's vault, sealed together, and never come back out of any route.
/// The grant is the connection's only resource, the bot's user id, with
/// actions allowed: the one thing this connection exists to do is push the
/// owner's approved replies. Connecting again replaces the previous
/// connection and revokes it, wiping its sealed secrets, so a rotated token
/// leaves nothing usable behind; a reply still waiting on the old connection
/// then fails at dispatch rather than sending through it.
async function connectLine(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>,
  actor: AuditActor): Promise<Response> {
  const { channelId, botUserId, channelSecret, channelAccessToken } = body;
  if (!bounded(channelId, 64) || typeof botUserId !== "string" || !LINE_USER_ID.test(botUserId) ||
      !bounded(channelSecret, 256) || !bounded(channelAccessToken, 4096)) {
    return json({ error: "invalid_request" }, 400);
  }
  const publicOrigin = originOf(env.PUBLIC_API_ORIGIN);
  if (!publicOrigin) return json({ error: "not_configured", setting: "PUBLIC_API_ORIGIN" }, 503);
  const tenant = shop.tenant;
  const vault = credStub(env, tenant);
  const stored = await vault.fetch(
    new Request("https://cred/connections", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant },
      body: JSON.stringify({
        tenant,
        provider: "line",
        accountId: channelId,
        scopes: [],
        refreshToken: sealableLineCredentials({ channelAccessToken, channelSecret }),
        resourceIds: [botUserId],
        allowsActions: true,
      }),
    }),
  );
  if (!stored.ok) return json({ error: "vault_unavailable" }, 503);
  const { id: connectionId } = (await stored.json()) as { id: string };
  const revoke = (id: string) =>
    vault
      .fetch(new Request(`https://cred/connections/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-tenant": tenant } }))
      .catch(() => undefined);
  // The webhook names only the connection, so the route index maps it back
  // to the shop's vault. Without the row every delivery would answer 404, so
  // a failed write undoes the connection and lets the operator try again.
  const indexed = await authCall(env, "/inbound-routes", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify({ provider: "line", accountId: connectionId, tenant, connectionId }),
  }).catch(() => null);
  if (!indexed?.ok) {
    await revoke(connectionId);
    return json({ error: "inbound_route_unavailable" }, 503);
  }
  const pointed = await pilotWrite(env, tenant, "/pilot/shop-connection", { lineConnectionId: connectionId, actor });
  if (!pointed.ok) {
    await revoke(connectionId);
    return json({ error: "shop_unavailable" }, 503);
  }
  const { previous } = (await pointed.json()) as { previous: string | null };
  if (previous && previous !== connectionId) await revoke(previous);
  return json({ connectionId, webhookUrl: `${publicOrigin}/v1/inbound/line/${connectionId}` });
}

/// The shop's task, created on first use. Indexed before it is created, as
/// `POST /v1/tasks` does, so export and deletion can always find it. A draft
/// in the cloud location: nothing ever claims it for execution; it only
/// holds the shop's reply proposals and their history.
async function ensureShopTask(env: PilotEnv, shop: PilotShopRecord): Promise<boolean> {
  const indexed = await tenantCall(env, shop.tenant, "/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: shop.tenant, taskId: shop.taskId }),
  });
  if (!indexed.ok) return false;
  const stub = env.TASK.get(env.TASK.idFromName(shop.taskId));
  if ((await stub.fetch(new Request("https://task/", { headers: { "x-tenant": shop.tenant } }))).ok) return true;
  const created = await stub.fetch(
    new Request("https://task/", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-task-id": shop.taskId,
        "x-tenant": shop.tenant,
        "x-route": "POST /v1/admin/pilot/replies",
        "x-create-only": "1",
      },
      body: JSON.stringify({
        id: shop.taskId,
        title: "LINE customer replies",
        objective: "Answer customers on LINE with replies the owner approves one by one.",
        state: "draft",
        location: "cloud",
        funding: "cloudBYOK",
        criteria: [],
        updatedAt: new Date().toISOString(),
        tenantId: shop.tenant,
      }),
    }),
  );
  return created.ok || created.status === 409;
}

/// `POST /v1/admin/pilot/replies`: proposes one exact reply to one stored
/// message and mints the owner's link. The operator supplies only the text;
/// the recipient is the message's author and the connection the shop's own,
/// both read from storage, so no request can aim a reply elsewhere. The same
/// kill switches as the session propose route apply. Consent is not needed
/// to propose, as for the operator path through `consentGate`: the owner
/// gives it on the link, before approving, which is the step that sends.
async function proposeReply(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>, flags: Flags,
  actor: AuditActor): Promise<Response> {
  const current = await flags();
  if (!current.officeCloud) return json({ error: "feature_disabled", feature: "officeCloud" }, 403);
  if (!current.officeExternalWrites) return json({ error: "feature_disabled", feature: "officeExternalWrites" }, 403);
  const { messageId, text } = body;
  if (!bounded(messageId, 128) || typeof text !== "string" || text.length < 1 || text.length > LINE_TEXT_MAX) {
    return json({ error: "invalid_request" }, 400);
  }
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin) return json({ error: "not_configured", setting: "WEB_ORIGIN" }, 503);
  if (!env.APPROVAL_LINK_SECRET || env.APPROVAL_LINK_SECRET.length < 32) {
    return json({ error: "not_configured", setting: "APPROVAL_LINK_SECRET" }, 503);
  }
  const tenant = shop.tenant;
  const messageResponse = await tenantCall(
    env,
    tenant,
    `/pilot/message?tenant=${encodeURIComponent(tenant)}&id=${encodeURIComponent(messageId)}`,
  );
  if (messageResponse.status === 404) return json({ error: "message_not_found" }, 404);
  if (!messageResponse.ok) return json({ error: "message_unavailable" }, 503);
  const { message } = (await messageResponse.json()) as { message: InboundMessage };
  if (!shop.lineConnectionId || message.connectionId !== shop.lineConnectionId) {
    return json({ error: "connection_changed" }, 409);
  }
  const metaResponse = await credStub(env, tenant).fetch(
    new Request(`https://cred/connections/${encodeURIComponent(message.connectionId)}`, { headers: { "x-tenant": tenant } }),
  );
  if (!metaResponse.ok) return json({ error: "connection_unavailable" }, 409);
  const meta = (await metaResponse.json()) as { provider?: unknown; accountId?: unknown; resourceIds?: unknown; grantRevision?: unknown };
  const botUserId = Array.isArray(meta.resourceIds) ? meta.resourceIds[0] : undefined;
  if (meta.provider !== "line" || !bounded(meta.accountId) || typeof botUserId !== "string" ||
      !Number.isInteger(meta.grantRevision)) {
    return json({ error: "connection_unavailable" }, 409);
  }
  const prior = message.replyActionId ?? null;
  if (prior) {
    const priorAction = await readAction(env, tenant, shop.taskId, prior).catch(() => null);
    if (priorAction && OPEN_STATES.has(viewState(priorAction, Date.now()))) return json({ error: "reply_pending" }, 409);
  }
  if (!(await ensureShopTask(env, shop))) return json({ error: "task_unavailable" }, 503);

  const expiresAt = new Date(Date.now() + APPROVAL_LINK_TTL_MS).toISOString();
  const proposed = await env.TASK.get(env.TASK.idFromName(shop.taskId)).fetch(
    new Request("https://task/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant },
      body: JSON.stringify({
        connectionId: message.connectionId,
        providerAccountId: meta.accountId,
        operationType: LINE_PUSH_OPERATION,
        targetResourceId: botUserId,
        resourceScope: [botUserId],
        payload: { text },
        recipients: [message.lineUserId],
        grantRevision: meta.grantRevision,
        expiresAt,
      }),
    }),
  );
  if (!proposed.ok) return json(await proposed.json().catch(() => ({ error: "propose_failed" })), proposed.status);
  const action = (await proposed.json()) as ActionProposalJSON;
  // Without this record the broker refuses to send the reply, so a failure
  // here leaves an inert proposal and no link.
  const bound = await pilotWrite(env, tenant, "/pilot/replies", {
    taskId: shop.taskId,
    actionId: action.id,
    messageId: message.id,
    proposedAt: action.proposedAt,
    expiresAt: action.expiresAt,
    expectedReplyActionId: prior,
    actor,
  });
  if (!bound.ok) return json(await bound.json().catch(() => ({ error: "reply_unavailable" })), bound.status === 409 ? 409 : 503);
  const token = await mintApprovalToken(env.APPROVAL_LINK_SECRET, {
    tenant,
    taskId: shop.taskId,
    actionId: action.id,
    expiresAtMs: Date.parse(action.expiresAt),
  });
  return json({ taskId: shop.taskId, actionId: action.id, approvalUrl: `${webOrigin}/approve/${token}`, expiresAt: action.expiresAt });
}

/// `GET /v1/admin/pilot/actions`: every reply's live state, newest first,
/// with its link re-minted at the same expiry (minting is deterministic, so
/// re-reading never extends a link).
async function listActions(env: PilotEnv, tenant: string): Promise<Response> {
  const response = await tenantCall(env, tenant, `/pilot/replies?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) return json({ error: "actions_unavailable" }, 503);
  const { replies } = (await response.json()) as { replies: PilotReplyRecord[] };
  const webOrigin = originOf(env.WEB_ORIGIN);
  const nowMs = Date.now();
  // A proposal that cannot be read fails the whole list rather than
  // vanishing from it: a reply missing from the console reads as never sent.
  const actions = await Promise.all(
    replies.map(async (reply) => {
      const action = await readAction(env, tenant, reply.taskId, reply.actionId);
      if (!action) return null;
      const decidedAt = reply.decidedAt ?? action.approval?.at;
      const token = await mintApprovalToken(env.APPROVAL_LINK_SECRET, {
        tenant,
        taskId: reply.taskId,
        actionId: reply.actionId,
        expiresAtMs: Date.parse(action.expiresAt),
      }).catch(() => null);
      return {
        taskId: reply.taskId,
        actionId: reply.actionId,
        messageId: reply.messageId,
        replyText: lineReplyText(action.payload) ?? "",
        state: viewState(action, nowMs),
        proposedAt: action.proposedAt,
        ...(decidedAt ? { decidedAt } : {}),
        ...(action.dispatch?.at ? { dispatchedAt: action.dispatch.at } : {}),
        approvalUrl: webOrigin && token ? `${webOrigin}/approve/${token}` : "",
      };
    }),
  ).catch(() => null);
  if (!actions) return json({ error: "actions_unavailable" }, 503);
  // An action that answers 404 belongs to a task deleted with its tenant,
  // which is not a missing record.
  return json({ actions: actions.filter((action) => action !== null) });
}

/// `POST /v1/admin/pilot/payments`: the operator records a PromptPay slip
/// they checked against the shop's bank app. Nothing is charged or moved
/// here; this is the shop's ledger of confirmations, kept until deletion.
async function recordPayment(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>,
  actor: AuditActor): Promise<Response> {
  const { orderRef, amountSatang, promptPayId, slipNote } = body;
  if (!bounded(orderRef, 128) || !bounded(promptPayId, 64) || typeof amountSatang !== "number" ||
      !Number.isSafeInteger(amountSatang) || amountSatang <= 0 ||
      (slipNote !== undefined && (typeof slipNote !== "string" || slipNote.length > 1000))) {
    return json({ error: "invalid_request" }, 400);
  }
  const recorded = await pilotWrite(env, shop.tenant, "/pilot/payments", {
    orderRef,
    amountSatang,
    promptPayId,
    ...(slipNote !== undefined ? { slipNote } : {}),
    actor,
  });
  if (!recorded.ok) return json({ error: "payment_unavailable" }, 503);
  return json(((await recorded.json()) as { payment: Payment }).payment);
}

// ---------------------------------------------------------------------------
// The pilot gate: the shop's own subscription payments, and the Phase 1 gate's measurement (pilot-gate.ts)
// ---------------------------------------------------------------------------

/// `POST /v1/admin/pilot/subscription-payments`: the operator records the
/// shop's own payment to Manut AI once they see it arrive in Manut AI's bank
/// account, as they record an order payment once it arrives in the shop's.
/// Nothing is charged or moved here. Money is a positive whole number of
/// satang; anything else, a float included, is refused rather than rounded.
/// The slip's reference is trimmed as a person typed it, and a slip already
/// recorded for the shop answers 409 and records nothing.
async function recordSubscriptionPayment(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>,
  actor: AuditActor) {
  const { amountSatang, slipNote } = body;
  const slipRef = typeof body.slipRef === "string" ? body.slipRef.trim() : body.slipRef;
  if (typeof amountSatang !== "number" || !Number.isSafeInteger(amountSatang) || amountSatang <= 0 ||
      !bounded(slipRef, 128) || (slipNote !== undefined && (typeof slipNote !== "string" || slipNote.length > 1000))) {
    return json({ error: "invalid_request" }, 400);
  }
  const recorded = await pilotWrite(env, shop.tenant, "/pilot/subscription-payments", {
    amountSatang,
    slipRef,
    ...(slipNote !== undefined ? { slipNote } : {}),
    actor,
  });
  if (recorded.status === 409) return json({ error: "slip_already_recorded" }, 409);
  if (!recorded.ok) return json({ error: "payment_unavailable" }, 503);
  return json(((await recorded.json()) as { payment: SubscriptionPayment }).payment);
}

/// `POST /v1/admin/pilot/gate/cohort` with exactly `{ tenant, counted }`: an operator adds a shop its owner made to the pilot
/// gate's cohort (`counted: true`), or leaves it out again, after speaking with its owner as the pilot's owners were spoken
/// with. Answers `{ tenant, counted }`. A shop an operator made is always counted, so it answers 409 `not_self_serve`.
async function setCohort(env: PilotEnv, shop: PilotShopRecord, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("counted") || typeof body.counted !== "boolean") {
    return json({ error: "invalid_request" }, 400);
  }
  if (!shop.selfServe) return json({ error: "not_self_serve" }, 409);
  const written = await pilotWrite(env, shop.tenant, "/pilot/shop-cohort", { counted: body.counted, actor }).catch(() => null);
  if (!written?.ok) {
    await written?.body?.cancel();
    return written?.status === 409 ? json({ error: "not_self_serve" }, 409) : json({ error: "shop_unavailable" }, 503);
  }
  const { shop: stored } = (await written.json()) as { shop: PilotShopRecord };
  return json({ tenant: shop.tenant, counted: stored.addedToCohortAt !== undefined });
}

/// `GET /v1/admin/pilot/gate`: every pilot shop's trial, payment and activity,
/// and the cohort's two shares against the gate's lines. A shop whose records
/// cannot be read fails the whole answer rather than leaving the cohort: a
/// shop missing from it would move both percentages without anyone seeing why.
async function readGate(env: PilotEnv): Promise<Response> {
  const registry = await authCall(env, "/pilot-shops");
  if (!registry.ok) return json({ error: "gate_unavailable" }, 503);
  const { tenants } = (await registry.json()) as { tenants: string[] };
  const inputs = await Promise.all(tenants.map((tenant) => gateInput(env, tenant))).catch(() => null);
  if (!inputs) return json({ error: "gate_unavailable" }, 503);
  return json(pilotGate(inputs.filter((input) => input !== null), Date.now()));
}

/// One shop's records for the gate, or null for a registry row whose shop was
/// deleted between the two reads.
async function gateInput(env: PilotEnv, tenant: string): Promise<GateShopInput | null> {
  const response = await tenantCall(env, tenant, `/pilot/gate?tenant=${encodeURIComponent(tenant)}`);
  if (!response.ok) throw new Error(`gate_read_${response.status}`);
  const records = (await response.json()) as { shop: PilotShopRecord | null; decisions: string[];
    subscriptionPayments: SubscriptionPayment[] };
  if (!records.shop) return null;
  const legacy = !records.shop.trialStartedAt && Boolean(records.shop.lineConnectionId);
  return {
    tenant,
    name: records.shop.name,
    trialStartedAt: records.shop.trialStartedAt ?? (legacy ? await firstLineConnection(env, tenant) : null),
    decisions: records.decisions,
    subscriptionPayments: records.subscriptionPayments,
    ...(records.shop.selfServe ? { selfServe: true } : {}),
    ...(records.shop.addedToCohortAt ? { addedToCohort: true } : {}),
  };
}

/// The trial start of a shop connected before trial starts were recorded on
/// the shop: its first LINE connection, which the vault still knows even when
/// a later connection revoked it. A connected shop with no such record is
/// never guessed at; the gate answers 503 instead.
async function firstLineConnection(env: PilotEnv, tenant: string): Promise<string> {
  const response = await credStub(env, tenant).fetch(new Request(
    `https://cred/first-connection?tenant=${encodeURIComponent(tenant)}&provider=line`,
    { headers: { "x-tenant": tenant } },
  ));
  if (!response.ok) throw new Error(`first_connection_${response.status}`);
  const { createdAt } = (await response.json()) as { createdAt: unknown };
  if (typeof createdAt !== "string") throw new Error("first_connection_missing");
  return createdAt;
}
