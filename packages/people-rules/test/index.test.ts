import { describe, expect, it } from "vitest";
import { APPROVAL_KINDS, type ApprovalKind } from "@manut/approval-core";
import {
  INVITE_LIFETIME_MS, MAX_HELPER_SESSIONS, acceptInvite, addSession, canDecide, clearAway, coverAt, deciders, emptyPeople,
  endSession, invite, passOn, removeHelper, revokeInvite, sameIdentity, setAway, type Identity, type PeopleState,
} from "../src/index";

const DAY = 24 * 60 * 60 * 1000;
const nam: Identity = { kind: "line", id: "Uabc" };
const email: Identity = { kind: "email", address: "Pim@Shop.example" };

function base(): PeopleState { return emptyPeople("shop-1", "owner-1"); }
function invited(s: PeopleState, id: string, who: Identity, now = 0): PeopleState {
  const r = invite(s, id, who, now);
  if (!r.ok) throw new Error("invite refused");
  return r.state;
}
function joined(s: PeopleState, inviteId: string, who: Identity, helperId: string, session: string, now = 1): PeopleState {
  const r = acceptInvite(s, inviteId, who, helperId, session, now);
  if (r.answer !== "joined") throw new Error("not joined: " + r.answer);
  return r.state;
}
/// An owner with two helpers, nam (LINE) and pim (email).
function team(): PeopleState {
  let s = invited(base(), "i1", nam);
  s = joined(s, "i1", nam, "h-nam", "s-nam-1");
  s = invited(s, "i2", email);
  return joined(s, "i2", { kind: "email", address: "pim@shop.example" }, "h-pim", "s-pim-1");
}

describe("identities", () => {
  it("compares a LINE id exactly and an email without case", () => {
    expect(sameIdentity(nam, { kind: "line", id: "Uabc" })).toBe(true);
    expect(sameIdentity(nam, { kind: "line", id: "uabc" })).toBe(false);
    expect(sameIdentity(email, { kind: "email", address: " pim@shop.example " })).toBe(true);
    expect(sameIdentity(nam, { kind: "email", address: "Uabc" })).toBe(false);
  });
});

describe("invite", () => {
  it("makes an invite that lasts 7 days", () => {
    const r = invite(base(), "i1", nam, 100);
    expect(r.ok && r.invite).toMatchObject({ status: "pending", createdAt: 100, expiresAt: 100 + 7 * DAY });
    expect(INVITE_LIFETIME_MS).toBe(7 * DAY);
  });
  it("refuses a bad identity, a bad or repeated id, a current helper and a second open invite", () => {
    expect(invite(base(), "i1", { kind: "email", address: "nope" }, 0)).toEqual({ ok: false, refused: "bad_identity" });
    expect(invite(base(), "i1", { kind: "line", id: "" }, 0)).toEqual({ ok: false, refused: "bad_identity" });
    expect(invite(base(), "", nam, 0)).toEqual({ ok: false, refused: "bad_id" });
    const s = invited(base(), "i1", nam);
    expect(invite(s, "i1", email, 1)).toEqual({ ok: false, refused: "bad_id" });
    expect(invite(s, "i2", { kind: "line", id: "Uabc" }, 1)).toEqual({ ok: false, refused: "already_invited" });
    expect(invite(joined(s, "i1", nam, "h", "s"), "i3", nam, 2)).toEqual({ ok: false, refused: "already_helper" });
  });
  it("allows a new invite once the old one has expired", () => {
    const s = invited(base(), "i1", nam, 0);
    expect(invite(s, "i2", nam, 7 * DAY).ok).toBe(true);
  });
});

