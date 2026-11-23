/// Pilot records (docs/pilot-api.md), stored in the objects that already own
/// each concern so the existing boundaries hold without a new object class:
///
/// - Per shop, in that shop's TenantObject (`t:${tenant}`): the shop profile,
///   inbound customer messages with their deduplication markers, cached LINE
///   display names, reply records binding each proposed reply to the message
///   it answers, and payments. Tenant export reads them, tenant deletion wipes
///   them with the rest of the tenant object, and the retention sweep ages
///   customer messages out after the source-snapshot window.
/// - Globally, in AuthObject: one registry row per pilot shop, so the
///   operator console can list shops. The row names only the tenant and goes
///   with the tenant's other global rows when the tenant is deleted.
///
/// Only the Worker reaches these paths. Writes additionally require the
/// `x-pilot` (or, for the registry, `x-admin`) header the Worker sets, the
/// same defence in depth as `x-inbound` and `x-wipe`. Every key embeds the
/// URI-encoded tenant, like the object's other keys, so no prefix scan can
/// reach another tenant's rows.

import { readJsonBody } from "./body";
import { LINE_USER_ID } from "./connectors/line";
import { isExpired, RETENTION } from "./retention";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

const MAX_BODY_BYTES = 256 * 1024;
/// Lists the console reads. Export always reads everything.
const MAX_LISTED_MESSAGES = 500;
const MAX_LISTED_REPLIES = 200;
const MAX_LISTED_PAYMENTS = 500;
/// Durable Object storage takes at most 128 keys per put or delete call.
const STORAGE_BATCH = 128;
/// Events one delivery may carry. LINE batches a handful; the body limit
/// already bounds this, and the cap keeps one call's work bounded too.
const MAX_EVENTS_PER_CALL = 1000;

export type PilotShopRecord = {
  tenant: string;
  name: string;
  ownerName: string;
  /// The one task every reply for this shop is proposed on. Its id is fixed
  /// at shop creation; the task itself is created with the first reply.
  taskId: string;
  lineConnectionId?: string;
  createdAt: string;
};

export type InboundMessage = {
  id: string;
  connectionId: string;
  lineUserId: string;
  displayName?: string;
  text: string;
  receivedAt: string;
  replyActionId?: string;
};

/// Binds one proposed reply to the message it answers. Author and connection
/// are copied from the stored message when the record is written, never from
/// the request, so the broker can check before sending that the reply goes
/// to the person who wrote, through the connection they wrote to.
export type PilotReplyRecord = {
  taskId: string;
  actionId: string;
  messageId: string;
  connectionId: string;
  lineUserId: string;
  proposedAt: string;
  expiresAt: string;
  /// When the owner's link decided it. The task object stamps approvals but
  /// not rejections, so the link route records both here.
  decidedAt?: string;
};

export type Payment = {
  id: string;
  tenant: string;
  orderRef: string;
  amountSatang: number;
  promptPayId: string;
  slipNote?: string;
  confirmedAt: string;
};

