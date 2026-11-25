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
///   have run out, so the record stays small, and a helper has at most `rules.MAX_HELPER_SESSIONS` open: one more ends
///   their oldest. The owner's account is capped the same way (`MAX_OWNER_SESSIONS`).
/// - `ownerAccount` and `ownerSessions`: the account the shop's owner signs in with, once the operator linked it, and
///   every owner shop session, by the SHA-256 of its token (docs/several-shops.md). Unlinking the account marks each of
///   its sessions ended in the same write, as removal does for a helper's. Both are absent until an account is linked.
/// - `signIns`: the sign-ins helpers made lately, newest first, one for each helper session opened, so the owner's app can
///   tell them once of a new device (docs/people.md, "A helper's new device"). A sign-in is only a session's id, whose it
///   is and when, never the token or its hash, and it is not a session: nothing that checks a session reads it. It is
///   written in the same change as the session it names, and signing out or removing the helper leaves it, so the owner
///   still hears of a sign-in that was over before their app looked. It is dropped when it is older than a session lasts
///   and beyond the newest `MAX_SIGN_INS`, at the next change.
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

/// The shop's owner in the rules' state, one id whatever they act through: the shop's own session, its owner's link, or
/// an owner session of the account the operator linked (`ownerAccount` below; docs/people.md, "Who is deciding").
export const OWNER_ID = "owner";

/// One helper session: whose it is, which of their sessions in the rules' state, when it runs out, and when it was
/// ended by the helper's removal.
export type HelperSession = { sessionId: string; helperId: string; expiresAt: number; endedAt?: number };

/// The account the shop's owner signs in with, linked by the operator (docs/several-shops.md): the link's id, which the
/// audit log and the owner's decisions name; the verified provider subject the account signs in as (`apple:<sub>`, the
/// lifted session's tenant), which only the shop's own export carries out of the backend; and when it was linked.
export type OwnerAccount = { id: string; subject: string; linkedAt: number };

/// One owner shop session: the linked account it belongs to, when it runs out, and when unlinking ended it.
export type OwnerSession = { sessionId: string; accountId: string; expiresAt: number; endedAt?: number };

/// One sign-in a helper made: the id of the session it opened, whose it is, and when, by the object's own clock.
export type HelperSignIn = { sessionId: string; helperId: string; at: number };

/// How long a sign-in is listed: as long as a session lasts (`HELPER_SESSION_TTL_MS`, people.ts, which a test keeps equal),
/// since what the owner is told is that a session was opened that could still be open.
export const SIGN_IN_LISTED_MS = 30 * 24 * 3600 * 1000;
/// The most sign-ins the record keeps, the newest ones, so a helper who signs in over and over cannot grow it.
export const MAX_SIGN_INS = 50;
/// The most owner sessions the linked account has open at once, one for each device, as a helper's are capped
/// (`rules.MAX_HELPER_SESSIONS`): opening one more ends the oldest, so the owner's own sign-ins never grow the record either.
export const MAX_OWNER_SESSIONS = rules.MAX_HELPER_SESSIONS;

export type PeopleRecord = {
  state: PeopleState;
  names: Record<string, string>;
  sessions: Record<string, HelperSession>;
  /// Absent until the operator links the owner's account, and again once they unlink it.
  ownerAccount?: OwnerAccount;
  /// Absent on a record no owner session was ever opened for.
  ownerSessions?: Record<string, OwnerSession>;
  /// Newest first. Absent on a record written before sign-ins were kept, which lists none.
  signIns?: HelperSignIn[];
};

/// What the Worker reads: the rules' state, the names, how many sessions each helper has running now, the owner's linked
/// account with how many of its sessions run now, and the sign-ins to tell the owner of (`listedSignIns`). Never a hash.
export type PeopleView = { state: PeopleState; names: Record<string, string>; devices: Record<string, number>;
  ownerAccount: OwnerAccount | null; ownerDevices: number; signIns: HelperSignIn[] };

/// What checking a helper session answers.
export type SessionCheck =
  | { ok: true; helperId: string; sessionId: string; name: string }
  | { ok: false; error: "unauthorized" }
  | { ok: false; error: "removed"; removedAt: number };

/// What checking an owner shop session answers: whose it is, or that unlinking ended it and when.
export type OwnerSessionCheck =
  | { ok: true; accountId: string; sessionId: string }
  | { ok: false; error: "unauthorized" }
  | { ok: false; error: "unlinked"; unlinkedAt: number };

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