describe("acceptInvite", () => {
  it("joins the right account once and records the session", () => {
    const s = invited(base(), "i1", nam);
    const r = acceptInvite(s, "i1", nam, "h1", "sess-1", 5);
    expect(r.answer).toBe("joined");
    if (r.answer !== "joined") return;
    expect(r.shop).toBe("shop-1");
    expect(r.state.helpers).toEqual([{ id: "h1", identity: nam, joinedAt: 5, sessions: ["sess-1"] }]);
    expect(acceptInvite(r.state, "i1", nam, "h2", "sess-2", 6)).toEqual({ answer: "already_used" });
  });
  it("accepts an email in another case", () => {
    const s = invited(base(), "i1", email);
    expect(acceptInvite(s, "i1", { kind: "email", address: "PIM@shop.EXAMPLE" }, "h", "s", 1).answer).toBe("joined");
  });
  it("says wrong_account with the shop, and leaves the invite usable", () => {
    const s = invited(base(), "i1", nam);
    expect(acceptInvite(s, "i1", { kind: "line", id: "Uother" }, "h", "s", 1)).toEqual({ answer: "wrong_account", shop: "shop-1" });
    expect(acceptInvite(s, "i1", { kind: "email", address: "x@y.z" }, "h", "s", 1).answer).toBe("wrong_account");
    expect(acceptInvite(s, "i1", nam, "h", "s", 2).answer).toBe("joined");
  });
  it("expires at exactly 7 days and shows nothing about the shop, even to the wrong account", () => {
    const s = invited(base(), "i1", nam, 0);
    expect(acceptInvite(s, "i1", nam, "h", "s", 7 * DAY - 1).answer).toBe("joined");
    expect(acceptInvite(s, "i1", nam, "h", "s", 7 * DAY)).toEqual({ answer: "expired" });
    expect(acceptInvite(s, "i1", { kind: "line", id: "Uother" }, "h", "s", 8 * DAY)).toEqual({ answer: "expired" });
  });
  it("says revoked and shows nothing about the shop", () => {
    const s = invited(base(), "i1", nam);
    const r = revokeInvite(s, "i1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(acceptInvite(r.state, "i1", nam, "h", "s", 1)).toEqual({ answer: "revoked" });
    expect(acceptInvite(r.state, "i1", { kind: "line", id: "Uother" }, "h", "s", 1)).toEqual({ answer: "revoked" });
  });
  it("says unknown for an invite that was never made", () => {
    expect(acceptInvite(base(), "nope", nam, "h", "s", 1)).toEqual({ answer: "unknown" });
  });
  it("refuses to revoke an unknown or an already used invite", () => {
    const s = invited(base(), "i1", nam);
    expect(revokeInvite(s, "zz")).toEqual({ ok: false, refused: "unknown_invite" });
    expect(revokeInvite(joined(s, "i1", nam, "h", "s"), "i1")).toEqual({ ok: false, refused: "not_pending" });
  });
});

describe("passOn", () => {
  const money = { id: "r1", kind: "money" as const, decided: null };
  it("passes a request the helper may not decide, with a trimmed note, and decides nothing", () => {
    const r = passOn(team(), "h-nam", money, "  Customer wants a refund of 500 baht  ", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.passed).toEqual({ requestId: "r1", kind: "money", by: "h-nam", note: "Customer wants a refund of 500 baht", at: 50 });
    expect(deciders(r.state, "money", 60).map((d) => d.id)).toEqual(["owner-1"]);
  });
  it("answers decide_yourself for kinds a helper may decide", () => {
    expect(passOn(team(), "h-nam", { id: "r2", kind: "reply", decided: null }, "hi", 1)).toEqual({ ok: false, refused: "decide_yourself" });
    expect(passOn(team(), "h-nam", { id: "r2", kind: "message", decided: null }, "hi", 1)).toEqual({ ok: false, refused: "decide_yourself" });
  });
  it("answers already_decided with who and when, before anything else", () => {
    const decided = { id: "r3", kind: "reply" as const, decided: { by: "owner-1", at: 9 } };
    expect(passOn(team(), "h-nam", decided, "", 10)).toEqual({ ok: false, refused: "already_decided", by: "owner-1", at: 9 });
    expect(passOn(team(), "h-nam", { ...money, decided: { by: "owner-1", at: 9 } }, "note", 10)).toMatchObject({ refused: "already_decided" });
  });
  it("refuses a note of 0 or over 500 characters and accepts exactly 500", () => {
    expect(passOn(team(), "h-nam", money, "", 1)).toEqual({ ok: false, refused: "bad_note" });
    expect(passOn(team(), "h-nam", money, "   ", 1)).toEqual({ ok: false, refused: "bad_note" });
    expect(passOn(team(), "h-nam", money, "x".repeat(501), 1)).toEqual({ ok: false, refused: "bad_note" });
    expect(passOn(team(), "h-nam", money, "x".repeat(500), 1).ok).toBe(true);
    expect(passOn(team(), "h-nam", money, "ก".repeat(500), 1).ok).toBe(true);
  });
  it("refuses a stranger, an unknown kind and a second pass", () => {
    expect(passOn(team(), "nobody", money, "n", 1)).toEqual({ ok: false, refused: "not_a_helper" });
    expect(passOn(team(), "h-nam", { id: "r", kind: "wire" as unknown as ApprovalKind, decided: null }, "n", 1)).toEqual({ ok: false, refused: "unknown_kind" });
    const first = passOn(team(), "h-nam", money, "n", 1);
    if (!first.ok) throw new Error("expected ok");
    expect(passOn(first.state, "h-pim", money, "again", 2)).toEqual({ ok: false, refused: "already_passed" });
  });
});

describe("away and cover", () => {
  it("lists the owner and helpers for what a helper may decide, and the owner alone for the rest", () => {
    const s = team();
    expect(deciders(s, "reply", 0).map((d) => d.id)).toEqual(["owner-1", "h-nam", "h-pim"]);
    for (const kind of ["money", "public_post", "payment_confirmation", "command"] as const) {
      expect(deciders(s, kind, 0)).toEqual([{ id: "owner-1", role: "owner", covering: false }]);
    }
    expect(deciders(s, "wire" as unknown as ApprovalKind, 0)).toEqual([]);
  });
  it("puts the covering helper first while away, and never gives them money or posts", () => {
    const r = setAway(team(), "h-pim", 10 * DAY, 0);
    if (!r.ok) throw new Error("expected ok");
    expect(deciders(r.state, "reply", DAY).map((d) => [d.id, d.covering])).toEqual([["h-pim", true], ["h-nam", false], ["owner-1", false]]);
    for (const kind of APPROVAL_KINDS.filter((k) => !mayHelper(k))) {
      expect(deciders(r.state, kind, DAY).map((d) => d.id)).toEqual(["owner-1"]);
      expect(canDecide(r.state, "h-pim", kind, DAY)).toEqual({ ok: false, refused: "not_permitted" });
    }
    expect(canDecide(r.state, "h-pim", "reply", DAY)).toEqual({ ok: true, role: "helper" });
  });
  it("ends cover on its date exactly", () => {
    const r = setAway(team(), "h-pim", 10 * DAY, 0);
    if (!r.ok) throw new Error("expected ok");
    expect(coverAt(r.state, 10 * DAY - 1)?.helperId).toBe("h-pim");
    expect(coverAt(r.state, 10 * DAY)).toBeNull();
    expect(deciders(r.state, "reply", 10 * DAY).map((d) => d.id)).toEqual(["owner-1", "h-nam", "h-pim"]);
  });
  it("refuses cover by a stranger or to a date that is not in the future, and clears", () => {
    expect(setAway(team(), "nobody", DAY, 0)).toEqual({ ok: false, refused: "not_a_helper" });
    expect(setAway(team(), "h-nam", 5, 5)).toEqual({ ok: false, refused: "bad_date" });
    expect(setAway(team(), "h-nam", Number.NaN, 5)).toEqual({ ok: false, refused: "bad_date" });
    const r = setAway(team(), "h-nam", DAY, 0);
    if (!r.ok) throw new Error("expected ok");
    expect(clearAway(r.state).away).toBeNull();
    expect(clearAway(base())).toEqual(base());
  });
});

describe("canDecide", () => {
  it("lets the owner decide everything and refuses people it does not know", () => {
    for (const kind of APPROVAL_KINDS) expect(canDecide(team(), "owner-1", kind, 0)).toEqual({ ok: true, role: "owner" });
    expect(canDecide(team(), "stranger", "reply", 0)).toEqual({ ok: false, refused: "unknown_person" });
  });
});

describe("removal", () => {
  it("returns every session, revokes the helper's pending invites and cover, and refuses their decisions", () => {
    let s = addSession(team(), "h-pim", "s-pim-2");
    if (!s.ok) throw new Error("expected ok");
    const away = setAway(s.state, "h-pim", 10 * DAY, 0);
    if (!away.ok) throw new Error("expected ok");
    // A fresh pending invite bound to the same identity, as if re-sent to a current helper by another path.
    const withInvite: PeopleState = {
      ...away.state,
      invites: [...away.state.invites, { id: "i9", identity: email, createdAt: 0, expiresAt: 7 * DAY, status: "pending" }],
    };
    const r = removeHelper(withInvite, "h-pim");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.endSessions).toEqual(["s-pim-1", "s-pim-2"]);
    expect(r.revokedInvites).toEqual(["i9"]);
    expect(r.coverEnded).toBe(true);
    expect(r.state.away).toBeNull();
    expect(r.state.helpers.map((h) => h.id)).toEqual(["h-nam"]);
    expect(canDecide(r.state, "h-pim", "reply", DAY)).toEqual({ ok: false, refused: "removed" });
    expect(canDecide(r.state, "h-pim", "money", DAY)).toEqual({ ok: false, refused: "removed" });
    expect(acceptInvite(r.state, "i9", email, "h-new", "s", 1)).toEqual({ answer: "revoked" });
    expect(removeHelper(r.state, "h-pim")).toEqual({ ok: false, refused: "not_a_helper" });
  });
  it("leaves cover held by another helper alone", () => {
    const away = setAway(team(), "h-nam", 10 * DAY, 0);
    if (!away.ok) throw new Error("expected ok");
    const r = removeHelper(away.state, "h-pim");
    expect(r.ok && r.coverEnded).toBe(false);
    expect(r.ok && r.state.away?.helperId).toBe("h-nam");
  });
  it("refuses a session for someone who is not a helper", () => {
    expect(addSession(team(), "nobody", "s")).toEqual({ ok: false, refused: "not_a_helper" });
  });
});

