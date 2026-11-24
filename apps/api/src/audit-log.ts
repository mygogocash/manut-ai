/// The shop's audit log (docs/pilot-api.md, "Audit log"): one append-only list per tenant, kept in that tenant's
/// TenantObject (`t:${tenant}`) beside its other records, of who did what and when. Operators read it a page at a
/// time through `GET /v1/admin/audit`; the tenant export carries all of it, and the tenant deletion wipes it. The
/// deletion's own record is not here: it outlives the shop in AuthObject (pilot-store.ts).
///
/// Metadata only. An entry names its actor, a fixed action, the ids it is about, a fixed outcome, and at most a short
/// reason code and an amount in satang. The shape is checked on every write rather than trusted: ids and codes are
/// refused when they hold a space or any character outside a narrow set, so a customer's words, a draft's text or a
/// secret cannot be written into the log even by mistake.
///
/// How an entry is written depends on where the record it describes lives, so that writing it never blocks or fails
/// the action it records:
///
/// - When that record lives in the same TenantObject (the shop, its LINE pointer, a reply's record and decision time,
///   payments, consent, the model cap, what the team knows), the entry goes into the same storage write (`auditPut`, `auditPutSync`), so
///   the entry exists exactly when the record does. An entry that cannot be made as given (a malformed actor from a
///   caller) is not written; the shop's miss count goes up in that same write instead, and the action goes ahead.
/// - When the record lives in another object (task objects, AuthObject), the entry is appended after the action
///   succeeded, best effort (`appendAudit`). An append that fails, or that the log refuses as malformed, is counted
///   in the shop's miss count by a second, smaller write; if even that fails, the Worker logs the action and the
///   tenant (never anything else). The action has already happened and its own record says so; the miss count tells
///   anyone reading the log that it is not complete, rather than letting a gap pass for a full history.

import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { sortableId } from "./pilot-store";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

