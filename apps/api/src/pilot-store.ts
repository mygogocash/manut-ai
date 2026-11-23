/// Pilot records (docs/pilot-api.md), stored in the objects that already own
/// each concern so the existing boundaries hold without a new object class:
///
/// - Per shop, in that shop's TenantObject (`t:${tenant}`): the shop profile,
///   inbound customer messages with their deduplication markers, cached LINE
///   display names, reply records binding each proposed reply to the message
///   it answers, customers' order payments, and the shop's own subscription
///   payments to Manut AI. Tenant export reads them, tenant deletion wipes
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

import {
  decideTransition,
  openTransition,
  requestStanding,
  ROLES,
  withdrawTransition,
  type ApprovalOption,
  type ApprovalRecord,
  type DecideResult,
  type Role,
} from "@manut/approval-core";
import { DELETION_LINK_TTL_MS } from "./approval-link";
import { actorOr, auditPut, type AuditActor, type AuditRecord } from "./audit-log";
import { readJsonBody } from "./body";
import { LINE_USER_ID } from "./connectors/line";
import { bangkokDay } from "./pilot-gate";
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
  /// When the shop's free trial started: its first LINE connection (pilot-gate.ts). Set once, by the connection
  /// that first points the shop at LINE, and never moved by a later one. A shop connected before this field
  /// existed has none, and the gate reads its first connection's time from the vault.
  trialStartedAt?: string;
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

/// The shop's own payment to Manut AI for its subscription, recorded by an operator once the money is seen in
/// Manut AI's bank account, as order payments are checked in the shop's. Nothing is charged or moved here.
/// `slipRef` is the reference printed on the bank slip: every record names the slip it was checked against, and
/// one slip is recorded once, so two halves of the price can never be counted as a whole by recording one twice.
export type SubscriptionPayment = {
  id: string;
  tenant: string;
  amountSatang: number;
  slipRef: string;
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
  subscriptions: (tenant: string) => `pilot-sub:${enc(tenant)}:`,
  subscription: (tenant: string, id: string) => `pilot-sub:${enc(tenant)}:${id}`,
};

/// The last clock and sequence an id was issued with, in this isolate.
let lastIssued = { ms: 0, seq: -1 };

/// Ids that sort by creation time: a fixed-width base-36 millisecond clock,
/// a sequence, then randomness. Lists read newest first by walking keys
/// backwards instead of loading and sorting everything, so ids must sort in
/// the order they were made. Two calls in the same millisecond (Workers'
/// clock only moves on I/O), or a clock that steps back, continue from the
/// last id issued instead of letting the random tail decide their order.
/// `seq` orders several ids made in one call (one webhook's messages).
export function sortableId(prefix: string, ms: number, seq: number): string {
  let issued = { ms, seq };
  if (ms < lastIssued.ms || (ms === lastIssued.ms && seq <= lastIssued.seq)) {
    issued = { ms: lastIssued.ms, seq: lastIssued.seq + 1 };
  }
  lastIssued = issued;
  return `${prefix}-${issued.ms.toString(36).padStart(9, "0")}-${issued.seq.toString(36).padStart(3, "0")}-${crypto.randomUUID().slice(0, 8)}`;
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

/// The audit entry a write records, in the same put as the record it describes (audit-log.ts), by the actor the
/// Worker named: the operator's Access identity for the console's writes, the owner for the owner's link. A write
/// that names nobody is the system's. An actor the log cannot keep becomes a counted miss rather than a wrong name.
function audited(storage: DurableObjectStorage, tenant: string, actor: unknown, fallback: AuditActor,
  record: Omit<AuditRecord, "actor">): Promise<Record<string, unknown>> {
  const who = actorOr(actor, fallback);
  return auditPut(storage, tenant, who ? { ...record, actor: who } : null, record.action);
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
      case "GET /pilot/summary":
        return readSummary(storage, tenant);
      case "GET /pilot/payments":
        return json({
          payments: await values<Payment>(storage, keys.payments(tenant), { reverse: true, limit: MAX_LISTED_PAYMENTS }),
        });
      case "GET /pilot/subscription-payments":
        return json({
          payments: await values<SubscriptionPayment>(storage, keys.subscriptions(tenant), { reverse: true,
            limit: MAX_LISTED_PAYMENTS }),
        });
      case "GET /pilot/gate":
        return readGateRecords(storage, tenant);
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
    case "POST /pilot/subscription-payments":
      return recordSubscriptionPayment(storage, tenant, body);
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
  await storage.put({
    [keys.shop(tenant)]: shop,
    ...(await audited(storage, tenant, body.actor, { kind: "system" }, { action: "shop.created", subject: {},
      outcome: "ok" })),
  });
  return json({ shop });
}

/// Points the shop at its LINE connection and answers with the one it
/// replaced, which the Worker then revokes.
///
/// The shop's first connection starts its free trial (pilot-gate.ts): it is
/// when the service can start working for the shop, so days spent setting a
/// shop up before its LINE account is connected never count against it. A
/// later connection (a rotated token) never moves the start. A shop that was
/// connected before trial starts were recorded is left without one here
/// rather than given this connection's time; the gate reads its first
/// connection's time from the vault instead.
async function setShopConnection(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.lineConnectionId)) return json({ error: "invalid_request" }, 400);
  const shop = await storage.get<PilotShopRecord>(keys.shop(tenant));
  if (!shop) return json({ error: "not_found" }, 404);
  const first = shop.trialStartedAt === undefined && shop.lineConnectionId === undefined;
  const replaced = shop.lineConnectionId !== undefined && shop.lineConnectionId !== body.lineConnectionId;
  await storage.put({
    [keys.shop(tenant)]: {
      ...shop,
      lineConnectionId: body.lineConnectionId,
      ...(first ? { trialStartedAt: new Date().toISOString() } : {}),
    },
    ...(await audited(storage, tenant, body.actor, { kind: "system" }, {
      action: "line.connected",
      subject: { connectionId: body.lineConnectionId, ...(replaced ? { previousConnectionId: shop.lineConnectionId } : {}) },
      outcome: "ok",
    })),
  });
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
    ...(await audited(storage, tenant, body.actor, { kind: "system" }, { action: "reply.proposed",
      subject: { taskId, actionId, messageId }, outcome: "ok" })),
  });
  return json({ reply });
}