/// The sessions still worth keeping at `nowMs`: every one that has not reached its end. A session removal or unlinking
/// ended is kept until then too, so a late request with it is told why it no longer works.
function livingSessions<T extends { expiresAt: number }>(sessions: Record<string, T>, nowMs: number): Record<string, T> {
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

/// Whether an owner session still works at `nowMs`: not ended, not run out, and of the account linked now.
function ownerSessionLive(record: PeopleRecord, session: OwnerSession, nowMs: number): boolean {
  return session.endedAt === undefined && session.expiresAt > nowMs && session.accountId === record.ownerAccount?.id;
}

function ownerDevicesOf(record: PeopleRecord, nowMs: number): number {
  return Object.values(record.ownerSessions ?? {}).filter((session) => ownerSessionLive(record, session, nowMs)).length;
}

/// The sign-ins worth keeping at `nowMs`: the newest ones, and none older than a session lasts. `signIns` is newest first.
function recentSignIns(signIns: readonly HelperSignIn[], nowMs: number): HelperSignIn[] {
  return signIns.filter((one) => one.at > nowMs - SIGN_IN_LISTED_MS).slice(0, MAX_SIGN_INS);
}

/// The sign-ins to tell the owner of at `nowMs`: the recent ones of helpers the shop still has. A removed helper's are
/// left out (the owner has just dealt with them), and so is any entry whose helper the record does not know.
function listedSignIns(record: PeopleRecord, nowMs: number): HelperSignIn[] {
  const helpers = new Set(record.state.helpers.map((helper) => helper.id));
  return recentSignIns(record.signIns ?? [], nowMs).filter((one) => helpers.has(one.helperId));
}

/// The record's sign-ins with the one `session` just made in front. The central write trims them (`recentSignIns`).
function withSignIn(record: PeopleRecord, session: HelperSession, nowMs: number): HelperSignIn[] {
  return [{ sessionId: session.sessionId, helperId: session.helperId, at: nowMs }, ...(record.signIns ?? [])];
}

/// What a session that is not one this record holds, or no longer works, is answered. Both kinds of check answer it.
const UNAUTHORIZED = { ok: false, error: "unauthorized" } as const;

/// The session a request names, with the hash it is kept under. Only a SHA-256 the record holds as its own key names a
/// session: never a name every object inherits.
function heldSession<T>(sessions: Record<string, T>, tokenHash: unknown): { hash: string; session: T } | null {
  if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash) || !Object.hasOwn(sessions, tokenHash)) return null;
  const session = sessions[tokenHash];
  return session ? { hash: tokenHash, session } : null;
}

/// Whether a helper session still works at `nowMs`, and whose it is, or why not: removal ended it, or it is unknown, ran
/// out, or is no longer one of the helper's open sessions. One answer for the check a route makes and for ending the
/// session, so the two can never disagree about which tokens still work.
function checkHelperSession(record: PeopleRecord, session: HelperSession, nowMs: number): SessionCheck {
  if (session.endedAt !== undefined) return { ok: false, error: "removed", removedAt: session.endedAt };
  const helper = record.state.helpers.find((one) => one.id === session.helperId);
  if (session.expiresAt <= nowMs || !helper?.sessions.includes(session.sessionId)) return UNAUTHORIZED;
  return { ok: true, helperId: helper.id, sessionId: session.sessionId, name: record.names[helper.id] ?? "" };
}

/// The same for an owner session: unlinking ended it, or it is unknown, ran out, or is of an account no longer linked.
function checkOwnerSession(record: PeopleRecord, session: OwnerSession, nowMs: number): OwnerSessionCheck {
  if (session.endedAt !== undefined) return { ok: false, error: "unlinked", unlinkedAt: session.endedAt };
  if (!ownerSessionLive(record, session, nowMs)) return UNAUTHORIZED;
  return { ok: true, accountId: session.accountId, sessionId: session.sessionId };
}

/// Whether the shop session whose token hashes to `tokenHash` still works at `nowMs`, a helper's or an owner's, by the
/// same checks the routes make (`checkHelperSession`, `checkOwnerSession`). The shop's live feed (feed.ts) asks before
/// each ping and after each change to the record, and closes a socket whose session no longer works, so a helper the
/// owner removed, a device that signed out or an account the operator unlinked hears nothing more from the shop.
export function shopSessionWorks(kv: SyncKvStorage, tenant: string, tokenHash: string, nowMs: number): boolean {
  const record = readRecord(kv, tenant);
  const helper = heldSession(record.sessions, tokenHash);
  if (helper) return checkHelperSession(record, helper.session, nowMs).ok;
  const owner = heldSession(record.ownerSessions ?? {}, tokenHash);
  return owner ? checkOwnerSession(record, owner.session, nowMs).ok : false;
}