/// What happened. Fixed, so the log can be read without parsing sentences, and so the console has words for each.
export const AUDIT_ACTIONS = [
  // Operators, through the console
  "shop.created",
  "line.connected",
  "reply.proposed",
  "payment.recorded",
  "subscription_payment.recorded",
  "model.cap_set",
  "model.cap_cleared",
  "deletion.requested",
  // The owner, through a signed link or a session
  "reply.decided",
  "deletion.decided",
  "consent.given",
  "consent.withdrawn",
  // The broker
  "dispatch.started",
  "dispatch.settled",
  // The job flow (job-flow.ts)
  "attempt.started",
  "attempt.ended",
  "approval.requested",
  "approval.decided",
  "approval.superseded",
  // What the team knows about the shop (memory-store.ts): the owner's changes from their own session or relayed by an
  // operator through the console, and what a worker learned. Each names the fact by its id and never by its words.
  "memory.remembered",
  "memory.proposed",
  "memory.confirmed",
  "memory.corrected",
  "memory.forgotten",
  // The team's routines and setup (routine-store.ts): changes by an operator or the shop's own session, each run of a
  // routine by the system, a shop template applied, and a first-week question answered. Each names a routine, a
  // template, a question or a fact by its id, never a routine's name, a question or an answer.
  "routine.created",
  "routine.paused",
  "routine.resumed",
  "routine.removed",
  "routine.ran",
  "team.paused",
  "team.resumed",
  "template.applied",
  "question.answered",
  // The people around the shop (people-store.ts): the owner's changes from their own session or through the console, and
  // what a helper did. Each names an invite, a helper or a request by its id, never a name, a note or an identity's value.
  "invite.created",
  "invite.revoked",
  "helper.joined",
  "helper.session_opened",
  "helper.removed",
  "away.set",
  "away.cleared",
  "request.passed_on",
  // Several shops (shops.ts, people-store.ts): the operator links or unlinks the account the shop's owner signs in with,
  // and that account opens the shop. Each names the link by its id, never the account itself or the code. A device's
  // sign-out ends its own shop session, an owner's or a helper's, and names the account or the helper by its id too.
  "owner.linked",
  "owner.unlinked",
  "owner.session_opened",
  "owner.session_ended",
  "helper.session_ended",
  // A shop its owner made, signed in, with no operator (self-serve.ts): written with `shop.created`, `owner.linked` and
  // `owner.session_opened` in the one write that makes the shop, by the owner's linked account, named by its id.
  "shop.made_by_owner",
  // An operator adds a shop its owner made to the pilot gate's cohort, or leaves it out again (pilot.ts). No id: the shop.
  "cohort.added",
  "cohort.removed",
  // Browser control (browser-control.ts): the vault's site sign-ins and the outposts that type them. Each names the
  // sign-in or the outpost by its id, never an account, a password or a credential.
  "signin.created",
  "signin.password_replaced",
  "signin.removed",
  "signin.broken",
  "signin.requested",
  "signin.redeemed",
  // The owner choosing who may use a sign-in, from Customize › Connections. Its subject is the sign-in's id only: who may
  // use it is on the sign-in's own record.
  "signin.members_changed",
  // The shop's vault sealed again under the current key after a rotation (vault-reseal.ts). It names no id: it is the
  // shop's whole vault, and the counts are in the operator's answer.
  "vault.resealed",
  "outpost.registered",
  "outpost.removed",
  "outpost.credential_rotated",
  // The owner renaming an outpost from Customize › Connections. Its subject is the outpost's id: never the name typed.
  "outpost.renamed",
  // The step channel: a worker's browser step queued for an outpost, handed out to it, and how it went. Each names the
  // step and what it is bound to by id, never its page, what it read, or anything typed.
  "browser_step.queued",
  "browser_step.fetched",
  "browser_step.reported",
  // Google Sheets for Ton's books (google-connect.ts, books-sheet.ts): the owner connecting their Google account (or
  // saying no on Google's page) and disconnecting it, Google refusing the grant so the connection broke, the sheet made
  // in the owner's Drive, and each approved month appended, with how it settled. Each names the connection, the task or
  // the action by its id, never a token, a sheet's title, or a row.
  "google.connected",
  "google.disconnected",
  "google.broken",
  "google.sheet_created",
  "google.appended",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/// How it ended. `ok` is an action done as asked; the rest name the result an action of that kind can have.
export const AUDIT_OUTCOMES = [
  "ok",
  "approved",
  "declined",
  "refused",
  "awaiting_owner",
  "confirmed",
  "failed",
  "unknown",
  "done",
  "cancelled",
  "superseded",
  // A routine's run that did not start: paused, refused by a switch or consent, or too late to run (routine-store.ts).
  "skipped",
  "missed",
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/// The ids an entry may name. Only ids: what they point at is read from its own record.
export const AUDIT_SUBJECT_KEYS = [
  "taskId",
  "actionId",
  "messageId",
  "attemptId",
  "requestId",
  "paymentId",
  "connectionId",
  "previousConnectionId",
  "confirmationId",
  "factId",
  "routineId",
  "templateId",
  "questionId",
  "inviteId",
  "helperId",
  "signInId",
  "outpostId",
  "stepId",
  "grantId",
  "ownerAccountId",
] as const;
export type AuditSubject = Partial<Record<(typeof AUDIT_SUBJECT_KEYS)[number], string>>;

/// Who did it:
/// - an operator, known only by the Cloudflare Access identity of the request (operators share one bearer key), or
///   `null` for a service token;
/// - the shop's owner, through a signed link (no id) or a signed-in surface (its account or device id);
/// - a helper the owner trusts with conversations, by account or device id;
/// - a worker, by the attempt it was given;
/// - an outpost, by its id, for what it did with its own credential (browser-control.ts);
/// - the system: the control plane or the broker acting on its own.
export type AuditActor =
  | { kind: "operator"; email: string | null }
  | { kind: "owner"; id?: string }
  | { kind: "helper"; id: string }
  | { kind: "worker"; attemptId: string }
  | { kind: "outpost"; id: string }
  | { kind: "system" };

export type AuditEntry = {
  /// Sorts by the time the log stored it, so pages read newest first by key order. A page's cursor.
  id: string;
  /// When the log stored it.
  at: string;
  actor: AuditActor;
  action: AuditAction;
  subject: AuditSubject;
  outcome: AuditOutcome;
  /// Why, as a code, for outcomes that need one: an attempt's `budget`, a refusal's `already_decided`.
  reason?: string;
  /// Money the action was about, in satang: a payment recorded, a cap set.
  amountSatang?: number;
};

/// What a writer supplies. The log adds the id and the time.
export type AuditRecord = Omit<AuditEntry, "id" | "at">;

/// What the log could not write for the shop: how many entries, and the last one's action and time.
export type AuditMissed = { count: number; lastAt: string; lastAction: string };

export type AuditPage = { entries: AuditEntry[]; next: string | null; missed: AuditMissed | null };

const MAX_BODY_BYTES = 16 * 1024;
/// Entries one page reads when the caller does not say, and the most it may ask for.
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/// Durable Object storage takes at most 128 keys per delete call.
const STORAGE_BATCH = 128;
/// Ids every object here mints (UUIDs, sortable ids, `pilot-task-…`) and nothing a person writes: no spaces, no
/// letters outside ASCII.
const ID = /^[A-Za-z0-9._:-]{1,256}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ENTRY_ID = /^aud-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/;
const EMAIL_MAX = 254;
/// The most satang an entry can name: far above any real payment or cap, and a safe integer.
const MAX_AMOUNT = 1_000_000_000_000;

const ACTIONS: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const OUTCOMES: ReadonlySet<string> = new Set(AUDIT_OUTCOMES);
const SUBJECT_KEYS: ReadonlySet<string> = new Set(AUDIT_SUBJECT_KEYS);
const RECORD_KEYS: ReadonlySet<string> = new Set(["actor", "action", "subject", "outcome", "reason", "amountSatang"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isAuditActor(value: unknown): value is AuditActor {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "operator":
      return hasOnly(value, ["kind", "email"]) && (value.email === null ||
        (typeof value.email === "string" && value.email.length > 0 && value.email.length <= EMAIL_MAX &&
          !/\s/.test(value.email)));
    case "owner":
      return hasOnly(value, ["kind", "id"]) && (value.id === undefined || (typeof value.id === "string" && ID.test(value.id)));
    case "helper":
      return hasOnly(value, ["kind", "id"]) && typeof value.id === "string" && ID.test(value.id);
    case "worker":
      return hasOnly(value, ["kind", "attemptId"]) && typeof value.attemptId === "string" && ID.test(value.attemptId);
    case "outpost":
      return hasOnly(value, ["kind", "id"]) && typeof value.id === "string" && ID.test(value.id);
    case "system":
      return hasOnly(value, ["kind"]);
    default:
      return false;
  }
}

/// Whether `value` is a record the log can keep as it is: every field known, every id and code free of anything a
/// person could have written. A field the log does not know is refused, not dropped, so a caller's mistake shows.
export function isAuditRecord(value: unknown): value is AuditRecord {
  if (!isRecord(value) || !Object.keys(value).every((key) => RECORD_KEYS.has(key))) return false;
  const { actor, action, subject, outcome, reason, amountSatang } = value;
  if (!isAuditActor(actor) || typeof action !== "string" || !ACTIONS.has(action)) return false;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return false;
  if (!isRecord(subject) || !Object.entries(subject).every(([key, id]) =>
    SUBJECT_KEYS.has(key) && typeof id === "string" && ID.test(id))) {
    return false;
  }
  if (reason !== undefined && (typeof reason !== "string" || !CODE.test(reason))) return false;
  if (amountSatang !== undefined && (typeof amountSatang !== "number" || !Number.isSafeInteger(amountSatang) ||
    amountSatang < 0 || amountSatang > MAX_AMOUNT)) {
    return false;
  }
  return true;
}

/// The actor a caller named, or `fallback` when it named none. Undefined when it named one the log cannot keep.
export function actorOr(value: unknown, fallback: AuditActor): AuditActor | undefined {
  if (value === undefined) return fallback;
  return isAuditActor(value) ? value : undefined;
}

const enc = encodeURIComponent;
const keys = {
  entries: (tenant: string) => `audit:${enc(tenant)}:`,
  entry: (tenant: string, id: string) => `audit:${enc(tenant)}:${id}`,
  missed: (tenant: string) => `audit-missed:${enc(tenant)}`,
};

/// The entry a record becomes when stored at `nowMs`. The id is minted inside the shop's own object, which handles
/// one request at a time, so ids sort in the order entries were stored.
function entryOf(record: AuditRecord, nowMs: number): AuditEntry {
  return {
    id: sortableId("aud", nowMs, 0),
    at: new Date(nowMs).toISOString(),
    actor: record.actor,
    action: record.action,
    subject: record.subject,
    outcome: record.outcome,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.amountSatang !== undefined ? { amountSatang: record.amountSatang } : {}),
  };
}

function missedAfter(prior: AuditMissed | undefined, action: string, nowMs: number): AuditMissed {
  return { count: (prior?.count ?? 0) + 1, lastAt: new Date(nowMs).toISOString(), lastAction: action };
}

/// The storage entries that record `record` in the same write as the record it describes: the entry, or when the
/// entry cannot be kept as given, the shop's miss count raised by one. Spread into that write's `put`, so the two
/// land together or not at all; never throws, so the action never fails for its entry. `nowMs` is the write's own moment
/// when it has one, so a record and its entries say the same time.
export async function auditPut(
  storage: DurableObjectStorage,
  tenant: string,
  record: AuditRecord | null,
  missedAction: AuditAction,
  nowMs: number = Date.now(),
): Promise<Record<string, unknown>> {
  if (record !== null && isAuditRecord(record)) {
    const entry = entryOf(record, nowMs);
    return { [keys.entry(tenant, entry.id)]: entry };
  }
  const prior = await storage.get<AuditMissed>(keys.missed(tenant));
  return { [keys.missed(tenant)]: missedAfter(prior, missedAction, nowMs) };
}

/// `auditPut` for a write inside `transactionSync` (model-meter.ts): puts the entry, or the raised miss count,
/// through the synchronous API, so it commits or rolls back with the rest of the transaction.
export function auditPutSync(kv: SyncKvStorage, tenant: string, record: AuditRecord | null, missedAction: AuditAction): void {
  const nowMs = Date.now();
  if (record !== null && isAuditRecord(record)) {
    const entry = entryOf(record, nowMs);
    kv.put(keys.entry(tenant, entry.id), entry);
    return;
  }
  kv.put(keys.missed(tenant), missedAfter(kv.get<AuditMissed>(keys.missed(tenant)), missedAction, nowMs));
}

/// `/audit` on a TenantObject:
/// - `GET /audit?tenant=&before=&limit=`: one page, newest first, with the cursor of the next and the miss count;
/// - `GET /audit/export?tenant=`: every entry, oldest first, with the miss count;
/// - `POST /audit` `{ tenant, record }`: append one entry, for the Worker's best-effort writer;
/// - `POST /audit/missed` `{ tenant, action }`: count one entry that could not be written.
/// Writes need the Worker's `x-audit` header, the same defence in depth as `x-pilot` and `x-model`.
export async function auditTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    if (route === "GET /audit") {
      const query = pageQuery(url);
      if (!query) return json({ error: "invalid_request" }, 400);
      return json(await readPage(storage, tenant, query));
    }
    if (route === "GET /audit/export") return json(await exportAudit(storage, tenant));
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-audit") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const tenant = body.tenant;
  if (route === "POST /audit") {
    if (!isAuditRecord(body.record)) return json({ error: "invalid_request" }, 400);
    const entry = entryOf(body.record, Date.now());
    await storage.put(keys.entry(tenant, entry.id), entry);
    return json({ entry });
  }
  if (route === "POST /audit/missed") {
    // The action names what was missed; a name the log does not know is still a miss worth counting.
    const action = typeof body.action === "string" && CODE.test(body.action.replaceAll(".", "_")) ? body.action
      : "unknown";
    const missed = missedAfter(await storage.get<AuditMissed>(keys.missed(tenant)), action, Date.now());
    await storage.put(keys.missed(tenant), missed);
    return json({ missed });
  }
  return json({ error: "not_found" }, 404);
}

type PageQuery = { before: string | null; limit: number };

/// The page asked for, or null when the cursor is not an entry's id or the size is not a whole number in range.
function pageQuery(url: URL): PageQuery | null {
  const before = url.searchParams.get("before");
  const rawLimit = url.searchParams.get("limit");
  if (before !== null && !ENTRY_ID.test(before)) return null;
  const limit = rawLimit === null ? DEFAULT_PAGE : Number(rawLimit);
  if (!/^\d+$/.test(rawLimit ?? "1") || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) return null;
  return { before, limit };
}

/// Walks the keys backwards from the cursor, reading one entry past the page to learn whether another page exists.
async function readPage(storage: DurableObjectStorage, tenant: string, query: PageQuery): Promise<AuditPage> {
  const listed = await storage.list<AuditEntry>({
    prefix: keys.entries(tenant),
    ...(query.before !== null ? { end: keys.entry(tenant, query.before) } : {}),
    reverse: true,
    limit: query.limit + 1,
  });
  const found = [...listed.values()];
  const entries = found.slice(0, query.limit);
  const last = entries[entries.length - 1];
  return {
    entries,
    next: found.length > query.limit && last ? last.id : null,
    missed: (await storage.get<AuditMissed>(keys.missed(tenant))) ?? null,
  };
}

async function exportAudit(storage: DurableObjectStorage, tenant: string) {
  return {
    entries: [...(await storage.list<AuditEntry>({ prefix: keys.entries(tenant) })).values()],
    missed: (await storage.get<AuditMissed>(keys.missed(tenant))) ?? null,
  };
}

/// Part of the TenantObject's tenant wipe: every entry and the miss count.
export async function wipeAuditTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  const doomed: string[] = [keys.missed(tenant), ...(await storage.list({ prefix: keys.entries(tenant) })).keys()];
  for (let i = 0; i < doomed.length; i += STORAGE_BATCH) {
    await storage.delete(doomed.slice(i, i + STORAGE_BATCH));
  }
}

