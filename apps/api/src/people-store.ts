/// The people around one shop, kept in that shop's TenantObject (`t:${tenant}`) beside its other records, so the tenant
/// export reads them and the tenant deletion wipes them (docs/people.md). The rules (invites, joining, passing a request
/// on, cover, removal) are `@manut/people-rules`' and are pure: this file only stores their state with two things the
/// rules leave to the caller, and records each change in the shop's audit log.
///
/// One record per shop, `people:${tenant}`:
///
/// - `state`: the package's whole state, the owner, the helpers, every invite, the cover, the notes passed on and the ids
///   of removed helpers. The rules need all of it to decide anything (one open invite per identity, a request passed on
///   once), so it is one value.
/// - `names`: the name the owner gave each invite, carried to the helper who joined through it, and kept after a helper is
///   removed, so the activity log can still say who approved what.
/// - `sessions`: every helper session, by the SHA-256 of its token (people.ts mints the token and never sends it here).
///   Removing a helper marks each of their sessions ended in the same write that removes them, which is how removal signs
///   them out on every device at once. An ended or lapsed session is dropped at the next change after the time it would
///   have run out, so the record stays small.
///
/// Atomicity. As in memory-store.ts, every change runs inside `transactionSync` with the synchronous KV API of
/// SQLite-backed objects: it reads the record, applies one rule and writes the result and its audit entry without a
/// single await, so two clicks on one shop are decided one after the other. A refusal writes nothing. The clock is the
/// object's own, so no caller can choose when an invite or a session runs out.
///
/// What is never stored or logged. A token is kept only as its hash. The audit entry of a change names the actor, a
/// fixed action and ids: never a name, a note, or an identity's value.
///
/// Only the Worker reaches these paths, and every POST also needs its `x-people` header, the same defence in depth as
/// `x-memory`, `x-model`, `x-audit` and `x-pilot`.

import * as rules from "@manut/people-rules";
import type { Identity, Invite, PassedOn, PeopleState, RequestFacts } from "@manut/people-rules";
import { actorOr, auditPutSync, type AuditAction, type AuditActor, type AuditRecord } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";

/// Twice what the Worker reads (people.ts), so a note that was just inside the Worker's limit is refused here as too
/// long rather than as too large.
const MAX_BODY_BYTES = 32 * 1024;
/// The longest id, name, LINE account id or hash the object keeps. Ids are minted by people.ts (`inv-`, `helper-`, `hs-`
/// and a UUID), names are 1 to 80 characters, an email at most 254.
const MAX_FIELD = 256;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SYSTEM: AuditActor = { kind: "system" };

/// The shop's owner in the rules' state. In the pilot the owner has no account: whoever holds the shop's own session or
/// its owner's link is the owner (docs/people.md, "Who is deciding").
export const OWNER_ID = "owner";

/// One helper session: whose it is, which of their sessions in the rules' state, when it runs out, and when it was
/// ended by the helper's removal.
export type HelperSession = { sessionId: string; helperId: string; expiresAt: number; endedAt?: number };

export type PeopleRecord = {
  state: PeopleState;
  names: Record<string, string>;
  sessions: Record<string, HelperSession>;
};

/// What the Worker reads: the rules' state, the names, and how many sessions each helper has running now. Never a hash.
export type PeopleView = { state: PeopleState; names: Record<string, string>; devices: Record<string, number> };

/// What checking a helper session answers.
export type SessionCheck =
  | { ok: true; helperId: string; sessionId: string; name: string }
  | { ok: false; error: "unauthorized" }
  | { ok: false; error: "removed"; removedAt: number };

type Answer = { status: number; body: unknown };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = MAX_FIELD): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const key = (tenant: string) => `people:${encodeURIComponent(tenant)}`;

function readRecord(kv: SyncKvStorage, tenant: string): PeopleRecord {
  return kv.get<PeopleRecord>(key(tenant)) ?? { state: rules.emptyPeople(tenant, OWNER_ID), names: {}, sessions: {} };
}

/// The identity as it will be kept: only the fields its kind has, so nothing else can ride along into the shop's record.
/// An email is kept without outer spaces, which the rules ignore when they compare, so the console never shows them; its
/// case is kept as the owner typed it, and the rules compare without it. A LINE id is kept exactly, as the rules compare
/// it. `null` for what is not an identity at all; an identity of the right shape with a value the rules refuse (an empty
/// LINE id, an address with no `@`) is left for the rules to refuse.
export function keptIdentity(value: unknown): Identity | null {
  if (!isRecord(value)) return null;
  if (value.kind === "line" && typeof value.id === "string" && value.id.length <= MAX_FIELD) {
    return { kind: "line", id: value.id };
  }
  if (value.kind === "email" && typeof value.address === "string" && value.address.length <= MAX_FIELD) {
    return { kind: "email", address: value.address.trim() };
  }
  return null;
}

