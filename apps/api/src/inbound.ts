/// Inbound Linear webhooks (OFC-22, D-OFC22-inbound-transport). A signed
/// delivery about an issue in a granted project becomes one attention item
/// for the connection's tenant, and nothing else: no task, proposal, run or
/// outbound call starts from here. Anything that leads somewhere — a draft, a
/// reviewed run — begins later from a person acting on the item, under the
/// approvals that already guard that work.
///
/// The route is public, so every answer is built to say as little as
/// possible. Refusals carry no body. Every signed delivery that ends without
/// a new item (a duplicate, an unknown workspace, a project outside the
/// grant, an event kind we do not take) answers the same empty 200 as one
/// that stored an item, so nothing about tenants or grants can be read back
/// from the responses. The payload is read only for the few fields the item
/// keeps; the issue title, description and the rest of the body are never
/// stored or logged.

import { authCall, credStub, tenantCall, type TenantDataEnv } from "./tenant-data";
import { readBodyBytes } from "./body";

export type InboundEnv = Pick<TenantDataEnv, "AUTH" | "CRED" | "TENANT"> & {
  /// The Linear webhook signing secret (`wrangler secret put
  /// LINEAR_WEBHOOK_SECRET`). Never in source or wrangler.jsonc. Without it,
  /// every delivery is refused as unsigned.
  LINEAR_WEBHOOK_SECRET?: string;
};

/// What one delivery leaves behind. Ids and the event kind only, so the
/// item says that something changed and where, never what it says.
export type AttentionItem = {
  id: string;
  connectionId: string;
  eventType: string;
  issueId: string;
  receivedAt: string;
};

/// Linear's own recommendation for `webhookTimestamp`: within a minute of
/// receipt. The timestamp sits inside the signed body, so a captured delivery
/// can be replayed only inside this window, where the delivery-id record in
/// the tenant object catches it.
export const INBOUND_TIMESTAMP_TOLERANCE_MS = 60_000;

/// Same ceiling as every other body the Worker accepts.
export const MAX_INBOUND_BODY_BYTES = 256 * 1024;

/// The event kinds that may become an item: issue changes only. An issue
/// payload names its project, which is what the grant is checked against;
/// comments and every other kind do not, so they cannot be shown to fall
/// inside the grant and are dropped.
const ISSUE_ACTIONS = new Set(["create", "update", "remove"]);

const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;
const SIGNATURE = /^[0-9a-fA-F]{64}$/;

function empty(status: number): Response {
  return new Response(null, { status });
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/// Checks `Linear-Signature`: the hex HMAC-SHA256 of the raw body under the
/// signing secret. `crypto.subtle.verify` compares in constant time, so a
/// forger learns nothing from how long a refusal takes. A missing secret,
/// header or well-formed digest fails closed.
export async function verifyLinearSignature(
  secret: string | undefined,
  raw: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header || !SIGNATURE.test(header)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexBytes(header), raw);
}

/// The item's event kind for a Linear `type` and `action`, or null for a
/// kind this route does not take.
export function linearEventType(type: unknown, action: unknown): string | null {
  if (type !== "Issue" || typeof action !== "string" || !ISSUE_ACTIONS.has(action)) return null;
  return `linear.issue.${action}`;
}

type ConnectionMeta = { provider?: unknown; accountId?: unknown; resourceIds?: unknown };

