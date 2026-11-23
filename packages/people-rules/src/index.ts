/// The rules for the people around one shop: the owner and their helpers, invites, passing a request on
/// with a note, cover while the owner is away, and removal. Pure functions over a plain state value, so the
/// server, the desktop and the phone give the same answers. No function throws: a refusal is a result value.
///
/// Who may decide what is not decided here. `mayDecide` in `@manut/approval-core` is the only rule for that;
/// this package only adds who the people are and who is still allowed to act at all. Cover therefore never
/// widens what a helper may decide.

import { APPROVAL_KINDS, mayDecide, type ApprovalKind } from "@manut/approval-core";

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_NOTE_LENGTH = 500;

/// The one identity an invite is bound to. A LINE account id is compared exactly; an email without case.
export type Identity = { readonly kind: "line"; readonly id: string } | { readonly kind: "email"; readonly address: string };

export function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.kind === "line" && b.kind === "line") return a.id === b.id;
  if (a.kind === "email" && b.kind === "email") return a.address.trim().toLowerCase() === b.address.trim().toLowerCase();
  return false;
}

function validIdentity(i: Identity): boolean {
  if (i.kind === "line") return typeof i.id === "string" && i.id.length > 0;
  if (i.kind === "email") return typeof i.address === "string" && /^[^\s@]+@[^\s@]+$/.test(i.address.trim());
  return false;
}

export type InviteStatus = "pending" | "used" | "revoked";

export interface Invite {
  readonly id: string;
  readonly identity: Identity;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: InviteStatus;
}

export interface Helper {
  readonly id: string;
  readonly identity: Identity;
  readonly joinedAt: number;
  /// Every session this helper has open. Removal returns them so the caller can end each one.
  readonly sessions: readonly string[];
}

/// The owner is away until `until` (ms), and `helperId` covers.
export interface Away {
  readonly until: number;
  readonly helperId: string;
}

export interface PassedOn {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  readonly by: string;
  readonly note: string;
  readonly at: number;
}

export interface PeopleState {
  readonly shop: string;
  readonly ownerId: string;
  readonly helpers: readonly Helper[];
  readonly invites: readonly Invite[];
  readonly away: Away | null;
  readonly passedOn: readonly PassedOn[];
  /// Ids of helpers who were removed, so a late decision from one is refused with a clear reason.
  readonly removed: readonly string[];
}

export function emptyPeople(shop: string, ownerId: string): PeopleState {
  return { shop, ownerId, helpers: [], invites: [], away: null, passedOn: [], removed: [] };
}

// ---------------------------------------------------------------- invites

export type InviteRefusal = "bad_identity" | "bad_id" | "already_helper" | "already_invited";

export type InviteResult =
  | { readonly ok: true; readonly state: PeopleState; readonly invite: Invite }
  | { readonly ok: false; readonly refused: InviteRefusal };

/// The owner invites one person. An invite is for one identity, works once, and lasts 7 days.
export function invite(state: PeopleState, id: string, identity: Identity, now: number): InviteResult {
  if (typeof id !== "string" || id.length === 0 || state.invites.some((i) => i.id === id)) return { ok: false, refused: "bad_id" };
  if (!validIdentity(identity)) return { ok: false, refused: "bad_identity" };
  if (state.helpers.some((h) => sameIdentity(h.identity, identity))) return { ok: false, refused: "already_helper" };
  const open = state.invites.some((i) => i.status === "pending" && now < i.expiresAt && sameIdentity(i.identity, identity));
  if (open) return { ok: false, refused: "already_invited" };
  const made: Invite = { id, identity, createdAt: now, expiresAt: now + INVITE_LIFETIME_MS, status: "pending" };
  return { ok: true, state: { ...state, invites: [...state.invites, made] }, invite: made };
}

export type RevokeInviteResult =
  | { readonly ok: true; readonly state: PeopleState }
  | { readonly ok: false; readonly refused: "unknown_invite" | "not_pending" };

export function revokeInvite(state: PeopleState, inviteId: string): RevokeInviteResult {
  const found = state.invites.find((i) => i.id === inviteId);
  if (!found) return { ok: false, refused: "unknown_invite" };
  if (found.status !== "pending") return { ok: false, refused: "not_pending" };
  return { ok: true, state: { ...state, invites: state.invites.map((i) => (i.id === inviteId ? { ...i, status: "revoked" as const } : i)) } };
}