/// `/people` and `/people/*` on a TenantObject. Reads need only the tenant; writes need the Worker's `x-people` header.
/// `changed` hears each write that changed the record, once it is stored, and never a check that only read it, so the
/// shop's live feed pings for what changed and a session check never wakes a desktop (tenant-object.ts).
export async function peopleTenantRoute(storage: DurableObjectStorage, request: Request, url: URL,
  changed?: () => void): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    const record = readRecord(storage.kv, tenant);
    if (route === "GET /people") {
      const nowMs = Date.now();
      return json({ state: record.state, names: record.names, devices: devicesOf(record, nowMs),
        ownerAccount: record.ownerAccount ?? null, ownerDevices: ownerDevicesOf(record, nowMs),
        signIns: listedSignIns(record, nowMs) } satisfies PeopleView);
    }
    // The export carries who the people are, the owner's linked account and what helpers passed on, never a session's
    // hash.
    if (route === "GET /people/export") {
      return json({ state: record.state, names: record.names, ownerAccount: record.ownerAccount ?? null });
    }
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
  let wrote = false;
  const answer = storage.transactionSync((): Answer => {
    const kv = storage.kv;
    const nowMs = Date.now();
    const before = readRecord(kv, tenant);
    const done = operation(before, body, nowMs);
    if (done.next) {
      const { ownerSessions, signIns } = done.next;
      kv.put(key(tenant), { ...done.next, sessions: livingSessions(done.next.sessions, nowMs),
        ...(ownerSessions ? { ownerSessions: livingSessions(ownerSessions, nowMs) } : {}),
        ...(signIns ? { signIns: recentSignIns(signIns, nowMs) } : {}) } satisfies PeopleRecord);
      const { record, missed } = done.audit ?? {};
      if (missed) auditPutSync(kv, tenant, record ?? null, missed);
      wrote = true;
    }
    return done.answer;
  });
  // After the transaction, so only a change that was stored is heard: a throw inside it rolls the write back.
  if (wrote) changed?.();
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

/// The hash, the id and the end the Worker chose for a new session, or null when they are not one.
function sessionFields(body: Record<string, unknown>): { hash: string; sessionId: string; expiresAt: number } | null {
  const { tokenHash, sessionId, expiresAt } = body;
  if (typeof tokenHash !== "string" || !SHA256_HEX.test(tokenHash) || !text(sessionId) || !isTime(expiresAt)) return null;
  return { hash: tokenHash, sessionId, expiresAt };
}