function auditWrite(env: Pick<TenantDataEnv, "TENANT">, tenant: string, path: string, body: Record<string, unknown>) {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-audit": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

/// Appends an entry for an action whose own record lives in another object, after that action has happened. Never
/// throws and never answers anything the caller must act on: the action stands either way. What could not be
/// appended is counted (`countAuditMiss`).
export async function appendAudit(env: Pick<TenantDataEnv, "TENANT">, tenant: string, record: AuditRecord): Promise<void> {
  try {
    const response = await auditWrite(env, tenant, "/audit", { record });
    await response.body?.cancel();
    if (response.ok) return;
  } catch {
    // Counted below.
  }
  await countAuditMiss(env, tenant, record.action);
}

/// Counts one entry the shop's log could not take, so a reader sees that the log is incomplete. If the shop's object
/// cannot be reached for this either, the Worker's log is the last place left to say so: it names the action and
/// the tenant id, never anything the entry was about.
export async function countAuditMiss(env: Pick<TenantDataEnv, "TENANT">, tenant: string, action: AuditAction): Promise<void> {
  try {
    const response = await auditWrite(env, tenant, "/audit/missed", { action });
    await response.body?.cancel();
    if (response.ok) return;
  } catch {
    // Logged below.
  }
  console.error(`audit entry not written and not counted: ${action} for ${tenant}`);
}

/// `GET /v1/admin/audit?tenant=&before=&limit=`, after the admin gate's exact ADMIN_METHODS entry (index.ts). Answers
/// null for any other path.
export async function auditAdminRoute(request: Request, url: URL, env: Pick<TenantDataEnv, "TENANT">): Promise<Response | null> {
  if (url.pathname !== "/v1/admin/audit") return null;
  if (request.method !== "GET") return json({ error: "not_found" }, 404);
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  const query = pageQuery(url);
  if (!query) return json({ error: "invalid_request" }, 400);
  const search = new URLSearchParams({ tenant, limit: String(query.limit) });
  if (query.before !== null) search.set("before", query.before);
  let response: Response;
  try {
    response = await tenantCall(env, tenant, `/audit?${search.toString()}`);
  } catch {
    return json({ error: "audit_unavailable" }, 503);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return json({ error: "audit_unavailable" }, 503);
  }
  const page = (await response.json()) as AuditPage;
  return json({ tenant, entries: page.entries, next: page.next, missed: page.missed });
}