export type AcceptResult =
  | { readonly answer: "joined"; readonly shop: string; readonly state: PeopleState; readonly helper: Helper }
  | { readonly answer: "wrong_account"; readonly shop: string }
  | { readonly answer: "expired" | "already_used" | "revoked" | "unknown" };

/// Someone opens an invite link. Only `joined` and `wrong_account` name the shop: an expired, used, revoked or
/// unknown invite shows nothing about it. Expiry is checked before the account, so a stranger holding an old
/// link learns nothing. A `wrong_account` leaves the invite unused for the person it was meant for.
export function acceptInvite(
  state: PeopleState, inviteId: string, account: Identity, helperId: string, sessionId: string, now: number,
): AcceptResult {
  const found = state.invites.find((i) => i.id === inviteId);
  if (!found) return { answer: "unknown" };
  if (found.status === "revoked") return { answer: "revoked" };
  if (found.status === "used") return { answer: "already_used" };
  if (now >= found.expiresAt) return { answer: "expired" };
  if (!validIdentity(account) || !sameIdentity(found.identity, account)) return { answer: "wrong_account", shop: state.shop };
  const helper: Helper = { id: helperId, identity: found.identity, joinedAt: now, sessions: [sessionId] };
  const next: PeopleState = {
    ...state,
    helpers: [...state.helpers, helper],
    invites: state.invites.map((i) => (i.id === inviteId ? { ...i, status: "used" as const } : i)),
  };
  return { answer: "joined", shop: state.shop, state: next, helper };
}

export type SessionResult =
  | { readonly ok: true; readonly state: PeopleState }
  | { readonly ok: false; readonly refused: "not_a_helper" };

/// A joined helper signs in again on another device: the new session is recorded so removal can end it.
export function addSession(state: PeopleState, helperId: string, sessionId: string): SessionResult {
  if (!state.helpers.some((h) => h.id === helperId)) return { ok: false, refused: "not_a_helper" };
  return {
    ok: true,
    state: { ...state, helpers: state.helpers.map((h) => (h.id === helperId && !h.sessions.includes(sessionId) ? { ...h, sessions: [...h.sessions, sessionId] } : h)) },
  };
}

// ---------------------------------------------------------------- passing on

/// What the caller knows about a request: its kind, and who decided it if anyone has.
export interface RequestFacts {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly decided: { readonly by: string; readonly at: number } | null;
}

export type PassOnResult =
  | { readonly ok: true; readonly state: PeopleState; readonly passed: PassedOn }
  | { readonly ok: false; readonly refused: "not_a_helper" | "unknown_kind" | "bad_note" | "decide_yourself" | "already_passed" }
  | { readonly ok: false; readonly refused: "already_decided"; readonly by: string; readonly at: number };

/// A helper hands the owner a request they may not decide, with a note. Passing on decides nothing: the owner
/// still decides. A request already decided answers who decided and when, because the first decision wins and
/// the other person should see what happened.
export function passOn(state: PeopleState, helperId: string, request: RequestFacts, note: string, now: number): PassOnResult {
  if (!state.helpers.some((h) => h.id === helperId)) return { ok: false, refused: "not_a_helper" };
  if (!(APPROVAL_KINDS as readonly string[]).includes(request.kind)) return { ok: false, refused: "unknown_kind" };
  if (request.decided) return { ok: false, refused: "already_decided", by: request.decided.by, at: request.decided.at };
  if (mayDecide("helper", request.kind)) return { ok: false, refused: "decide_yourself" };
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length < 1 || [...trimmed].length > MAX_NOTE_LENGTH) return { ok: false, refused: "bad_note" };
  if (state.passedOn.some((p) => p.requestId === request.id)) return { ok: false, refused: "already_passed" };
  const passed: PassedOn = { requestId: request.id, kind: request.kind, by: helperId, note: trimmed, at: now };
  return { ok: true, state: { ...state, passedOn: [...state.passedOn, passed] }, passed };
}

