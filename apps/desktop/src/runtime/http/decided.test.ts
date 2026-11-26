// How a request that left the open approvals on its own was settled, in plain words, from the shop's recent requests (`GET /v1/approvals
// ?state=recent`; docs/pilot-api.md, "Approvals for a session"): approved or declined by what the option the request offers does, by whom
// when that is known, taken back, ended with the work that asked it, or timed out. A record that does not speak for the card gives no
// closing at all, so the host keeps the words it had. The read itself is the host's (decided.host.test.ts).
import { afterEach, describe, expect, it } from "vitest";
import { dayTime } from "../../app/time";
import { setLang } from "../../i18n";
import { closingFor, helperNames, recentOf, RECENT_PATH, type DecidedContext } from "./decided";
import type { ShopApproval } from "./approvals";
import type { Answer } from "./session";
import { approvalJson, iso, settledJson, T0, type Settled } from "./testkit";

/** When someone decided, a few minutes before the person's computer read it, and that read. */
const AT = T0 + 420_000;
const NOW = T0 + 600_000;
const ctx = (over: Partial<DecidedContext> = {}): DecidedContext => ({ names: new Map([["helper-mint", "Mint"]]), now: NOW, ...over });
const ok = (approvals: unknown[], state: unknown = "recent"): Answer => ({ kind: "ok", status: 200, json: { state, approvals } });
/** The one record `how` makes of the request `action-1`, read as the host reads it. */
const record = (how: Settled, over: Parameters<typeof settledJson>[1] = {}): ShopApproval[] => recentOf(ok([settledJson(how, { at: AT, ...over })])) ?? [];
const closing = (records: ShopApproval[], over: Partial<DecidedContext> = {}, ask = { id: "action-1", revision: 1 }) => closingFor(records, ask, ctx(over));
const note = (records: ShopApproval[], over: Partial<DecidedContext> = {}) => closing(records, over)?.note;
const time = dayTime(AT, NOW);

afterEach(() => setLang("en"));

describe("the list", () => {
  it("is the shop's recent requests: approval-core's own records and where each stands", () => {
    expect(RECENT_PATH).toBe("/v1/approvals?state=recent");
    const [one, two] = recentOf(ok([settledJson("decided", { id: "a", at: AT }), settledJson("expired", { id: "b" })])) ?? [];
    expect(one).toMatchObject({ record: { status: "decided", request: { id: "a" } }, standing: { state: "decided" } });
    expect(two).toMatchObject({ record: { status: "pending", request: { id: "b" } }, standing: { state: "expired" } });
  });

  it("leaves out an entry that names no request, as every read of the shop's approvals does", () => {
    const records = recentOf(ok([settledJson("decided", { id: "a" }), { record: { status: "decided" } }, "not an entry", null]));
    expect(records?.map((r) => r.record.request.id)).toEqual(["a"]);
  });

  it("is nothing at all for an answer that is not that list", () => {
    const answers: Answer[] = [
      { kind: "refused", status: 403, code: "feature_disabled", json: { error: "feature_disabled" } },
      { kind: "refused", status: 400, code: "invalid_state", json: { error: "invalid_state" } },
      { kind: "offline" },
      { kind: "unavailable", status: 503 },
      { kind: "signed_out" },
      // the open list is not this one, even when it holds the request
      ok([settledJson("decided")], "open"),
      { kind: "ok", status: 200, json: { approvals: [settledJson("decided")] } },
      { kind: "ok", status: 200, json: { state: "recent" } },
      { kind: "ok", status: 200, json: { state: "recent", approvals: "none" } },
      { kind: "ok", status: 200, json: ["recent"] },
      { kind: "ok", status: 200, json: null },
    ];
    for (const answer of answers) expect(recentOf(answer), JSON.stringify(answer)).toBeNull();
  });

  it("tells the helpers' names a note passed on carries, from every list it is given", () => {
    const note = (by: string, name: string) => approvalJson({ id: `r-${by}`, passedOn: { by, name, note: "Over to you.", at: iso(AT) } });
    const a = recentOf(ok([note("helper-1", "Mint"), note("helper-2", "")])) ?? [];
    const b = recentOf(ok([note("helper-3", "Pim")])) ?? [];
    expect([...helperNames(a, b)]).toEqual([["helper-1", "Mint"], ["helper-3", "Pim"]]);
    expect(helperNames().size).toBe(0);
  });
});