type NameRecord = { displayName: string; at: number };
type EventMarker = { messageId: string; at: number };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function bounded(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

const enc = encodeURIComponent;
const keys = {
  shop: (tenant: string) => `pilot-shop:${enc(tenant)}`,
  messages: (tenant: string) => `pilot-msg:${enc(tenant)}:`,
  message: (tenant: string, id: string) => `pilot-msg:${enc(tenant)}:${id}`,
  events: (tenant: string) => `pilot-line-event:${enc(tenant)}:`,
  event: (tenant: string, eventId: string) => `pilot-line-event:${enc(tenant)}:${eventId}`,
  names: (tenant: string) => `pilot-name:${enc(tenant)}:`,
  name: (tenant: string, lineUserId: string) => `pilot-name:${enc(tenant)}:${lineUserId}`,
  replies: (tenant: string) => `pilot-reply:${enc(tenant)}:`,
  reply: (tenant: string, actionId: string) => `pilot-reply:${enc(tenant)}:${enc(actionId)}`,
  payments: (tenant: string) => `pilot-pay:${enc(tenant)}:`,
  payment: (tenant: string, id: string) => `pilot-pay:${enc(tenant)}:${id}`,
};

/// Ids that sort by creation time: a fixed-width base-36 millisecond clock,
/// a sequence within the call, then randomness. Lists read newest first by
/// walking keys backwards instead of loading and sorting everything.
function sortableId(prefix: string, ms: number, seq: number): string {
  return `${prefix}-${ms.toString(36).padStart(9, "0")}-${seq.toString(36).padStart(3, "0")}-${crypto.randomUUID().slice(0, 8)}`;
}

async function putAll(storage: DurableObjectStorage, entries: [string, unknown][]): Promise<void> {
  for (let i = 0; i < entries.length; i += STORAGE_BATCH) {
    await storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
  }
}

async function deleteAll(storage: DurableObjectStorage, list: string[]): Promise<void> {
  for (let i = 0; i < list.length; i += STORAGE_BATCH) {
    await storage.delete(list.slice(i, i + STORAGE_BATCH));
  }
}

async function values<T>(storage: DurableObjectStorage, prefix: string, options: { reverse?: boolean; limit?: number } = {}) {
  return [...(await storage.list<T>({ prefix, ...options })).values()];
}

/// `/pilot/*` on a TenantObject. Reads need only the tenant; writes need the
/// Worker's `x-pilot` header as well.
export async function pilotTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!bounded(tenant)) return json({ error: "invalid_request" }, 400);
    switch (route) {
      case "GET /pilot/shop": {
        const shop = await storage.get<PilotShopRecord>(keys.shop(tenant));
        return shop ? json({ shop }) : json({ error: "not_found" }, 404);
      }
      case "GET /pilot/messages":
        return json({
          messages: await values<InboundMessage>(storage, keys.messages(tenant), { reverse: true, limit: MAX_LISTED_MESSAGES }),
        });
      case "GET /pilot/message": {
        const id = url.searchParams.get("id") ?? "";
        const message = bounded(id, 128) ? await storage.get<InboundMessage>(keys.message(tenant, id)) : undefined;
        return message ? json({ message }) : json({ error: "not_found" }, 404);
      }
      case "GET /pilot/reply": {
        const actionId = url.searchParams.get("actionId") ?? "";
        const reply = bounded(actionId) ? await storage.get<PilotReplyRecord>(keys.reply(tenant, actionId)) : undefined;
        return reply ? json({ reply }) : json({ error: "not_found" }, 404);
      }
      case "GET /pilot/replies": {
        const replies = await values<PilotReplyRecord>(storage, keys.replies(tenant));
        replies.sort((a, b) => (a.proposedAt < b.proposedAt ? 1 : a.proposedAt > b.proposedAt ? -1 : 0));
        return json({ replies: replies.slice(0, MAX_LISTED_REPLIES) });
      }
      case "GET /pilot/context":
        return readContext(storage, tenant, url.searchParams.get("actionId") ?? "");
      case "GET /pilot/payments":
        return json({
          payments: await values<Payment>(storage, keys.payments(tenant), { reverse: true, limit: MAX_LISTED_PAYMENTS }),
        });
      case "GET /pilot/export":
        return json(await exportPilot(storage, tenant));
    }
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-pilot") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body) || !bounded(body.tenant)) {
    return json({ error: "invalid_request" }, 400);
  }
  const tenant = body.tenant;
  switch (route) {
    case "POST /pilot/shop":
      return createShop(storage, tenant, body);
    case "POST /pilot/shop-connection":
      return setShopConnection(storage, tenant, body);
    case "POST /pilot/messages":
      return storeMessages(storage, tenant, body);
    case "POST /pilot/names":
      return recordName(storage, tenant, body);
    case "POST /pilot/replies":
      return recordReply(storage, tenant, body);
    case "POST /pilot/reply-decided":
      return recordDecided(storage, tenant, body);
    case "POST /pilot/payments":
      return recordPayment(storage, tenant, body);
    case "POST /pilot/prune":
      return pruneMessages(storage, tenant, body);
  }
  return json({ error: "not_found" }, 404);
}

