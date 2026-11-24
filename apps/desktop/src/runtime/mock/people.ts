// Practice's people (docs/people.md), so Settings › People can be seen and tried without an API: the design canvas's sample,
// Fon the owner, Mint a helper who joined three weeks ago and Beam, whose invite waits (People.dc.html). They belong to the
// person's own shop; at Ran Pa Noi, the sample shop they help at, only Noi, its owner, sees or changes who can help (host.ts).
//
// The rules are the API's, because they are the same code: `@manut/people-rules` decides every change here as it decides it in
// the shop's record (an invite is for one account and works once, a second invite for the same account is refused while the
// first waits, removal ends every session of the helper's, cover is one current helper until a date in the future). What the
// API's own routes add on top is said again here: a name is 1 to 80 characters with no control characters, and an identity is
// exactly a LINE ID or an email address (`helperNameOf`, `identityOk`, which the connected runtime uses too).
//
// Nothing here is real and nothing leaves the app. An invite's link goes nowhere on purpose: its address ends in `.invalid`, which
// is reserved so that it can never be a real one, so a link copied from Practice cannot be taken for an invite to a real shop.
import {
  clearAway,
  coverAt,
  INVITE_LIFETIME_MS,
  invite as makeInvite,
  removeHelper,
  revokeInvite,
  setAway,
  type PeopleState,
} from "@manut/people-rules";
import { helperNameOf, identityOk, type ShopAway, type ShopInvite, type ShopPeople, type ShopRemoval } from "../people";

export type PeopleResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

const refused = (code: string, message: string): PeopleResult<never> => ({ ok: false, code, message });

/** The address an invite's link has in Practice. `.invalid` never resolves (RFC 2606). */
export const PRACTICE_JOIN = "https://practice.manut.invalid/join/";

/** The owner's name in the sample, as the canvas has her. */
const OWNER = "Fon";
const MINT = "practice-helper-mint";
const BEAM = "practice-invite-beam";

export class PracticePeople {
  private state: PeopleState;
  /** The name the owner gave each invite and helper, by id, as the shop's record keeps them. */
  private names: Record<string, string>;
  private seq = 0;

  /** The sample as it stands at `now` (seconds): Mint joined 22 days ago and is signed in on two devices, and Beam's invite was
   *  made 40 minutes ago, for a LINE ID. */
  constructor(now: number) {
    const made = (now - 40 * MINUTE) * 1000;
    this.state = {
      shop: "practice:own-shop",
      ownerId: "practice-owner",
      helpers: [{ id: MINT, identity: { kind: "email", address: "mint@example.com" }, joinedAt: (now - 22 * DAY) * 1000, sessions: ["practice-session-mint-1", "practice-session-mint-2"] }],
      invites: [{ id: BEAM, identity: { kind: "line", id: "beam.baanmali" }, createdAt: made, expiresAt: made + INVITE_LIFETIME_MS, status: "pending" }],
      away: null,
      passedOn: [],
      removed: [],
    };
    this.names = { [MINT]: "Mint", [BEAM]: "Beam" };
  }

  private invite(i: PeopleState["invites"][number], nowMs: number): ShopInvite | null {
    const waiting = i.status === "pending";
    // An invite past its 7 days is never used, so it reads as ran out whatever the record still says (as the API words it).
    const state = waiting && nowMs >= i.expiresAt ? "expired" : waiting ? "pending" : null;
    if (!state) return null;
    return {
      id: i.id,
      name: this.names[i.id] ?? "",
      identity: i.identity.kind === "line" ? { kind: "line", id: i.identity.id } : { kind: "email", address: i.identity.address },
      state,
      createdAt: i.createdAt / 1000,
      expiresAt: i.expiresAt / 1000,
      link: state === "pending" ? `${PRACTICE_JOIN}${i.id}` : null,
    };
  }

  private cover(nowMs: number): ShopAway | null {
    const away = this.state.away;
    if (!away) return null;
    return { helperId: away.helperId, name: this.names[away.helperId] ?? "", until: away.until / 1000, inForce: coverAt(this.state, nowMs) !== null };
  }

  /** The shop's people at `now` (seconds), each a copy the caller cannot change them through. Invites newest first. */
  list(shop: string, now: number): ShopPeople {
    const nowMs = now * 1000;
    return {
      shop,
      owner: { name: OWNER, devices: 1 },
      helpers: this.state.helpers.map((h) => ({
        id: h.id,
        name: this.names[h.id] ?? "",
        identity: h.identity.kind === "line" ? { kind: "line", id: h.identity.id } : { kind: "email", address: h.identity.address },
        joinedAt: h.joinedAt / 1000,
        devices: h.sessions.length,
      })),
      invites: this.state.invites
        .map((i) => this.invite(i, nowMs))
        .filter((i): i is ShopInvite => i !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
      away: this.cover(nowMs),
    };
  }

  /** An invite for one account, made at `now` (seconds). Its link is the one thing the owner sends. */
  makeInvite(name: unknown, identity: unknown, now: number): PeopleResult<ShopInvite> {
    const kept = helperNameOf(name);
    if (!kept) return refused("invalid_name", "A name is 1 to 80 letters.");
    const who = identityOk(identity);
    if (!who) return refused("bad_identity", "Write a LINE ID, or an email address.");
    const id = `practice-invite-${++this.seq}`;
    const made = makeInvite(this.state, id, who, now * 1000);
    if (!made.ok) return refused(made.refused, `The invite was refused: ${made.refused}.`);
    this.state = made.state;
    this.names = { ...this.names, [id]: kept };
    const shown = this.invite(made.invite, now * 1000);
    return shown ? { ok: true, value: shown } : refused("unavailable", "The invite could not be shown.");
  }

  /** Cancels an invite that waits. */
  cancelInvite(inviteId: unknown): PeopleResult<string> {
    const id = typeof inviteId === "string" ? inviteId : "";
    const done = revokeInvite(this.state, id);
    if (!done.ok) return refused(done.refused, done.refused === "unknown_invite" ? "That invite is gone." : "That invite was already used or cancelled.");
    this.state = done.state;
    return { ok: true, value: id };
  }

  /** Removes a helper: every session of theirs ends, their invites and their cover go, and their name stays with what they did. */
  remove(helperId: unknown): PeopleResult<ShopRemoval> {
    const id = typeof helperId === "string" ? helperId : "";
    const done = removeHelper(this.state, id);
    if (!done.ok) return refused(done.refused, "That person is not a helper.");
    this.state = done.state;
    return { ok: true, value: { helper: id, sessionsEnded: done.endSessions.length, invitesRevoked: done.revokedInvites.length, coverEnded: done.coverEnded } };
  }

  /** One current helper covers messages until `until` (seconds), which must be after `now`. */
  setAway(helperId: unknown, until: unknown, now: number): PeopleResult<ShopAway> {
    const id = typeof helperId === "string" ? helperId : "";
    const done = setAway(this.state, id, typeof until === "number" ? until * 1000 : Number.NaN, now * 1000);
    if (!done.ok) return refused(done.refused, done.refused === "bad_date" ? "Choose a day that has not passed yet." : "That person is not a helper.");
    this.state = done.state;
    const cover = this.cover(now * 1000);
    return cover ? { ok: true, value: cover } : refused("unavailable", "The cover could not be shown.");
  }

  /** Ends the cover, whoever it was for. */
  clearAway(): PeopleResult<null> {
    this.state = clearAway(this.state);
    return { ok: true, value: null };
  }
}