/// The sessions still worth keeping at `nowMs`: every one that has not reached its end. A session removal ended is kept
/// until then too, so a late request with it is told why it no longer works.
function livingSessions(sessions: Record<string, HelperSession>, nowMs: number): Record<string, HelperSession> {
  return Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.expiresAt > nowMs));
}

function devicesOf(record: PeopleRecord, nowMs: number): Record<string, number> {
  const devices: Record<string, number> = {};
  for (const session of Object.values(record.sessions)) {
    if (session.endedAt !== undefined || session.expiresAt <= nowMs) continue;
    devices[session.helperId] = (devices[session.helperId] ?? 0) + 1;
  }
  return devices;
}

/// `/people` and `/people/*` on a TenantObject. Reads need only the tenant; writes need the Worker's `x-people` header.
export async function peopleTenantRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    const record = readRecord(storage.kv, tenant);
    if (route === "GET /people") {
      return json({ state: record.state, names: record.names, devices: devicesOf(record, Date.now()) } satisfies PeopleView);
    }
    // The export carries who the people are and what they passed on, never a session's hash.
    if (route === "GET /people/export") return json({ state: record.state, names: record.names });
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-people") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const operation = OPERATIONS[route];
  if (!operation) return json({ error: "not_found" }, 404);
  const tenant = body.tenant;
  const answer = storage.transactionSync((): Answer => {
    const kv = storage.kv;
    const nowMs = Date.now();
    const before = readRecord(kv, tenant);
    const done = operation(before, body, nowMs);
    if (done.next) {
      kv.put(key(tenant), { ...done.next, sessions: livingSessions(done.next.sessions, nowMs) } satisfies PeopleRecord);
      const { record, missed } = done.audit ?? {};
      if (missed) auditPutSync(kv, tenant, record ?? null, missed);
    }
    return done.answer;
  });
  return json(answer.body, answer.status);
}

/// What one operation came to: its answer, and when it changed something, the record to write and the audit entry to
/// write with it (`record` null when the actor cannot be recorded: the shop's miss count goes up instead).
type Done = { answer: Answer; next?: PeopleRecord; audit?: { record: AuditRecord | null; missed: AuditAction } };
type Operation = (record: PeopleRecord, body: Record<string, unknown>, nowMs: number) => Done;

function refused(status: number, error: string, extra: Record<string, unknown> = {}): Done {
  return { answer: { status, body: { error, ...extra } } };
}

/// The entry for a change, by `actor` (the one the Worker sent, or `fallback`), or none when that actor cannot be kept.
function entry(actor: unknown, fallback: AuditActor, action: AuditAction, subject: AuditRecord["subject"]):
  { record: AuditRecord | null; missed: AuditAction } {
  const who = actorOr(actor, fallback);
  return { record: who ? { actor: who, action, subject, outcome: "ok" } : null, missed: action };
}

/// The longest name the owner may give a helper, in characters after outer spaces are trimmed.
export const MAX_NAME = 80;

/// A name as a person reads it: no outer spaces, 1 to 80 characters, and no control characters, so a name can never
/// break a line in the console or a log.
export function keptName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= MAX_NAME && !/\p{Cc}/u.test(name) ? name : null;
}

/// A new helper session for `helperId`, from the hash, the id and the end the Worker chose.
function newSession(body: Record<string, unknown>, helperId: string): { hash: string; session: HelperSession } | null {
  const { tokenHash, sessionId, expiresAt } = body;
  if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash) || !text(sessionId) || !isTime(expiresAt)) return null;
  return { hash: tokenHash, session: { sessionId, helperId, expiresAt } };
}

