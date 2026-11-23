// What the decide route's answer comes to, in plain words: the person's answer was taken, or why not ("Only the owner
// can approve money", "Already decided by Mint at 19:42", changed, superseded, expired, removed), and how the card closes
// once the shop is read again. The route itself is apps/api's (docs/pilot-api.md, "Deciding from a session").
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { decisionPath, outcomeOf, type AnswerContext, type Outcome } from "./answer";
import type { Answer } from "./session";

/** 19:42 on 22 November 2026, this computer's clock, and a few minutes later. */
const AT = new Date(2026, 10, 22, 19, 42).getTime();
const NOW = new Date(2026, 10, 22, 19, 50).getTime();
const NEXT_DAY = new Date(2026, 10, 23, 9, 0).getTime();
const ctx = (over: Partial<AnswerContext> = {}): AnswerContext => ({ kind: "reply", names: new Map([["helper-mint", "Mint"]]), now: NOW, ...over });
const refused = (status: number, json: Record<string, unknown>): Answer => ({ kind: "refused", status, code: typeof json.error === "string" ? json.error : "", json });
const decided = (over: Record<string, unknown> = {}) => ({ requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "helper-mint", role: "helper", decidedAt: AT, ...over });
/** The words of an outcome, "" when it was taken. */
const words = (o: Outcome) => (o.ok ? "" : o.words);
const alreadyDecided = (decision: Record<string, unknown>) =>
  refused(409, { error: "already_decided", result: { ok: false, refused: "already_decided", decision }, action: "confirmed" });

afterEach(() => setLang("en"));

describe("an answer the API took", () => {
  it("is taken: nothing more to say, and the card is marked by the store with the choice", () => {
    const ok: Answer = { kind: "ok", status: 200, json: { result: { ok: true, decision: decided({ decidedBy: "owner-session", role: "owner" }) }, action: "confirmed" } };
    expect(outcomeOf(ok, ctx())).toEqual({ ok: true });
  });

  it("is not taken for granted from a 2xx that does not say it was decided", () => {
    expect(outcomeOf({ kind: "ok", status: 200, json: { result: { ok: false } } }, ctx())).toEqual({
      ok: false,
      code: "unknown",
      words: "No reply from the API. Checking whether your answer arrived",
    });
  });
});

describe("a role that may not decide the kind", () => {
  it("says who may, by kind", () => {
    const notPermitted = refused(403, { error: "not_permitted", result: { ok: false, refused: "not_permitted" }, action: "proposed" });
    const forKind = (kind: AnswerContext["kind"]) => outcomeOf(notPermitted, ctx({ kind }));
    expect(forKind("money")).toEqual({ ok: false, code: "not_permitted", words: "Only the owner can approve money" });
    expect(forKind("public_post")).toMatchObject({ words: "Only the owner can approve public posts" });
    expect(forKind("payment_confirmation")).toMatchObject({ words: "Only the owner can confirm that a payment arrived" });
    expect(forKind("command")).toMatchObject({ words: "Only the owner can approve changes to the shop's own records" });
    expect(forKind("reply")).toMatchObject({ words: "Only the owner can decide this" });
    // the ask still waits for the owner, so its card stays open
    expect(forKind("money")).not.toHaveProperty("closing");
  });
});

describe("a request someone decided first", () => {
  it("says who decided and when, and closes the card with those words", () => {
    expect(outcomeOf(alreadyDecided(decided()), ctx())).toEqual({
      ok: false,
      code: "already_decided",
      words: "Already decided by Mint at 19:42",
      closing: { reason: "resolved", note: "Already decided by Mint at 19:42" },
    });
  });

  it("names the owner's own decisions as theirs, from this app or from the link on LINE", () => {
    expect(words(outcomeOf(alreadyDecided(decided({ decidedBy: "owner-session", role: "owner" })), ctx()))).toBe("Already decided by you at 19:42");
    expect(words(outcomeOf(alreadyDecided(decided({ decidedBy: "owner-link", role: "owner" })), ctx()))).toBe("Already decided from your LINE link at 19:42");
  });

  it("names a helper it has no name for as a helper, and someone whose role it does not know as no one in particular", () => {
    expect(words(outcomeOf(alreadyDecided(decided({ decidedBy: "helper-9" })), ctx()))).toBe("Already decided by a helper at 19:42");
    expect(words(outcomeOf(alreadyDecided(decided({ role: "manager" })), ctx()))).toBe("Already decided at 19:42");
  });

  it("puts the day first for a decision from another day, and says no time it was not told", () => {
    expect(words(outcomeOf(alreadyDecided(decided()), ctx({ now: NEXT_DAY })))).toBe("Already decided by Mint at Nov 22 19:42");
    expect(words(outcomeOf(alreadyDecided(decided({ decidedAt: undefined })), ctx()))).toBe("Already decided");
    expect(words(outcomeOf(refused(409, { error: "already_decided" }), ctx()))).toBe("Already decided");
  });
});