async function createShop(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.name, 200) || !bounded(body.ownerName, 200) || !bounded(body.taskId)) {
    return json({ error: "invalid_request" }, 400);
  }
  if (await storage.get(keys.shop(tenant))) return json({ error: "already_exists" }, 409);
  const shop: PilotShopRecord = {
    tenant,
    name: body.name,
    ownerName: body.ownerName,
    taskId: body.taskId,
    createdAt: new Date().toISOString(),
  };
  await storage.put(keys.shop(tenant), shop);
  return json({ shop });
}

/// Points the shop at its LINE connection and answers with the one it
/// replaced, which the Worker then revokes.
async function setShopConnection(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.lineConnectionId)) return json({ error: "invalid_request" }, 400);
  const shop = await storage.get<PilotShopRecord>(keys.shop(tenant));
  if (!shop) return json({ error: "not_found" }, 404);
  await storage.put(keys.shop(tenant), { ...shop, lineConnectionId: body.lineConnectionId });
  return json({ previous: shop.lineConnectionId ?? null });
}

/// Stores the text messages of one verified delivery. `webhookEventId` is the
/// idempotency key: LINE's redelivery of an event finds its marker and stores
/// nothing. The object's input gate holds other requests while these reads
/// and writes are in flight, so two copies of one delivery cannot both store.
/// Answers which messages are new and whether their author's name is known,
/// so the Worker looks up only names it does not have.
type IncomingEvent = { webhookEventId: string; lineUserId: string; text: string };

function isIncomingEvent(value: unknown): value is IncomingEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    bounded(event.webhookEventId, 128) &&
    typeof event.lineUserId === "string" &&
    LINE_USER_ID.test(event.lineUserId) &&
    typeof event.text === "string" &&
    event.text.length > 0
  );
}

async function storeMessages(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const events = body.events;
  if (!bounded(body.connectionId) || !Array.isArray(events) || events.length > MAX_EVENTS_PER_CALL ||
      !events.every(isIncomingEvent)) {
    return json({ error: "invalid_request" }, 400);
  }
  const now = Date.now();
  const receivedAt = new Date(now).toISOString();
  const seen = new Set<string>();
  const created: { id: string; lineUserId: string; named: boolean }[] = [];
  const entries: [string, unknown][] = [];
  for (const [index, event] of events.entries()) {
    const marker = keys.event(tenant, event.webhookEventId);
    if (seen.has(marker) || (await storage.get(marker)) !== undefined) continue;
    seen.add(marker);
    const name = await storage.get<NameRecord>(keys.name(tenant, event.lineUserId));
    const message: InboundMessage = {
      id: sortableId("msg", now, index),
      connectionId: body.connectionId,
      lineUserId: event.lineUserId,
      ...(name ? { displayName: name.displayName } : {}),
      text: event.text,
      receivedAt,
    };
    // A message and its marker land in the same batch, so a crash can never
    // leave a marker whose message was lost.
    entries.push([keys.message(tenant, message.id), message], [marker, { messageId: message.id, at: now } satisfies EventMarker]);
    created.push({ id: message.id, lineUserId: message.lineUserId, named: Boolean(name) });
  }
  await putAll(storage, entries);
  return json({ created });
}

/// Remembers a customer's display name and fills it in on their recent
/// messages that arrived before it was known.
async function recordName(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { lineUserId, displayName } = body;
  if (typeof lineUserId !== "string" || !LINE_USER_ID.test(lineUserId) || !bounded(displayName)) {
    return json({ error: "invalid_request" }, 400);
  }
  const entries: [string, unknown][] = [[keys.name(tenant, lineUserId), { displayName, at: Date.now() } satisfies NameRecord]];
  for (const message of await values<InboundMessage>(storage, keys.messages(tenant), { reverse: true, limit: MAX_LISTED_MESSAGES })) {
    if (message.lineUserId === lineUserId && message.displayName === undefined) {
      entries.push([keys.message(tenant, message.id), { ...message, displayName }]);
    }
  }
  await putAll(storage, entries);
  return json({ updated: entries.length - 1 });
}