/// Finds the one connection a delivery about `projectId` belongs to. The
/// route index in AuthObject only says which tenant vaults to ask; the
/// vault's own metadata decides, so a revoked or wiped connection, or one
/// whose account no longer matches, never receives an item. The grant is
/// checked per candidate, so when two connections share a workspace, an
/// event in a project only the older one was granted still reaches it
/// instead of being dropped because a newer connection was granted other
/// projects. The newest connection that is live and granted the project
/// wins, which keeps a delivery to at most one item. An issue with no
/// project, or one no grant covers, matches nothing, and an empty grant
/// covers nothing. A vault that cannot answer returns a Response so Linear
/// retries rather than losing the event.
async function resolveConnection(
  env: InboundEnv,
  organizationId: string,
  projectId: string,
): Promise<{ tenant: string; connectionId: string } | null | Response> {
  const indexed = await authCall(
    env,
    `/inbound-routes?provider=linear&account=${encodeURIComponent(organizationId)}`,
  );
  if (!indexed.ok) return empty(503);
  const listed = (await indexed.json().catch(() => null)) as {
    routes?: { tenant?: unknown; connectionId?: unknown }[];
  } | null;
  for (const route of listed?.routes ?? []) {
    if (!boundedId(route.tenant) || !boundedId(route.connectionId)) continue;
    const headers = new Headers();
    headers.set("x-tenant", route.tenant);
    const read = await credStub(env, route.tenant).fetch(
      new Request(`https://cred/connections/${encodeURIComponent(route.connectionId)}`, { headers }),
    );
    if (read.status === 404) continue;
    if (!read.ok) return empty(503);
    const meta = (await read.json().catch(() => null)) as ConnectionMeta | null;
    if (meta?.provider !== "linear" || meta.accountId !== organizationId) continue;
    const resourceIds = Array.isArray(meta.resourceIds) ? meta.resourceIds.filter(boundedId) : [];
    if (!resourceIds.includes(projectId)) continue;
    return { tenant: route.tenant, connectionId: route.connectionId };
  }
  return null;
}

/// `POST /v1/inbound/linear`, once the Worker has checked `officeInbound`.
/// Order matters: nothing in the body is trusted, or even parsed, before the
/// signature holds, and nothing is stored before the timestamp, the delivery
/// id, the connection and the grant all check out.
export async function receiveLinearWebhook(request: Request, env: InboundEnv, nowMs: number): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_INBOUND_BODY_BYTES) return empty(413);
  const body = await readBodyBytes(request, MAX_INBOUND_BODY_BYTES);
  if (!body.ok) return empty(body.status);
  const raw = body.value;
  if (!(await verifyLinearSignature(env.LINEAR_WEBHOOK_SECRET, raw, request.headers.get("linear-signature")))) {
    return empty(401);
  }
  let payload: {
    type?: unknown;
    action?: unknown;
    organizationId?: unknown;
    webhookTimestamp?: unknown;
    data?: { id?: unknown; projectId?: unknown } | null;
  };
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
  } catch {
    return empty(400);
  }
  if (payload === null || typeof payload !== "object") return empty(400);
  // A stale signed body is a replay, refused like a bad signature.
  const sentAt = payload.webhookTimestamp;
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return empty(401);
  if (Math.abs(nowMs - sentAt) > INBOUND_TIMESTAMP_TOLERANCE_MS) return empty(401);
  // Without a delivery id there is nothing to deduplicate on, so the
  // delivery cannot be taken at most once.
  const deliveryId = request.headers.get("linear-delivery") ?? "";
  if (!DELIVERY_ID.test(deliveryId)) return empty(400);

  // From here on, every outcome that stores nothing answers like a stored
  // or duplicate delivery: the same empty 200.
  const eventType = linearEventType(payload.type, payload.action);
  if (!eventType || !boundedId(payload.organizationId)) return empty(200);
  const issueId = payload.data?.id;
  const projectId = payload.data?.projectId;
  // The grant decides what a tenant hears about. An issue with no project
  // cannot be shown to fall inside any grant, so it reports nothing.
  if (!boundedId(issueId) || !boundedId(projectId)) return empty(200);

  const resolved = await resolveConnection(env, payload.organizationId, projectId);
  if (resolved instanceof Response) return resolved;
  if (!resolved) return empty(200);

  const recorded = await tenantCall(env, resolved.tenant, "/attention", {
    method: "POST",
    headers: { "content-type": "application/json", "x-inbound": "1" },
    body: JSON.stringify({
      tenant: resolved.tenant,
      deliveryId,
      connectionId: resolved.connectionId,
      eventType,
      issueId,
    }),
  });
  // A failed write answers 503 so Linear retries; the delivery-id record
  // makes that retry safe.
  return empty(recorded.ok ? 200 : 503);
}
