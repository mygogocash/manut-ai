/// What the team knows about one shop, kept in that shop's TenantObject (`t:${tenant}`) beside its other records, so
/// tenant export reads it and tenant deletion wipes it. The rules (what a fact is, what waits for the owner, what Forget
/// keeps) are `@manut/shop-memory`'s and are pure: this file only stores their state and records each change.
///
/// One record per shop, `memory:${tenant}`, holds the package's whole state: the facts, the fingerprints of the texts
/// the owner had the team forget, and the counter for the next fact's id. The rules need every fact to decide anything
/// (a duplicate, the limit of 200), so spreading the state over several keys would only make one operation read them
/// all and write several.
///
/// Atomicity. As in model-meter.ts, every change runs inside `transactionSync` using the synchronous KV API of
/// SQLite-backed objects: it reads the state, applies one rule and writes the result and its audit entry without a
/// single await, so no other request can run in between, and two operators' clicks on one shop are decided one after
/// the other and never lose each other. A throw rolls all of it back. Only a change is written and recorded: a refusal
/// leaves the state as it was, and so does a confirm of a fact that is already confirmed (the package hands that back
/// as the very state it was given).
///
/// What is never stored or logged. A fact's words live only in its record. The audit entry of a change names the
/// actor, a fixed action and the fact's id (audit-log.ts), and Forget removes the text and keeps only its fingerprint.
///
/// Only the Worker reaches these paths, and writes also need its `x-memory` header, the same defence in depth as
/// `x-model`, `x-audit` and `x-pilot`. A worker's proposal comes in through `POST /memory/propose` as well, but no
/// operator route leads to it (memory.ts).

import * as rules from "@manut/shop-memory";
import type { FactSource, ForgetResult, MemoryState, Refusal, Result } from "@manut/shop-memory";
import { actorOr, auditPutSync, type AuditAction, type AuditActor, type AuditOutcome } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";

/// Twice what the Worker reads from an operator (memory.ts). The body the Worker forwards also carries the time and the
/// operator, so with the same limit, words that were just inside the Worker's would be refused here as too large instead of
/// as too long. A body larger than this is not a fact or a source of any shop, and is answered 413.
const MAX_BODY_BYTES = 32 * 1024;
/// The longest id the object looks up. The package's ids are `f1`, `f2` and so on: this is far past any real one.
const MAX_ID = 64;
/// The longest name, detail or chat reference a fact's source may hold. The package only checks that they are not
/// blank, a worker's source can hold a document's title or a connection's label, and the whole shop's memory is one
/// stored record of up to 200 facts, so the size of each part is bounded here.
const MAX_SOURCE_TEXT = 256;
/// The latest time a JavaScript date can hold: the latest a document's date can be and still be shown as a date.
const MAX_DATE_MS = 8_640_000_000_000_000;
const SYSTEM: AuditActor = { kind: "system" };

/// How each refusal is answered. The same codes and statuses come back from the operator routes.
const STATUS: Record<Refusal, 400 | 404 | 409> = {
  invalid_text: 400,
  invalid_source: 400,
  not_found: 404,
  already_known: 409,
  forgotten: 409,
  full: 409,
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const key = (tenant: string) => `memory:${encodeURIComponent(tenant)}`;

function readState(kv: SyncKvStorage, tenant: string): MemoryState {
  return kv.get<MemoryState>(key(tenant)) ?? rules.emptyState();
}

/// The source as it will be kept: only the fields its kind has, so nothing else can ride along into the shop's record,
/// and each of them within bounds. `null` for what is not a source, or has a part out of bounds; what the package would
/// refuse for another reason (a blank name, a count under 1) is left for the package to refuse.
function keptSource(source: unknown): FactSource | null {
  if (!isRecord(source)) return null;
  const text = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_SOURCE_TEXT;
  const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
  switch (source.kind) {
    case "owner":
      return { kind: "owner" };
    case "document":
      return text(source.name) && whole(source.date) && source.date >= 0 && source.date <= MAX_DATE_MS
        ? { kind: "document", name: source.name, date: source.date } : null;
    case "edits":
      return whole(source.count) ? { kind: "edits", count: source.count } : null;
    case "orders":
      return whole(source.days) ? { kind: "orders", days: source.days } : null;
    case "connection":
      return text(source.name) && text(source.detail) ? { kind: "connection", name: source.name, detail: source.detail } : null;
    case "customer":
      return text(source.chat) ? { kind: "customer", chat: source.chat } : null;
    default:
      return null;
  }
}

/// What a request gives an operation: the fact it names, the words and source it carries, and the time.
type Input = { id: string; text: unknown; source: unknown; nowMs: number };

type Operation = {
  action: AuditAction;
  /// Whether the change is dated. Forgetting is not.
  dated: boolean;
  /// Whether the change names a fact.
  needsId: boolean;
  /// The package's rule for it. The package refuses what is not text, so the words are handed over as they came.
  run(state: MemoryState, input: Input): Result | ForgetResult;
};

const OPERATIONS: Readonly<Record<string, Operation>> = {
  "POST /memory/remember": {
    action: "memory.remembered", dated: true, needsId: false,
    run: (state, input) => rules.remember(state, input.text as string, input.nowMs),
  },
  "POST /memory/propose": {
    action: "memory.proposed", dated: true, needsId: false,
    run: (state, input) => {
      const source = keptSource(input.source);
      return source ? rules.propose(state, input.text as string, source, input.nowMs) : { ok: false, reason: "invalid_source", state };
    },
  },
  "POST /memory/confirm": {
    action: "memory.confirmed", dated: true, needsId: true,
    run: (state, input) => rules.confirm(state, input.id, input.nowMs),
  },
  "POST /memory/correct": {
    action: "memory.corrected", dated: true, needsId: true,
    run: (state, input) => rules.correct(state, input.id, input.text as string, input.nowMs),
  },
  "POST /memory/forget": {
    action: "memory.forgotten", dated: false, needsId: true,
    run: (state, input) => rules.forget(state, input.id),
  },
};

/// `/memory/*` on a TenantObject. Reads need only the tenant; writes need the Worker's `x-memory` header as well. A
/// write answers the fact (Forget answers the id of the one it removed), or a refusal as `{ error }` with its status.
export async function memoryTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    // The read and the export are the same answer: every fact, waiting ones included, and only how many fingerprints.
    if (route === "GET /memory" || route === "GET /memory/export") return json(rules.exportFacts(readState(storage.kv, tenant)));
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-memory") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const operation = OPERATIONS[route];
  if (!operation) return json({ error: "not_found" }, 404);
  return apply(storage, body.tenant, body, operation);
}