/// Writes the reply record and marks the message answered, in one put. The
/// caller says which reply it saw on the message (`expectedReplyActionId`);
/// if another reply landed in between, this refuses rather than letting two
/// open replies answer one message.
async function recordReply(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { taskId, actionId, messageId, proposedAt, expiresAt, expectedReplyActionId } = body;
  if (!bounded(taskId) || !bounded(actionId) || !bounded(messageId, 128) || !bounded(proposedAt, 64) ||
      !bounded(expiresAt, 64) || (expectedReplyActionId !== null && !bounded(expectedReplyActionId))) {
    return json({ error: "invalid_request" }, 400);
  }
  const message = await storage.get<InboundMessage>(keys.message(tenant, messageId));
  if (!message) return json({ error: "message_not_found" }, 404);
  if ((message.replyActionId ?? null) !== expectedReplyActionId) return json({ error: "reply_pending" }, 409);
  const reply: PilotReplyRecord = {
    taskId,
    actionId,
    messageId,
    connectionId: message.connectionId,
    lineUserId: message.lineUserId,
    proposedAt,
    expiresAt,
  };
  await storage.put({
    [keys.reply(tenant, actionId)]: reply,
    [keys.message(tenant, messageId)]: { ...message, replyActionId: actionId },
  });
  return json({ reply });
}

/// First decision time wins; a later call never moves it.
async function recordDecided(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.actionId) || !bounded(body.decidedAt, 64)) return json({ error: "invalid_request" }, 400);
  const reply = await storage.get<PilotReplyRecord>(keys.reply(tenant, body.actionId));
  if (!reply) return json({ error: "not_found" }, 404);
  if (reply.decidedAt === undefined) {
    await storage.put(keys.reply(tenant, body.actionId), { ...reply, decidedAt: body.decidedAt });
  }
  return json({ recorded: true });
}

async function recordPayment(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { orderRef, amountSatang, promptPayId, slipNote } = body;
  if (!bounded(orderRef, 128) || !bounded(promptPayId, 64) || typeof amountSatang !== "number" ||
      !Number.isSafeInteger(amountSatang) || amountSatang <= 0 ||
      (slipNote !== undefined && (typeof slipNote !== "string" || slipNote.length > 1000))) {
    return json({ error: "invalid_request" }, 400);
  }
  const now = Date.now();
  const payment: Payment = {
    id: sortableId("pay", now, 0),
    tenant,
    orderRef,
    amountSatang,
    promptPayId,
    ...(typeof slipNote === "string" && slipNote.length > 0 ? { slipNote } : {}),
    confirmedAt: new Date(now).toISOString(),
  };
  await storage.put(keys.payment(tenant, payment.id), payment);
  return json({ payment });
}

/// Everything a link view needs in one read: the shop, the reply record, and
/// the message it answers. Any of them may be missing.
async function readContext(storage: DurableObjectStorage, tenant: string, actionId: string) {
  if (!bounded(actionId)) return json({ error: "invalid_request" }, 400);
  const [shop, reply] = await Promise.all([
    storage.get<PilotShopRecord>(keys.shop(tenant)),
    storage.get<PilotReplyRecord>(keys.reply(tenant, actionId)),
  ]);
  const message = reply ? await storage.get<InboundMessage>(keys.message(tenant, reply.messageId)) : undefined;
  return json({ shop: shop ?? null, reply: reply ?? null, message: message ?? null });
}