describe("a request someone decided", () => {
  it("says it was approved by you, and when", () => {
    expect(closing(record("decided"))).toEqual({ reason: "resolved", note: `Approved by you at ${time}` });
  });

  it("says it was declined by you, and when", () => {
    expect(closing(record("decided", { option: "decline" }))).toEqual({ reason: "resolved", note: `Declined by you at ${time}` });
  });

  it("says it was decided from your LINE link, when the owner's link page did", () => {
    expect(note(record("decided", { by: "owner-link" }))).toBe(`Approved from your LINE link at ${time}`);
    expect(note(record("decided", { by: "owner-link", option: "decline" }))).toBe(`Declined from your LINE link at ${time}`);
  });

  it("says an owner's account decided it as you, whichever account it is", () => {
    expect(note(record("decided", { by: "owner-3f2a" }))).toBe(`Approved by you at ${time}`);
  });

  it("names a helper by the name the shop gave them when it has it, and calls one it has no name for a helper", () => {
    expect(note(record("decided", { by: "helper-mint", role: "helper" }))).toBe(`Approved by Mint at ${time}`);
    expect(note(record("decided", { by: "helper-mint", role: "helper", option: "decline" }))).toBe(`Declined by Mint at ${time}`);
    expect(note(record("decided", { by: "helper-9", role: "helper" }))).toBe(`Approved by a helper at ${time}`);
    expect(note(record("decided", { by: "helper-9", role: "helper", option: "decline" }))).toBe(`Declined by a helper at ${time}`);
  });

  it("names the owner, never you, to a helper reading it, from this app or from the link on LINE", () => {
    expect(note(record("decided"), { owner: "Noi" })).toBe(`Approved by Noi at ${time}`);
    expect(note(record("decided", { by: "owner-link", option: "decline" }), { owner: "Noi" })).toBe(`Declined by Noi at ${time}`);
    // a shop whose owner this app was never told the name of says no one in particular
    expect(note(record("decided"), { owner: "" })).toBe(`Approved at ${time}`);
  });

  it("says no one in particular for a role this build does not know", () => {
    expect(note(record("decided", { role: "manager" }))).toBe(`Approved at ${time}`);
    expect(note(record("decided", { role: "manager", option: "decline" }))).toBe(`Declined at ${time}`);
  });

  it("puts the day first for a decision from another day, so yesterday is never taken for this morning", () => {
    const yesterday = NOW - 26 * 3600_000;
    expect(note(record("decided", { at: yesterday }))).toBe(`Approved by you at ${dayTime(yesterday, NOW)}`);
    expect(dayTime(yesterday, NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });

  it("says only approved or declined when it was told no time, and not who either", () => {
    expect(note(record("decided", { at: 0 }))).toBe("Approved");
    expect(note(record("decided", { at: 0, option: "decline" }))).toBe("Declined");
    expect(note(record("decided", { at: 0, by: "helper-mint", role: "helper" }))).toBe("Approved");
  });

  it("closes the card as answered elsewhere", () => {
    expect(closing(record("decided"))?.reason).toBe("resolved");
    expect(closing(record("decided", { option: "decline" }))?.reason).toBe("resolved");
  });
});

describe("what the option does", () => {
  const request = (options: unknown[], option: string) => record("decided", { options, option });
  const opt = (id: string, effect: unknown, label = id) => ({ id, label, effect });

  it("is read from its effect, never from its id or its label", () => {
    // an option called "decline" that approves, and one labelled "Deny" that approves, are approvals
    expect(note(request([opt("decline", "approve"), opt("other", "decline")], "decline"))).toBe(`Approved by you at ${time}`);
    expect(note(request([opt("go", "approve", "Deny"), opt("stop", "decline", "Allow")], "go"))).toBe(`Approved by you at ${time}`);
    // and an option called "approve" that declines is a refusal
    expect(note(request([opt("approve", "decline"), opt("other", "approve")], "approve"))).toBe(`Declined by you at ${time}`);
    // words in another language mean nothing to it either
    expect(note(request([opt("yes", "approve", "承認"), opt("no", "decline", "却下")], "no"))).toBe(`Declined by you at ${time}`);
  });

  it("says it was decided, with no verb, when it cannot tell what the option did", () => {
    const decided = `Already decided by you at ${time}`;
    // an effect this build does not know
    expect(note(request([opt("approve", "approve_always"), opt("decline", "decline")], "approve"))).toBe(decided);
    // an option the request does not offer
    expect(note(request([opt("approve", "approve"), opt("decline", "decline")], "maybe"))).toBe(decided);
    // an id the request offers twice, with two effects
    expect(note(request([opt("x", "approve"), opt("x", "decline")], "x"))).toBe(decided);
    // the same words as the answer path's, for the same helper
    expect(note(record("decided", { options: [opt("a", "weird")], option: "a", by: "helper-mint", role: "helper" }))).toBe(`Already decided by Mint at ${time}`);
    expect(closing(request([opt("approve", "weird")], "approve"))?.reason).toBe("resolved");
  });

  it("is read from the standing when the record's status is one this build does not know", () => {
    const entry = settledJson("decided", { at: AT });
    const records = recentOf(ok([{ ...entry, record: { ...entry.record, status: "settled" } }])) ?? [];
    expect(note(records)).toBe(`Approved by you at ${time}`);
  });

  it("is read from the record itself when the standing is one this build does not know", () => {
    const entry = settledJson("decided", { at: AT });
    const records = recentOf(ok([{ ...entry, standing: { state: "revoked" } }])) ?? [];
    expect(note(records)).toBe(`Approved by you at ${time}`);
  });
});

describe("a request nobody decided", () => {
  it("says the team took it back, and closes the card as cancelled", () => {
    expect(closing(record("withdrawn"))).toEqual({ reason: "cancelled", note: "Withdrawn: the team took it back" });
    // the record says so when the standing is one this build does not know
    const records = recentOf(ok([{ ...settledJson("withdrawn"), standing: { state: "revoked" } }])) ?? [];
    expect(closing(records)).toEqual({ reason: "cancelled", note: "Withdrawn: the team took it back" });
  });

  it("says the work it was for has stopped, when its attempt or its turn ended", () => {
    for (const how of ["attempt_ended", "turn_ended"] as const)
      expect(closing(record(how)), how).toEqual({ reason: "cancelled", note: "No longer asked: the work it was for has stopped" });
  });

  it("says it is no longer waiting, for a request the store does not hold or a reason it does not know", () => {
    expect(closing(record("not_found"))).toEqual({ reason: "cancelled", note: "No longer waiting for an answer" });
    const records = recentOf(ok([{ ...settledJson("attempt_ended"), standing: { state: "superseded", reason: "shop_closed" } }])) ?? [];
    expect(closing(records)).toEqual({ reason: "cancelled", note: "No longer waiting for an answer" });
  });

  it("says when it ran out of time, and closes the card as timed out", () => {
    expect(closing(record("expired"))).toEqual({ reason: "timeout", note: `Expired at ${time}` });
    expect(closing(record("expired", { at: 0 }))).toEqual({ reason: "timeout", note: "Timed out" });
  });
});

describe("a record that does not speak for the card", () => {
  it("gives nothing for a request the list does not hold, or another request", () => {
    expect(closing([])).toBeNull();
    expect(closing(record("decided", { id: "action-2" }))).toBeNull();
  });

  it("gives nothing for another revision than the card showed: its words were not the ones decided", () => {
    expect(closing(record("decided", { revision: 2 }), {}, { id: "action-1", revision: 1 })).toBeNull();
    expect(closing(record("decided", { revision: 1 }), {}, { id: "action-1", revision: 2 })).toBeNull();
    expect(closing(record("expired", { revision: 3 }), {}, { id: "action-1", revision: 1 })).toBeNull();
    expect(closing(record("decided", { revision: 2 }), {}, { id: "action-1", revision: 2 })?.note).toBe(`Approved by you at ${time}`);
  });

  it("gives nothing for one that still waits, or whose standing this build cannot say", () => {
    expect(closing(recentOf(ok([approvalJson({ id: "action-1" })])) ?? [])).toBeNull();
    const pending = approvalJson({ id: "action-1" });
    expect(closing(recentOf(ok([{ ...pending, standing: { state: "revoked" } }])) ?? [])).toBeNull();
    expect(closing(recentOf(ok([{ ...pending, standing: { state: "changed", reason: "revised", currentRevision: 2 } }])) ?? [])).toBeNull();
    expect(closing(recentOf(ok([{ ...pending, standing: {} }])) ?? [])).toBeNull();
  });
});

describe("the words", () => {
  it("are in the app's language", () => {
    setLang("ko");
    const ko = note(record("decided", { by: "helper-mint", role: "helper" })) ?? "";
    expect(ko).toContain("Mint");
    expect(ko).toContain(time);
    expect(ko).not.toContain("Approved");
    setLang("ja");
    expect(note(record("decided", { option: "decline" }))).toContain("却下");
    setLang("zh");
    expect(note(record("decided"))).toContain("批准");
  });
});