/// First decision time wins; a later call never moves it. The owner's decision is written to the audit log with
/// it, once, when it is first recorded: `approve` says which way the owner decided.
async function recordDecided(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  if (!bounded(body.actionId) || !bounded(body.decidedAt, 64)) return json({ error: "invalid_request" }, 400);
  const reply = await storage.get<PilotReplyRecord>(keys.reply(tenant, body.actionId));
  if (!reply) return json({ error: "not_found" }, 404);
  if (reply.decidedAt === undefined) {
    const outcome = body.approve === true ? "approved" : body.approve === false ? "declined" : "ok";
    await storage.put({
      [keys.reply(tenant, body.actionId)]: { ...reply, decidedAt: body.decidedAt },
      ...(await audited(storage, tenant, body.actor, { kind: "owner" }, { action: "reply.decided",
        subject: { taskId: reply.taskId, actionId: body.actionId }, outcome })),
    });
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
  await storage.put({
    [keys.payment(tenant, payment.id)]: payment,
    ...(await audited(storage, tenant, body.actor, { kind: "system" }, { action: "payment.recorded",
      subject: { paymentId: payment.id }, outcome: "ok", amountSatang })),
  });
  return json({ payment });
}

/// The same slip however its reference was typed: spaces and capitals aside.
function sameSlip(a: string, b: string): boolean {
  const plain = (ref: string) => ref.replace(/\s+/g, "").toUpperCase();
  return plain(a) === plain(b);
}

/// Records one subscription payment, refusing a slip already recorded for the
/// shop. The object's input gate holds other requests while this read and
/// write are in flight, so two copies of one slip cannot both be stored.
async function recordSubscriptionPayment(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { amountSatang, slipRef, slipNote } = body;
  if (typeof amountSatang !== "number" || !Number.isSafeInteger(amountSatang) || amountSatang <= 0 ||
      !bounded(slipRef, 128) || (slipNote !== undefined && (typeof slipNote !== "string" || slipNote.length > 1000))) {
    return json({ error: "invalid_request" }, 400);
  }
  for (const recorded of await values<SubscriptionPayment>(storage, keys.subscriptions(tenant))) {
    if (sameSlip(recorded.slipRef, slipRef)) return json({ error: "slip_already_recorded" }, 409);
  }
  const now = Date.now();
  const payment: SubscriptionPayment = {
    id: sortableId("sub", now, 0),
    tenant,
    amountSatang,
    slipRef,
    ...(typeof slipNote === "string" && slipNote.length > 0 ? { slipNote } : {}),
    confirmedAt: new Date(now).toISOString(),
  };
  await storage.put({
    [keys.subscription(tenant, payment.id)]: payment,
    ...(await audited(storage, tenant, body.actor, { kind: "system" }, { action: "subscription_payment.recorded",
      subject: { paymentId: payment.id }, outcome: "ok", amountSatang })),
  });
  return json({ payment });
}

/// What the pilot gate reads for the shop (pilot-gate.ts): the shop with its
/// trial start, when its owner decided replies, and its subscription
/// payments. Every reply record is read, not the console's newest 200, so a
/// busy shop's day-14 decisions never fall out of the count. Only the latest
/// decision of each Bangkok calendar day is answered: whether a day holds a
/// decision, and when the latest one was, is all the gate asks, and one time
/// a day keeps the answer small however many replies the shop has.
async function readGateRecords(storage: DurableObjectStorage, tenant: string) {
  const latestOfDay = new Map<number, { at: string; ms: number }>();
  for (const { decidedAt } of await values<PilotReplyRecord>(storage, keys.replies(tenant))) {
    if (decidedAt === undefined) continue;
    const ms = Date.parse(decidedAt);
    if (!Number.isFinite(ms)) continue;
    const day = bangkokDay(ms);
    const kept = latestOfDay.get(day);
    if (!kept || ms > kept.ms) latestOfDay.set(day, { at: decidedAt, ms });
  }
  return json({
    shop: (await storage.get<PilotShopRecord>(keys.shop(tenant))) ?? null,
    decisions: [...latestOfDay.values()].sort((a, b) => a.ms - b.ms).map((decision) => decision.at),
    subscriptionPayments: await values<SubscriptionPayment>(storage, keys.subscriptions(tenant)),
  });
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

/// What a deletion of the shop would take, counted now: the shop itself (null once it is gone), and how many
/// customer messages, reply records and payment records it holds. The owner's deletion page shows these. Payment
/// records are both ledgers, customers' order payments and the shop's own subscription payments, because the
/// deletion takes both.
async function readSummary(storage: DurableObjectStorage, tenant: string) {
  const count = async (prefix: string) => (await storage.list({ prefix })).size;
  return json({
    shop: (await storage.get<PilotShopRecord>(keys.shop(tenant))) ?? null,
    messages: await count(keys.messages(tenant)),
    replies: await count(keys.replies(tenant)),
    payments: (await count(keys.payments(tenant))) + (await count(keys.subscriptions(tenant))),
  });
}

async function exportPilot(storage: DurableObjectStorage, tenant: string) {
  const names = await storage.list<NameRecord>({ prefix: keys.names(tenant) });
  return {
    shop: (await storage.get<PilotShopRecord>(keys.shop(tenant))) ?? null,
    messages: await values<InboundMessage>(storage, keys.messages(tenant)),
    replies: await values<PilotReplyRecord>(storage, keys.replies(tenant)),
    payments: await values<Payment>(storage, keys.payments(tenant)),
    subscriptionPayments: await values<SubscriptionPayment>(storage, keys.subscriptions(tenant)),
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
/// Shop profiles, reply records (ids only) and both kinds of payment stay
/// until the tenant is deleted. The clock comes from the Worker's sweep; an unusable
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
  for (const prefix of [keys.messages(tenant), keys.events(tenant), keys.names(tenant), keys.replies(tenant),
    keys.payments(tenant), keys.subscriptions(tenant)]) {
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

/// One pilot shop's deletion, kept by AuthObject apart from the shop's own
/// objects so it outlives them: whose request it was (`deletedBy`: the
/// operator's Access identity, when Access gives one), when it was asked for,
/// and once the wipe finished, when and what it removed. Operators share one
/// bearer key, so the Access identity is the only name an operator can be
/// known by. For a live shop the record is written when the operator asks,
/// together with the owner confirmation it names (`confirmationId`), and the
/// wipe waits for the owner's answer.
export type PilotDeletionRecord = {
  tenant: string;
  name: string;
  requestedAt: string;
  deletedBy: string | null;
  confirmationId?: string;
  deletedAt?: string;
  counts?: Record<string, number>;
};

/// What a deletion takes, as the owner's page shows it.
export type DeletionGoes = { messages: number; replies: number; payments: number; lineConnected: boolean };

/// What the owner is asked about (approval-core's `detail`), fixed when the
/// confirmation opens: which shop, and what it held then. The page counts
/// afresh while the shop's data is still there and shows these once it is gone.
export type DeletionDetail = { tenant: string; shopName: string; goes: DeletionGoes };

/// The two choices a confirmation offers. approval-core records the option
/// chosen and, apart from its label, what it does, so the record says whether
/// the deletion was approved without anyone reading a label.
export const DELETION_OPTIONS: readonly ApprovalOption[] = [
  { id: "delete", label: "Delete everything", effect: "approve" },
  { id: "keep", label: "Keep my data", effect: "decline" },
];

/// Confirmations are never revised: a changed request is a new confirmation
/// with a link of its own. So the one revision an owner can have seen is the
/// first, and every decision names it; a revision added later would make every
/// older link's decision refused as changed, never applied to something unseen.
export const CONFIRMATION_REVISION = 1;

/// Deleting a shop's data changes the shop's own records, which approval-core
/// calls a `command`: an owner-only kind, so no helper may decide it, approving
/// or declining.
const CONFIRMATION_KIND = "command";

export function pilotDeletionKey(tenant: string): string {
  return `pilot-deletion:${enc(tenant)}`;
}

export function pilotDeletionConfirmationKey(tenant: string, id: string): string {
  return `pilot-deletion-confirmation:${enc(tenant)}:${enc(id)}`;
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isDeletionDetail(value: unknown): value is DeletionDetail {
  if (value === null || typeof value !== "object") return false;
  const detail = value as Record<string, unknown>;
  const goes = detail.goes as Record<string, unknown> | null | undefined;
  return bounded(detail.tenant) && bounded(detail.shopName, 200) && goes !== null && typeof goes === "object" &&
    isCount(goes.messages) && isCount(goes.replies) && isCount(goes.payments) && typeof goes.lineConnected === "boolean";
}

/// Whether the owner said yes. The option's effect decides, not its id or label.
export function approvedDeletion(record: ApprovalRecord | null | undefined): boolean {
  if (record?.status !== "decided") return false;
  const chosen = record.request.options.find((option) => option.id === record.decision.optionId);
  return chosen?.effect === "approve";
}

/// Whether the owner can still answer: approval-core's standing, at the one revision a confirmation has.
export function confirmationOpen(record: ApprovalRecord, now: number): boolean {
  return requestStanding(record, { seenRevision: CONFIRMATION_REVISION, running: {}, now }).state === "open";
}

/// A shop's deletion record with one of its confirmations: `id` names it, or
/// else the one the record points at.
export type StoredDeletion = { deletion: PilotDeletionRecord | null; confirmation: ApprovalRecord | null };

/// `/pilot-deletions` on AuthObject:
/// - `GET ?tenant=`: the shop's deletion record and its current confirmation;
/// - `GET /confirmation?tenant=&id=`: the record and one confirmation, for the owner's link;
/// - `POST`: write the record, for a shop that never went live;
/// - `POST /open`: open the owner's confirmation, or answer the one already open;
/// - `POST /decide`: settle the owner's answer.
///
/// Writes need the Worker's `x-admin` header, like the registry. Opening and
/// deciding each read, apply approval-core's transition and write in one
/// storage transaction, so of any number of concurrent calls exactly one opens
/// or settles and every other one reads what it wrote (transitions.ts and
/// store.ts in approval-core).
export async function pilotDeletionRoute(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const tenant = url.searchParams.get("tenant") ?? "";
  if (request.method === "GET") {
    if (!bounded(tenant)) return json({ error: "invalid_request" }, 400);
    if (url.pathname === "/pilot-deletions") return json(await readDeletionState(storage, tenant, null));
    if (url.pathname === "/pilot-deletions/confirmation") {
      const id = url.searchParams.get("id") ?? "";
      if (!bounded(id)) return json({ error: "invalid_request" }, 400);
      return json(await readDeletionState(storage, tenant, id));
    }
    return json({ error: "not_found" }, 404);
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-admin") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (body === null || typeof body !== "object" || Array.isArray(body) || !bounded(body.tenant)) {
    return json({ error: "invalid_request" }, 400);
  }
  switch (url.pathname) {
    case "/pilot-deletions":
      await storage.put(pilotDeletionKey(body.tenant), body);
      return json({ recorded: true });
    case "/pilot-deletions/open":
      return openConfirmation(storage, body.tenant, body);
    case "/pilot-deletions/decide":
      return decideConfirmation(storage, body.tenant, body);
  }
  return json({ error: "not_found" }, 404);
}

async function readDeletionState(storage: DurableObjectStorage, tenant: string, id: string | null): Promise<StoredDeletion> {
  const deletion = (await storage.get<PilotDeletionRecord>(pilotDeletionKey(tenant))) ?? null;
  const which = id ?? deletion?.confirmationId;
  const confirmation = which
    ? ((await storage.get<ApprovalRecord>(pilotDeletionConfirmationKey(tenant, which))) ?? null)
    : null;
  return { deletion, confirmation };
}

/// What `POST /pilot-deletions/open` did: `approved`, the owner already said
/// yes and nothing was written (the Worker finishes that deletion); `open`, the
/// confirmation already waiting is answered unchanged; `opened`, a new one.
export type OpenedConfirmation = {
  outcome: "approved" | "open" | "opened";
  deletion: PilotDeletionRecord;
  confirmation: ApprovalRecord;
};

/// Opens the owner's confirmation of deleting the shop and records who asked,
/// in one write, or answers the one already open. A confirmation that expired
/// unanswered is withdrawn as the new one opens, so a shop never has two that a
/// decision could settle. Who asked and when are those of the request that
/// opened the confirmation; asking again while it waits changes neither.
async function openConfirmation(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { name, deletedBy, detail } = body;
  if (!bounded(name, 200) || (deletedBy !== null && !bounded(deletedBy)) || !isDeletionDetail(detail) ||
      detail.tenant !== tenant) {
    return json({ error: "invalid_request" }, 400);
  }
  const answer = await storage.transaction(async (txn): Promise<OpenedConfirmation> => {
    const now = Date.now();
    const deletion = await txn.get<PilotDeletionRecord>(pilotDeletionKey(tenant));
    const currentKey = deletion?.confirmationId ? pilotDeletionConfirmationKey(tenant, deletion.confirmationId) : null;
    const current = currentKey ? await txn.get<ApprovalRecord>(currentKey) : undefined;
    if (deletion && current && approvedDeletion(current)) return { outcome: "approved", deletion, confirmation: current };
    if (deletion && current?.status === "pending") {
      if (confirmationOpen(current, now)) return { outcome: "open", deletion, confirmation: current };
      const withdrawn = withdrawTransition(current, now).next;
      if (withdrawn && currentKey) await txn.put(currentKey, withdrawn);
    }
    const id = crypto.randomUUID();
    const key = pilotDeletionConfirmationKey(tenant, id);
    const opened = openTransition(await txn.get<ApprovalRecord>(key), {
      id,
      kind: CONFIRMATION_KIND,
      options: DELETION_OPTIONS,
      expiresAt: now + DELETION_LINK_TTL_MS,
      detail,
    }, now);
    if (!opened.result.ok || !opened.next) throw new Error("confirmation_not_opened");
    const record: PilotDeletionRecord = {
      tenant,
      name,
      requestedAt: new Date(now).toISOString(),
      deletedBy,
      confirmationId: id,
    };
    await txn.put({ [pilotDeletionKey(tenant)]: record, [key]: opened.next });
    return { outcome: "opened", deletion: record, confirmation: opened.next };
  });
  return json(answer);
}

/// What `POST /pilot-deletions/decide` did, with the records as they now stand.
export type DecidedConfirmation = {
  result: DecideResult;
  deletion: PilotDeletionRecord | null;
  confirmation: ApprovalRecord | null;
};

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/// Settles one confirmation through approval-core's rules, in their order: a
/// decided one answers who decided; then who may decide its kind; then
/// whether it is still open (a withdrawn one is superseded, an expired one
/// expired); then whether the option was offered. The decision is in storage
/// before this answers, so the Worker starts a wipe only once it is recorded.
/// Opening withdraws an expired confirmation before it opens the next, so the
/// one confirmation a decision can settle is always the shop's current one.
async function decideConfirmation(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>) {
  const { id, approve, role, decidedBy } = body;
  if (!bounded(id) || typeof approve !== "boolean" || !isRole(role) || !bounded(decidedBy)) {
    return json({ error: "invalid_request" }, 400);
  }
  const answer = await storage.transaction(async (txn): Promise<DecidedConfirmation> => {
    const key = pilotDeletionConfirmationKey(tenant, id);
    const stored = await txn.get<ApprovalRecord>(key);
    const { result, next } = decideTransition(stored, {
      requestId: id,
      optionId: approve ? "delete" : "keep",
      seenRevision: CONFIRMATION_REVISION,
      decidedBy,
      role,
    }, { running: {}, now: Date.now() });
    if (next) await txn.put(key, next);
    const deletion = (await txn.get<PilotDeletionRecord>(pilotDeletionKey(tenant))) ?? null;
    return { result, deletion, confirmation: next ?? stored ?? null };
  });
  return json(answer);
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