describe("a helper's sessions", () => {
  it(`keeps at most ${MAX_HELPER_SESSIONS} open, ending the oldest when one more opens`, () => {
    // team() gives Pim one session already, s-pim-1.
    let state = team();
    const ended: string[] = [];
    for (let n = 2; n <= MAX_HELPER_SESSIONS + 3; n++) {
      const added = addSession(state, "h-pim", `s-pim-${n}`);
      if (!added.ok) throw new Error("expected ok");
      ended.push(...added.ended);
      state = added.state;
    }
    expect(ended).toEqual(["s-pim-1", "s-pim-2", "s-pim-3"]);
    const sessions = state.helpers.find((h) => h.id === "h-pim")?.sessions;
    expect(sessions).toEqual(Array.from({ length: MAX_HELPER_SESSIONS }, (_, n) => `s-pim-${n + 4}`));
    // Another helper's sessions are as they were, and removal ends exactly the ones still open.
    expect(state.helpers.find((h) => h.id === "h-nam")?.sessions).toEqual(["s-nam-1"]);
    const removed = removeHelper(state, "h-pim");
    expect(removed.ok && removed.endSessions).toEqual(sessions);
  });
  it("records a session already open once, and ends nothing for it", () => {
    const again = addSession(team(), "h-pim", "s-pim-1");
    expect(again).toEqual({ ok: true, state: team(), ended: [] });
  });
});