const OPERATIONS: Readonly<Record<string, Operation>> = {
  /// `{ inviteId, identity, name, actor }`: the owner invites one person (`rules.invite`).
  "POST /people/invite": (record, body, nowMs) => {
    const identity = keptIdentity(body.identity);
    const name = keptName(body.name);
    if (!identity || !name || !text(body.inviteId)) return refused(400, "invalid_request");
    const made = rules.invite(record.state, body.inviteId, identity, nowMs);
    if (!made.ok) return refused(made.refused === "bad_identity" || made.refused === "bad_id" ? 400 : 409, made.refused);
    return {
      answer: { status: 200, body: { invite: made.invite } },
      next: { ...record, state: made.state, names: { ...record.names, [made.invite.id]: name } },
      audit: entry(body.actor, SYSTEM, "invite.created", { inviteId: made.invite.id }),
    };
  },

  /// `{ inviteId, actor }`: an invite that was not used yet stops working (`rules.revokeInvite`).
  "POST /people/revoke-invite": (record, body) => {
    if (!text(body.inviteId)) return refused(400, "invalid_request");
    const revoked = rules.revokeInvite(record.state, body.inviteId);
    if (!revoked.ok) return refused(revoked.refused === "unknown_invite" ? 404 : 409, revoked.refused);
    return {
      answer: { status: 200, body: { invite: revoked.state.invites.find((invite) => invite.id === body.inviteId) } },
      next: { ...record, state: revoked.state },
      audit: entry(body.actor, SYSTEM, "invite.revoked", { inviteId: body.inviteId }),
    };
  },

  /// `{ inviteId, account, helperId, sessionId, tokenHash, expiresAt }`: someone signed in as `account` opens an invite
  /// (`rules.acceptInvite`). Joining records the helper, their name and their first session in one write. Every other
  /// answer writes nothing; a wrong account also learns which kind of account the invite is for, never its value.
  "POST /people/accept": (record, body, nowMs) => {
    // A session with no verified identity is no one's account: the rules answer it as the wrong one.
    const account = keptIdentity(body.account) ?? { kind: "email", address: "" };
    if (!text(body.inviteId) || !text(body.helperId)) return refused(400, "invalid_request");
    const fresh = newSession(body, body.helperId);
    if (!fresh) return refused(400, "invalid_request");
    const answered = rules.acceptInvite(record.state, body.inviteId, account, body.helperId, fresh.session.sessionId, nowMs);
    if (answered.answer === "wrong_account") {
      const invited = record.state.invites.find((invite) => invite.id === body.inviteId) as Invite;
      return { answer: { status: 200, body: { answer: "wrong_account", invitedOn: invited.identity.kind } } };
    }
    if (answered.answer !== "joined") return { answer: { status: 200, body: { answer: answered.answer } } };
    const name = record.names[body.inviteId] ?? "";
    return {
      answer: { status: 200, body: { answer: "joined", helperId: answered.helper.id, name } },
      next: {
        state: answered.state,
        names: { ...record.names, [answered.helper.id]: name },
        sessions: { ...record.sessions, [fresh.hash]: fresh.session },
      },
      audit: entry({ kind: "helper", id: answered.helper.id }, SYSTEM, "helper.joined",
        { inviteId: body.inviteId, helperId: answered.helper.id }),
    };
  },

  /// `{ account, sessionId, tokenHash, expiresAt }`: a helper opens the shop on another device, signed in as the
  /// identity they joined with (`rules.addSession`). Anyone else is not a helper of this shop.
  "POST /people/open-session": (record, body) => {
    const account = keptIdentity(body.account);
    const helper = account ? record.state.helpers.find((one) => rules.sameIdentity(one.identity, account)) : undefined;
    if (!helper) return refused(403, "not_a_helper");
    const fresh = newSession(body, helper.id);
    if (!fresh) return refused(400, "invalid_request");
    const added = rules.addSession(record.state, helper.id, fresh.session.sessionId);
    if (!added.ok) return refused(403, added.refused);
    return {
      answer: { status: 200, body: { helperId: helper.id, name: record.names[helper.id] ?? "" } },
      next: { ...record, state: added.state, sessions: { ...record.sessions, [fresh.hash]: fresh.session } },
      audit: entry({ kind: "helper", id: helper.id }, SYSTEM, "helper.session_opened", { helperId: helper.id }),
    };
  },

  /// `{ tokenHash }`: whether a helper session still works, and whose it is. Reads only.
  "POST /people/session-check": (record, body, nowMs) => {
    // Only a SHA-256 the record holds as its own key names a session: never a name every object inherits.
    const hash = typeof body.tokenHash === "string" && SHA256_HEX.test(body.tokenHash) ? body.tokenHash : null;
    const session = hash !== null && Object.hasOwn(record.sessions, hash) ? record.sessions[hash] : undefined;
    const unauthorized: SessionCheck = { ok: false, error: "unauthorized" };
    if (!session) return { answer: { status: 200, body: unauthorized } };
    if (session.endedAt !== undefined) {
      return { answer: { status: 200, body: { ok: false, error: "removed", removedAt: session.endedAt } satisfies SessionCheck } };
    }
    const helper = record.state.helpers.find((one) => one.id === session.helperId);
    if (session.expiresAt <= nowMs || !helper?.sessions.includes(session.sessionId)) {
      return { answer: { status: 200, body: unauthorized } };
    }
    return { answer: { status: 200, body: { ok: true, helperId: helper.id, sessionId: session.sessionId,
      name: record.names[helper.id] ?? "" } satisfies SessionCheck } };
  },

  /// `{ helperId, request: { id, kind, decided }, taskId, note }`: a helper hands the owner a request with a note
  /// (`rules.passOn`). It decides nothing. The note stays here, with the request's id; the log names only the ids.
  "POST /people/pass-on": (record, body, nowMs) => {
    const facts = requestFacts(body.request);
    if (!text(body.helperId) || !facts || !text(body.taskId) || typeof body.note !== "string") {
      return refused(400, "invalid_request");
    }
    const passed = rules.passOn(record.state, body.helperId, facts, body.note, nowMs);
    if (!passed.ok) {
      if (passed.refused === "already_decided") return refused(409, "already_decided", { by: passed.by, at: passed.at });
      const status = passed.refused === "not_a_helper" ? 403 : passed.refused === "decide_yourself" ||
        passed.refused === "already_passed" ? 409 : 400;
      return refused(status, passed.refused);
    }
    return {
      answer: { status: 200, body: { passedOn: passed.passed satisfies PassedOn } },
      next: { ...record, state: passed.state },
      audit: entry({ kind: "helper", id: body.helperId }, SYSTEM, "request.passed_on",
        { requestId: facts.id, taskId: body.taskId }),
    };
  },

  /// `{ helperId, actor }`: the owner removes a helper (`rules.removeHelper`): every session of theirs ends in this same
  /// write, their pending invites and their cover go, and their decisions are refused from now on.
  "POST /people/remove": (record, body, nowMs) => {
    if (!text(body.helperId)) return refused(400, "invalid_request");
    const removed = rules.removeHelper(record.state, body.helperId);
    if (!removed.ok) return refused(404, removed.refused);
    const ending = new Set(removed.endSessions);
    const sessions = Object.fromEntries(Object.entries(record.sessions).map(([hash, session]) =>
      [hash, session.helperId === body.helperId && ending.has(session.sessionId) && session.endedAt === undefined
        ? { ...session, endedAt: nowMs } : session]));
    return {
      answer: { status: 200, body: { removed: body.helperId, sessionsEnded: removed.endSessions.length,
        invitesRevoked: removed.revokedInvites, coverEnded: removed.coverEnded } },
      next: { ...record, state: removed.state, sessions },
      audit: entry(body.actor, SYSTEM, "helper.removed", { helperId: body.helperId }),
    };
  },

  /// `{ helperId, until, actor }`: the owner is away until `until` (ms), and one current helper covers
  /// (`rules.setAway`). Cover adds no power: approval-core decides with the same rule whoever covers.
  "POST /people/away": (record, body, nowMs) => {
    if (!text(body.helperId) || typeof body.until !== "number") return refused(400, "invalid_request");
    const set = rules.setAway(record.state, body.helperId, body.until, nowMs);
    if (!set.ok) return refused(set.refused === "not_a_helper" ? 404 : 400, set.refused);
    return {
      answer: { status: 200, body: { away: set.state.away } },
      next: { ...record, state: set.state },
      audit: entry(body.actor, SYSTEM, "away.set", { helperId: body.helperId }),
    };
  },

  /// `{ actor }`: the owner is back (`rules.clearAway`). Clearing when nobody covers changes and records nothing.
  "POST /people/away-clear": (record, body) => {
    if (record.state.away === null) return { answer: { status: 200, body: { away: null } } };
    const covering = record.state.away.helperId;
    return {
      answer: { status: 200, body: { away: null } },
      next: { ...record, state: rules.clearAway(record.state) },
      audit: entry(body.actor, SYSTEM, "away.cleared", { helperId: covering }),
    };
  },
};

/// The facts about a request the rules read, as the Worker found them in the request's own task. Anything else is not
/// a request's facts. The kind is left for the rules to check against approval-core's kinds.
function requestFacts(value: unknown): RequestFacts | null {
  if (!isRecord(value) || !text(value.id) || typeof value.kind !== "string") return null;
  const decided = value.decided;
  if (decided === null) return { id: value.id, kind: value.kind as RequestFacts["kind"], decided: null };
  if (!isRecord(decided) || !text(decided.by) || typeof decided.at !== "number") return null;
  return { id: value.id, kind: value.kind as RequestFacts["kind"], decided: { by: decided.by, at: decided.at } };
}

/// Part of the TenantObject's tenant wipe: the shop's people, their names and every helper session, so deleting a shop
/// signs every helper out of it.
export async function wipePeopleTenant(storage: DurableObjectStorage, tenant: string): Promise<void> {
  await storage.delete(key(tenant));
}