/// A new helper session for `helperId`, from the hash, the id and the end the Worker chose.
function newSession(body: Record<string, unknown>, helperId: string): { hash: string; session: HelperSession } | null {
  const fields = sessionFields(body);
  return fields ? { hash: fields.hash, session: { sessionId: fields.sessionId, helperId, expiresAt: fields.expiresAt } } : null;
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
      // The rest of the record is kept as it was: a helper joining must never drop the owner's linked account or its
      // sessions (docs/several-shops.md).
      next: {
        ...record,
        state: answered.state,
        names: { ...record.names, [answered.helper.id]: name },
        sessions: { ...record.sessions, [fresh.hash]: fresh.session },
        // A join is the helper's first device, and the owner is told of it as of any other (docs/people.md).
        signIns: withSignIn(record, fresh.session, nowMs),
      },
      audit: entry({ kind: "helper", id: answered.helper.id }, SYSTEM, "helper.joined",
        { inviteId: body.inviteId, helperId: answered.helper.id }),
    };
  },

  /// `{ account, sessionId, tokenHash, expiresAt }`: a helper opens the shop on another device, signed in as the
  /// identity they joined with (`rules.addSession`). Anyone else is not a helper of this shop.
  "POST /people/open-session": (record, body, nowMs) => {
    const account = keptIdentity(body.account);
    const helper = account ? record.state.helpers.find((one) => rules.sameIdentity(one.identity, account)) : undefined;
    if (!helper) return refused(403, "not_a_helper");
    const fresh = newSession(body, helper.id);
    if (!fresh) return refused(400, "invalid_request");
    const added = rules.addSession(record.state, helper.id, fresh.session.sessionId);
    if (!added.ok) return refused(403, added.refused);
    // Past the rules' cap (`rules.MAX_HELPER_SESSIONS`) the helper's oldest sessions end, as signing out of a device ends
    // one: they leave the record, so their tokens are unknown from now on.
    const ended = new Set(added.ended);
    const sessions = Object.fromEntries(Object.entries(record.sessions).filter(([, session]) =>
      !(session.helperId === helper.id && ended.has(session.sessionId))));
    return {
      answer: { status: 200, body: { helperId: helper.id, name: record.names[helper.id] ?? "" } },
      next: { ...record, state: added.state, sessions: { ...sessions, [fresh.hash]: fresh.session },
        signIns: withSignIn(record, fresh.session, nowMs) },
      audit: entry({ kind: "helper", id: helper.id }, SYSTEM, "helper.session_opened", { helperId: helper.id }),
    };
  },

  /// `{ tokenHash }`: whether a helper session still works, and whose it is. Reads only.
  "POST /people/session-check": (record, body, nowMs) => {
    const held = heldSession(record.sessions, body.tokenHash);
    return { answer: { status: 200, body: held ? checkHelperSession(record, held.session, nowMs) : UNAUTHORIZED } };
  },

  /// `{ tokenHash }`: a device signs the helper out: that one session ends, and no other. It leaves the record altogether,
  /// and its id leaves the helper's open sessions (`rules.endSession`), in one write with its audit entry. It is not kept
  /// as ended, as removal keeps a session, because nothing removed the helper: the token is simply unknown from now on.
  /// A session that no longer works is answered as a check answers it, and nothing is written.
  "POST /people/end-helper-session": (record, body, nowMs) => {
    const held = heldSession(record.sessions, body.tokenHash);
    if (!held) return { answer: { status: 200, body: UNAUTHORIZED } };
    const checked = checkHelperSession(record, held.session, nowMs);
    if (!checked.ok) return { answer: { status: 200, body: checked } };
    const ended = rules.endSession(record.state, checked.helperId, checked.sessionId);
    if (!ended.ok) return { answer: { status: 200, body: UNAUTHORIZED } };
    const { [held.hash]: _signedOut, ...sessions } = record.sessions;
    return {
      answer: { status: 200, body: checked },
      next: { ...record, state: ended.state, sessions },
      audit: entry({ kind: "helper", id: checked.helperId }, SYSTEM, "helper.session_ended", { helperId: checked.helperId }),
    };
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

  /// `{ accountId, subject, actor }`: the operator links the account the owner signs in with (docs/several-shops.md),
  /// named by the code the owner sent them. A shop has one linked account at a time: another is refused until the
  /// operator unlinks this one, and the same one again changes and records nothing.
  "POST /people/link-owner": (record, body, nowMs) => {
    if (!text(body.accountId) || !text(body.subject)) return refused(400, "invalid_request");
    const current = record.ownerAccount;
    if (current) {
      return current.subject === body.subject ? { answer: { status: 200, body: { ownerAccount: current } } }
        : refused(409, "already_linked");
    }
    const ownerAccount: OwnerAccount = { id: body.accountId, subject: body.subject, linkedAt: nowMs };
    return {
      answer: { status: 200, body: { ownerAccount } },
      next: { ...record, ownerAccount },
      audit: entry(body.actor, SYSTEM, "owner.linked", { ownerAccountId: ownerAccount.id }),
    };
  },

  /// `{ actor }`: the operator unlinks the owner's account. Every one of its sessions still running ends in this same
  /// write, so the account is signed out of this shop on every device at once. Nothing about another shop changes.
  "POST /people/unlink-owner": (record, body, nowMs) => {
    const current = record.ownerAccount;
    if (!current) return refused(404, "not_linked");
    let ended = 0;
    const ownerSessions = Object.fromEntries(Object.entries(record.ownerSessions ?? {}).map(([hash, session]) => {
      if (!ownerSessionLive(record, session, nowMs)) return [hash, session];
      ended++;
      return [hash, { ...session, endedAt: nowMs }];
    }));
    const { ownerAccount: _unlinked, ...rest } = record;
    return {
      // The subject goes back to the Worker only, which takes the shop out of that account's index (shops.ts).
      answer: { status: 200, body: { unlinked: current.id, subject: current.subject, sessionsEnded: ended } },
      next: { ...rest, ownerSessions },
      audit: entry(body.actor, SYSTEM, "owner.unlinked", { ownerAccountId: current.id }),
    };
  },

  /// `{ subject, sessionId, tokenHash, expiresAt }`: the linked account opens the shop on a device. Anyone else is not
  /// this shop's owner, whatever they hold for another shop. Past `MAX_OWNER_SESSIONS` the account's oldest live sessions
  /// end, as signing out of a device ends one: they leave the record. Every session lasts as long, so the oldest are the
  /// ones that run out first.
  "POST /people/open-owner-session": (record, body, nowMs) => {
    const account = record.ownerAccount;
    if (!text(body.subject) || !account || account.subject !== body.subject) return refused(403, "not_the_owner");
    const fields = sessionFields(body);
    if (!fields) return refused(400, "invalid_request");
    const session: OwnerSession = { sessionId: fields.sessionId, accountId: account.id, expiresAt: fields.expiresAt };
    const live = Object.entries(record.ownerSessions ?? {}).filter(([, one]) => ownerSessionLive(record, one, nowMs))
      .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
    const ending = new Set(live.slice(0, Math.max(0, live.length + 1 - MAX_OWNER_SESSIONS)).map(([hash]) => hash));
    const kept = Object.fromEntries(Object.entries(record.ownerSessions ?? {}).filter(([hash]) => !ending.has(hash)));
    return {
      answer: { status: 200, body: { accountId: account.id } },
      next: { ...record, ownerSessions: { ...kept, [fields.hash]: session } },
      audit: entry({ kind: "owner", id: account.id }, SYSTEM, "owner.session_opened", { ownerAccountId: account.id }),
    };
  },

  /// `{ tokenHash }`: whether an owner session still works, and whose it is. Reads only.
  "POST /people/owner-session-check": (record, body, nowMs) => {
    const held = heldSession(record.ownerSessions ?? {}, body.tokenHash);
    return { answer: { status: 200, body: held ? checkOwnerSession(record, held.session, nowMs) : UNAUTHORIZED } };
  },

  /// `{ tokenHash }`: a device signs the owner's account out of this shop: that one session ends, and no other, in one
  /// write with its audit entry. It leaves the record altogether, because nothing unlinked the account: the token is
  /// simply unknown from now on, and does not say "unlinked". A session that no longer works is answered as a check
  /// answers it, and nothing is written.
  "POST /people/end-owner-session": (record, body, nowMs) => {
    const sessions = record.ownerSessions ?? {};
    const held = heldSession(sessions, body.tokenHash);
    if (!held) return { answer: { status: 200, body: UNAUTHORIZED } };
    const checked = checkOwnerSession(record, held.session, nowMs);
    if (!checked.ok) return { answer: { status: 200, body: checked } };
    const { [held.hash]: _signedOut, ...ownerSessions } = sessions;
    return {
      answer: { status: 200, body: checked },
      next: { ...record, ownerSessions },
      audit: entry({ kind: "owner", id: checked.accountId }, SYSTEM, "owner.session_ended",
        { ownerAccountId: checked.accountId }),
    };
  },
};