describe("signing out of one device", () => {
  it("takes only that session off the helper's open ones, so a later removal ends just the rest", () => {
    const two = addSession(team(), "h-pim", "s-pim-2");
    if (!two.ok) throw new Error("expected ok");
    const r = endSession(two.state, "h-pim", "s-pim-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.helpers.find((h) => h.id === "h-pim")?.sessions).toEqual(["s-pim-2"]);
    // Another helper's sessions, and everything else in the state, are as they were.
    expect(r.state.helpers.find((h) => h.id === "h-nam")?.sessions).toEqual(["s-nam-1"]);
    expect({ ...r.state, helpers: two.state.helpers }).toEqual(two.state);
    const removed = removeHelper(r.state, "h-pim");
    expect(removed.ok && removed.endSessions).toEqual(["s-pim-2"]);
  });
  it("refuses someone who is not a helper, and a session that helper does not have, and changes nothing", () => {
    const before = team();
    expect(endSession(before, "nobody", "s-pim-1")).toEqual({ ok: false, refused: "not_a_helper" });
    // A session id is the helper's own: another helper's does not end through them.
    expect(endSession(before, "h-pim", "s-nam-1")).toEqual({ ok: false, refused: "unknown_session" });
    expect(before).toEqual(team());
    // Ending the same session twice finds nothing the second time.
    const once = endSession(before, "h-pim", "s-pim-1");
    if (!once.ok) throw new Error("expected ok");
    expect(endSession(once.state, "h-pim", "s-pim-1")).toEqual({ ok: false, refused: "unknown_session" });
  });
  it("leaves the helper a helper, with their cover and their notes, when their last session ends", () => {
    const away = setAway(team(), "h-pim", 10 * DAY, 0);
    if (!away.ok) throw new Error("expected ok");
    const r = endSession(away.state, "h-pim", "s-pim-1");
    expect(r.ok && r.state.helpers.map((h) => h.id)).toEqual(["h-nam", "h-pim"]);
    expect(r.ok && r.state.away?.helperId).toBe("h-pim");
    expect(r.ok && r.state.helpers.find((h) => h.id === "h-pim")?.sessions).toEqual([]);
  });
});

function mayHelper(kind: ApprovalKind): boolean { return kind === "message" || kind === "reply"; }