// ---------------------------------------------------------------- away and cover

export type AwayResult =
  | { readonly ok: true; readonly state: PeopleState }
  | { readonly ok: false; readonly refused: "not_a_helper" | "bad_date" };

/// The owner is away until `until`, and one current helper covers.
export function setAway(state: PeopleState, helperId: string, until: number, now: number): AwayResult {
  if (!state.helpers.some((h) => h.id === helperId)) return { ok: false, refused: "not_a_helper" };
  if (!Number.isFinite(until) || until <= now) return { ok: false, refused: "bad_date" };
  return { ok: true, state: { ...state, away: { until, helperId } } };
}

export function clearAway(state: PeopleState): PeopleState {
  return state.away ? { ...state, away: null } : state;
}

/// The cover in force at `now`, or null. It ends at its date exactly.
export function coverAt(state: PeopleState, now: number): Away | null {
  return state.away && now < state.away.until && state.helpers.some((h) => h.id === state.away?.helperId) ? state.away : null;
}

export interface Decider {
  readonly id: string;
  readonly role: "owner" | "helper";
  /// True for the helper covering while the owner is away.
  readonly covering: boolean;
}

/// Who may decide a request of `kind` now: the owner always, plus each helper `mayDecide` lets. While the owner
/// is away the covering helper is listed first. Cover adds no power: money, public posts, payment confirmations
/// and commands list the owner alone, and wait for them.
export function deciders(state: PeopleState, kind: ApprovalKind, now: number): readonly Decider[] {
  if (!(APPROVAL_KINDS as readonly string[]).includes(kind)) return [];
  const cover = coverAt(state, now);
  const helpers: Decider[] = mayDecide("helper", kind)
    ? state.helpers.map((h) => ({ id: h.id, role: "helper" as const, covering: cover?.helperId === h.id }))
    : [];
  helpers.sort((a, b) => Number(b.covering) - Number(a.covering));
  const owner: Decider = { id: state.ownerId, role: "owner", covering: false };
  return cover && helpers[0]?.covering ? [...helpers, owner] : [owner, ...helpers];
}

export type CanDecide =
  | { readonly ok: true; readonly role: "owner" | "helper" }
  | { readonly ok: false; readonly refused: "removed" | "unknown_person" | "not_permitted" };

/// The gate for one person's decision. A removed helper is refused with `removed`, whatever the kind.
export function canDecide(state: PeopleState, personId: string, kind: ApprovalKind, now: number): CanDecide {
  if (state.removed.includes(personId)) return { ok: false, refused: "removed" };
  const found = deciders(state, kind, now).find((d) => d.id === personId);
  if (found) return { ok: true, role: found.role };
  if (personId === state.ownerId || state.helpers.some((h) => h.id === personId)) return { ok: false, refused: "not_permitted" };
  return { ok: false, refused: "unknown_person" };
}

// ---------------------------------------------------------------- removal

export type RemoveResult =
  | {
    readonly ok: true;
    readonly state: PeopleState;
    /// Every session of the helper, for the caller to end.
    readonly endSessions: readonly string[];
    readonly revokedInvites: readonly string[];
    readonly coverEnded: boolean;
  }
  | { readonly ok: false; readonly refused: "not_a_helper" };

/// Removing a helper ends every session they have, revokes their pending invites (those bound to their
/// identity) and any cover they hold, and refuses their decisions from then on.
export function removeHelper(state: PeopleState, helperId: string): RemoveResult {
  const helper = state.helpers.find((h) => h.id === helperId);
  if (!helper) return { ok: false, refused: "not_a_helper" };
  const revoked = state.invites.filter((i) => i.status === "pending" && sameIdentity(i.identity, helper.identity)).map((i) => i.id);
  const coverEnded = state.away?.helperId === helperId;
  return {
    ok: true,
    endSessions: helper.sessions,
    revokedInvites: revoked,
    coverEnded,
    state: {
      ...state,
      helpers: state.helpers.filter((h) => h.id !== helperId),
      invites: state.invites.map((i) => (revoked.includes(i.id) ? { ...i, status: "revoked" as const } : i)),
      away: coverEnded ? null : state.away,
      removed: [...state.removed, helperId],
    },
  };
}