/// The people record of a shop its owner made themselves (docs/several-shops.md, "A shop its owner makes"), and the key it
/// goes under, for pilot-store.ts to put in the same write as the shop itself: the shop starts with its owner's account
/// linked and that device's first owner session open, and with no helpers. `owner` is what the Worker sends, `{ accountId,
/// subject, sessionId, tokenHash, expiresAt }`; null when it is not that, so a shop is never made half owned. The record is
/// the one `link-owner` and `open-owner-session` would leave on a new shop, so every later change reads it as one of theirs.
export function ownerMadeRecord(tenant: string, owner: unknown, nowMs: number):
  { key: string; record: PeopleRecord; accountId: string } | null {
  if (!isRecord(owner) || !isValidTenant(tenant) || !text(owner.accountId) || !isValidTenant(owner.subject)) return null;
  const fields = sessionFields(owner);
  if (!fields) return null;
  const ownerAccount: OwnerAccount = { id: owner.accountId, subject: owner.subject, linkedAt: nowMs };
  const session: OwnerSession = { sessionId: fields.sessionId, accountId: ownerAccount.id, expiresAt: fields.expiresAt };
  return {
    key: key(tenant),
    record: { state: rules.emptyPeople(tenant, OWNER_ID), names: {}, sessions: {}, ownerAccount,
      ownerSessions: { [fields.hash]: session } },
    accountId: ownerAccount.id,
  };
}

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