/// One change, start to end: the state read, one rule applied, and the new state and its audit entry written, in one
/// transaction. The entry names the actor the Worker sent (the system when it sent none), and when that actor cannot be
/// recorded the shop's miss count goes up in the same write instead, and the change stands (audit-log.ts).
function apply(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>, operation: Operation): Response {
  const { id, nowMs } = body;
  if (operation.dated && !isTime(nowMs)) return json({ error: "invalid_request" }, 400);
  if (operation.needsId && !(typeof id === "string" && id.length > 0 && id.length <= MAX_ID)) {
    return json({ error: "invalid_request" }, 400);
  }
  const input: Input = { id: typeof id === "string" ? id : "", text: body.text, source: body.source, nowMs: isTime(nowMs) ? nowMs : 0 };
  const actor = actorOr(body.actor, SYSTEM);
  const answer = storage.transactionSync(() => applyWithin(storage.kv, tenant, operation, input, actor));
  return json(answer.body, answer.status);
}

/// The body of one change, inside a transaction the caller already holds: the state read, the rule applied, and the
/// new state and its audit entry written, all through the synchronous API, so they commit or roll back with whatever
/// else the caller writes in that transaction.
function applyWithin(kv: SyncKvStorage, tenant: string, operation: Operation, input: Input, actor: AuditActor | undefined):
  { status: number; body: unknown } {
  const before = readState(kv, tenant);
  const result = operation.run(before, input);
  if (!result.ok) return { status: STATUS[result.reason], body: { error: result.reason } };
  const fact = "fact" in result ? result.fact : null;
  if (result.state !== before) {
    kv.put(key(tenant), result.state);
    // A proposal that waits for the owner says so, so the log shows what is waiting on whom.
    const outcome: AuditOutcome = operation.action === "memory.proposed" && fact?.status === "waiting" ? "awaiting_owner" : "ok";
    auditPutSync(kv, tenant, actor ? { actor, action: operation.action, subject: { factId: fact?.id ?? input.id }, outcome } : null,
      operation.action);
  }
  return { status: 200, body: fact ?? { id: input.id } };
}

/// The owner's own fact, as `POST /memory/remember` makes it (the package's `remember`, with the owner as its source),
/// inside a transaction the caller holds. routine-store.ts records a first-week answer this way and links its question
/// to the fact in the same transaction, so an answer is never kept without its fact, or a fact without its question.
/// Answers the fact, or the package's refusal with the status the routes give it.
export function rememberWithin(kv: SyncKvStorage, tenant: string, text: unknown, nowMs: number, actor: AuditActor):
  { ok: true; fact: rules.Fact } | { ok: false; status: number; error: Refusal } {
  const answer = applyWithin(kv, tenant, OPERATIONS["POST /memory/remember"]!, { id: "", text, source: undefined, nowMs },
    actor);
  if (answer.status === 200) return { ok: true, fact: answer.body as rules.Fact };
  return { ok: false, status: answer.status, error: (answer.body as { error: Refusal }).error };
}

/// Part of the TenantObject's tenant wipe: the shop's state, the fingerprints in it included.
export async function wipeMemoryTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  await storage.delete(key(tenant));
}