describe("a request that moved on", () => {
  it("says it changed, and closes the old card so the new version is answered on its own", () => {
    expect(outcomeOf(refused(409, { error: "changed", result: { ok: false, refused: "changed", currentRevision: 2 } }), ctx())).toEqual({
      ok: false,
      code: "changed",
      words: "It changed since you saw it. Answer the new version",
      closing: { reason: "cancelled", note: "It changed since you saw it. Answer the new version" },
    });
  });

  it("says why it is no longer asked", () => {
    const superseded = (reason: unknown) => outcomeOf(refused(409, { error: "superseded", result: { ok: false, refused: "superseded", reason } }), ctx());
    expect(superseded("attempt_ended")).toEqual({
      ok: false,
      code: "superseded",
      words: "No longer asked: the work it was for has stopped",
      closing: { reason: "cancelled", note: "No longer asked: the work it was for has stopped" },
    });
    expect(words(superseded("turn_ended"))).toBe("No longer asked: the work it was for has stopped");
    expect(words(superseded("withdrawn"))).toBe("Withdrawn: the team took it back");
    expect(words(superseded("shop_closed"))).toBe("No longer waiting for an answer");
  });

  it("says when it expired, and closes the card as timed out", () => {
    expect(outcomeOf(refused(410, { error: "expired", result: { ok: false, refused: "expired", expiredAt: AT } }), ctx())).toEqual({
      ok: false,
      code: "expired",
      words: "Expired at 19:42",
      closing: { reason: "timeout", note: "Expired at 19:42" },
    });
    expect(words(outcomeOf(refused(410, { error: "expired" }), ctx()))).toBe("Timed out");
  });

  it("says a request the shop no longer holds is gone", () => {
    expect(outcomeOf(refused(404, { error: "not_found" }), ctx())).toEqual({
      ok: false,
      code: "not_found",
      words: "That is not in this shop any more.",
      closing: { reason: "cancelled", note: "That is not in this shop any more." },
    });
  });
});

describe("a refusal before anything was decided", () => {
  it("says what stands in the way, and leaves the ask waiting", () => {
    const cases: [Answer, string, string][] = [
      [refused(403, { error: "consent_required" }), "consent_required", "The shop has not agreed yet to let Manut AI send for it"],
      [refused(403, { error: "feature_disabled", feature: "officeExternalWrites" }), "feature_disabled", "Answering is switched off on this API for now"],
      [refused(400, { error: "invalid_request" }), "invalid_request", "The API could not read the answer, so nothing was decided"],
      [refused(400, { error: "not_offered", result: { ok: false, refused: "not_offered" } }), "not_offered", "That answer is not offered here"],
      [refused(429, { error: "rate_limited" }), "rate_limited", "The API did not take this answer, so nothing was decided"],
      [refused(400, {}), "refused", "The API did not take this answer, so nothing was decided"],
    ];
    for (const [answer, code, words] of cases) expect(outcomeOf(answer, ctx()), code).toEqual({ ok: false, code, words });
  });

  it("tells a helper the owner removed them, and when", () => {
    const removedAt = new Date(2026, 10, 22, 21, 5).toISOString();
    const out = outcomeOf(refused(401, { error: "removed", removedAt }), ctx());
    expect(out).toEqual({ ok: false, code: "removed", words: `The owner removed you on ${new Date(removedAt).toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" })}. Ask them if this is a mistake` });
    expect(words(out)).toContain("Sunday");
    expect(outcomeOf(refused(401, { error: "removed" }), ctx())).toMatchObject({ words: "The owner removed you from this shop. Ask them if this is a mistake" });
  });
});

describe("no answer from the API", () => {
  it("never says the answer was lost or sent: it may have arrived, so the shop is read again", () => {
    for (const answer of [{ kind: "offline" }, { kind: "unavailable" }, { kind: "unavailable", status: 503 }] as Answer[])
      expect(outcomeOf(answer, ctx()), JSON.stringify(answer)).toEqual({ ok: false, code: "unknown", words: "No reply from the API. Checking whether your answer arrived" });
  });

  it("says the session is over when the API ended it", () => {
    expect(outcomeOf({ kind: "signed_out" }, ctx())).toEqual({ ok: false, code: "signed_out", words: "Signed out. Sign in under Settings › Developer." });
  });
});

describe("the words", () => {
  it("are in the app's language", () => {
    setLang("ko");
    const ko = words(outcomeOf(alreadyDecided(decided()), ctx()));
    expect(ko).toContain("Mint");
    expect(ko).toContain("19:42");
    expect(ko).not.toContain("Already");
  });
});

describe("the route", () => {
  it("is the request's own decision route, its id kept to one path segment", () => {
    expect(decisionPath("action-1")).toBe("/v1/approvals/action-1/decision");
    expect(decisionPath("a/b?c")).toBe("/v1/approvals/a%2Fb%3Fc/decision");
  });
});