async function exportPilot(storage: DurableObjectStorage, tenant: string) {
  const names = await storage.list<NameRecord>({ prefix: keys.names(tenant) });
  return {
    shop: (await storage.get<PilotShopRecord>(keys.shop(tenant))) ?? null,
    messages: await values<InboundMessage>(storage, keys.messages(tenant)),
    replies: await values<PilotReplyRecord>(storage, keys.replies(tenant)),
    payments: await values<Payment>(storage, keys.payments(tenant)),
    displayNames: [...names].map(([key, record]) => ({
      lineUserId: key.slice(keys.names(tenant).length),
      displayName: record.displayName,
    })),
  };
}

/// Customer messages are source snapshots in the retention policy
/// (`RETENTION.sourceSnapshotDays`, 7 days): the operator needs a message
/// only long enough to answer it, and its link lives 24 hours. Their
/// redelivery markers and cached display names age out on the same clock.
/// Shop profiles, reply records (ids only) and payments stay until the
/// tenant is deleted. The clock comes from the Worker's sweep; an unusable
/// value falls back to the server clock and one ahead of it is clamped to
/// it, so no caller can age a message out early.
async function pruneMessages(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const nowMs = typeof body.nowMs === "number" && Number.isFinite(body.nowMs) ? Math.min(body.nowMs, Date.now()) : Date.now();
  const days = RETENTION.sourceSnapshotDays;
  const expired: string[] = [];
  let messagesPruned = 0;
  for (const [key, message] of await storage.list<InboundMessage>({ prefix: keys.messages(tenant) })) {
    const at = Date.parse(message.receivedAt);
    if (Number.isFinite(at) && isExpired(nowMs, at, days)) {
      expired.push(key);
      messagesPruned++;
    }
  }
  for (const [key, marker] of await storage.list<EventMarker>({ prefix: keys.events(tenant) })) {
    if (isExpired(nowMs, marker.at, days)) expired.push(key);
  }
  for (const [key, name] of await storage.list<NameRecord>({ prefix: keys.names(tenant) })) {
    if (isExpired(nowMs, name.at, days)) expired.push(key);
  }
  await deleteAll(storage, expired);
  return json({ messagesPruned });
}

/// Part of the TenantObject's tenant wipe: every pilot row for the tenant.
export async function wipePilotTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const doomed: string[] = [keys.shop(tenant)];
  for (const prefix of [keys.messages(tenant), keys.events(tenant), keys.names(tenant), keys.replies(tenant), keys.payments(tenant)]) {
    doomed.push(...(await storage.list({ prefix })).keys());
  }
  await deleteAll(storage, doomed);
}

/// The AuthObject registry row for a pilot shop.
export function pilotRegistryKey(tenant: string): string {
  return `pilot-registry:${enc(tenant)}`;
}

/// `/pilot-shops` on AuthObject: list the pilot tenants, or add one. Adding
/// needs the Worker's `x-admin` header, like the other global index writes.
export async function pilotRegistryRoute(storage: DurableObjectStorage, request: Request): Promise<Response> {
  if (request.method === "GET") {
    const rows = await values<{ tenant: string; createdAt: string }>(storage, "pilot-registry:");
    rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return json({ tenants: rows.map((row) => row.tenant) });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-admin") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<{ tenant?: unknown }>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!bounded(parsed.value?.tenant)) return json({ error: "invalid_request" }, 400);
  await storage.put(pilotRegistryKey(parsed.value.tenant), { tenant: parsed.value.tenant, createdAt: new Date().toISOString() });
  return json({ registered: true });
}

/// The broker's view of a reply: which message, author and connection the
/// owner's approval answers. Null when there is no record, which the broker
/// treats as a reply nothing authorized.
export async function readReplyBinding(
  env: Pick<TenantDataEnv, "TENANT">,
  tenant: string,
  actionId: string,
): Promise<PilotReplyRecord | null> {
  const response = await tenantCall(
    env,
    tenant,
    `/pilot/reply?tenant=${encodeURIComponent(tenant)}&actionId=${encodeURIComponent(actionId)}`,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { reply?: PilotReplyRecord } | null;
  return body?.reply ?? null;
}
