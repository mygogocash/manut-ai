// The shop's approvals as `GET /v1/approvals` lists them, read with approval-core's own wire decoders, and what the
// decision route answers. The first four groups are the desktop's tests (apps/desktop/src/runtime/http/approvals.test.ts),
// lifted with the module they test, with the web's two answers (Approve, Decline) in place of the desktop's four.
import { isUnknown } from "@manut/approval-core";
import { describe, expect, it } from "vitest";
import {
  answerable,
  askId,
  choicesOf,
  decodeApprovals,
  detailOf,
  isAsk,
  optionFor,
  parseAskId,
  readDecision,
  readListing,
  type ShopApproval,
} from "../src/app/asks";
import { approvalJson, decided, iso, OPTIONS, replyDetail, T0 } from "./appKit";

/** Decodes one listing entry, and says what could not be read. */
function one(entry: unknown): { approval: ShopApproval | undefined; unreadable: unknown[] } {
  const unreadable: unknown[] = [];
  const [approval] = decodeApprovals({ state: "open", approvals: [entry] }, unreadable);
  return { approval, unreadable };
}
const decodedOne = (over: Parameters<typeof approvalJson>[0] = {}) => one(approvalJson(over)).approval!;
const decision = decided();

describe("an open request", () => {
  it("reads a reply waiting for the owner as approval-core's record and standing, answerable once or not at all", () => {
    const a = decodedOne();
    expect(a.taskId).toBe("task-1");
    expect(a.record).toMatchObject({ status: "pending", request: { id: "action-1", kind: "reply", revision: 1, createdAt: T0 + 90_000, expiresAt: T0 + 24 * 3600_000 } });
    expect(a.standing).toEqual({ state: "open", reason: "waiting" });
    expect(a.passedOn).toBeNull();
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toMatchObject({ id: "action-1", kind: "reply", revision: 1, options: OPTIONS });
    expect(choicesOf(a)).toEqual(["approve", "decline"]);
    expect(askId(a)).toBe("action-1@1");
  });

  it("keeps what the request shows, and only the words this app shows: the operation, where it goes, to whom, and its text", () => {
    const a = decodedOne({ detail: { ...replyDetail(), canary: "CANARY", nested: { token: "CANARY" } } });
    expect(detailOf(a.record.request)).toEqual({ actionId: "action-1", operationType: "line.message.push", targetResourceId: "bot-user-1", recipient: "U-customer", text: "Your order ships tomorrow morning." });
    expect(JSON.stringify(a)).not.toContain("CANARY");
  });

  it("reads a worker's command, whose request names no words, and one with no detail at all", () => {
    const command = decodedOne({ id: "req-7", kind: "command", attemptId: "attempt-2", detail: { actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payloadHash: "h" } });
    expect(command.record.request).toMatchObject({ kind: "command", attemptId: "attempt-2" });
    expect(detailOf(command.record.request)).toEqual({ actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1" });
    expect(detailOf(decodedOne({ detail: "not an object" }).record.request)).toEqual({});
  });

  it("keeps the control plane's own sentence for Ton's books, and nothing of their rows", () => {
    const books = decodedOne({ kind: "command", detail: { actionId: "b", operationType: "google.sheets.append", text: "Append the books for 2026-10.", lines: [{ satang: 100 }], totals: { net: "฿1" } } });
    expect(detailOf(books.record.request)).toEqual({ actionId: "b", operationType: "google.sheets.append", text: "Append the books for 2026-10." });
    expect(JSON.stringify(books)).not.toContain("satang");
  });

  it("reads a note a helper passed on with the request", () => {
    const a = decodedOne({ passedOn: { by: "helper-mint", name: "Mint", note: "The jar arrived broken. It looks right to me.", at: iso(T0 + 200_000) } });
    expect(a.passedOn).toEqual({ by: "helper-mint", name: "Mint", note: "The jar arrived broken. It looks right to me.", at: T0 + 200_000 });
    expect(decodedOne({ passedOn: { by: "helper-mint", note: 3 } }).passedOn).toEqual({ by: "helper-mint", name: "", note: "", at: null });
  });
});

describe("each standing", () => {
  it("is read with approval-core's decoder, and only an open one is waiting to be answered", () => {
    const standings: [Record<string, unknown>, unknown][] = [
      [{ state: "decided", reason: "decided", decision }, { state: "decided", reason: "decided", decision }],
      [{ state: "changed", reason: "revised", currentRevision: 3 }, { state: "changed", reason: "revised", currentRevision: 3 }],
      [{ state: "superseded", reason: "attempt_ended" }, { state: "superseded", reason: "attempt_ended" }],
      [{ state: "superseded", reason: "withdrawn" }, { state: "superseded", reason: "withdrawn" }],
      [{ state: "expired", reason: "expired", expiredAt: T0 + 86_400_000 }, { state: "expired", reason: "expired", expiredAt: T0 + 86_400_000 }],
    ];
    for (const [standing, want] of standings) {
      const a = decodedOne({ standing });
      expect(a.standing, JSON.stringify(standing)).toEqual(want);
      expect(isAsk(a), JSON.stringify(standing)).toBe(false);
      expect(answerable(a), JSON.stringify(standing)).toBeNull();
      expect(choicesOf(a), JSON.stringify(standing)).toEqual([]);
    }
  });

  it("keeps a superseded reason this build does not know, as approval-core keeps it", () => {
    const a = decodedOne({ standing: { state: "superseded", reason: "shop_closed" } });
    expect(a.standing).toEqual({ state: "superseded", reason: { unknown: true, raw: "shop_closed" } });
    expect(isAsk(a)).toBe(false);
  });

  it("keeps a state this build does not know, shows it as still asked, and never answers it", () => {
    const a = decodedOne({ standing: { state: "paused_by_owner" } });
    expect(isUnknown(a.standing.state)).toBe(true);
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
    expect(choicesOf(a)).toEqual([]);
  });
});

describe("what this build does not know", () => {
  it("keeps a kind it does not know, shows it as still asked, and never answers it", () => {
    const a = decodedOne({ kind: "refund_partial" });
    expect(a.record.request.kind).toEqual({ unknown: true, raw: "refund_partial" });
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
    expect(choicesOf(a)).toEqual([]);
  });

  it("does not answer a request with an option whose effect it does not know, or a record whose status it does not know", () => {
    const snooze = decodedOne({ options: [...OPTIONS, { id: "later", label: "Later", effect: "snooze" }] });
    expect(snooze.record.request.options[2]).toEqual({ id: "later", label: "Later", effect: { unknown: true, raw: "snooze" } });
    expect(answerable(snooze)).toBeNull();
    const escalated = decodedOne({ status: "escalated" });
    expect(escalated.record.status).toEqual({ unknown: true, raw: "escalated" });
    expect(isAsk(escalated)).toBe(true);
    expect(answerable(escalated)).toBeNull();
  });

  it("keeps a decider's role it does not know as unknown, never as the owner", () => {
    const a = decodedOne({ standing: { state: "decided", reason: "decided", decision: { ...decision, role: "manager" } } });
    expect(a.standing).toMatchObject({ state: "decided", decision: { role: { unknown: true, raw: "manager" } } });
  });

  it("answers only what the card can offer one to one: one approve, one decline", () => {
    const twoApprovals = decodedOne({ options: [...OPTIONS, { id: "approve-all", label: "Approve all", effect: "approve" }] });
    expect(answerable(twoApprovals)).toBeNull();
    expect(choicesOf(twoApprovals)).toEqual([]);
    expect(answerable(decodedOne({ options: [] }))).toBeNull();
    expect(choicesOf(decodedOne({ options: [OPTIONS[0]] }))).toEqual(["approve"]);
    expect(choicesOf(decodedOne({ options: [OPTIONS[1]] }))).toEqual(["decline"]);
  });
});

describe("what cannot be read", () => {
  it("puts an entry with no request id, or one that is not an object, with the unreadable entries, and keeps the rest", () => {
    const unreadable: unknown[] = [];
    const noId = approvalJson({ id: "" });
    const listed = decodeApprovals({ state: "open", approvals: [noId, "junk", null, approvalJson({ id: "action-2" })] }, unreadable);
    expect(listed.map((a) => a.record.request.id)).toEqual(["action-2"]);
    expect(unreadable).toEqual([noId, "junk", null]);
  });

  it("reads a body with no list as no approvals, and an entry with no task id as asked in no task the app knows", () => {
    const unreadable: unknown[] = [];
    expect(decodeApprovals({ state: "open" }, unreadable)).toEqual([]);
    expect(decodeApprovals("nonsense", unreadable)).toEqual([]);
    expect(unreadable).toEqual([]);
    const { taskId: _gone, ...entry } = approvalJson();
    expect(one(entry).approval?.taskId).toBe("");
  });
});

describe("answering", () => {
  it("chooses the option by what it does, never by its label, and offers no standing approval", () => {
    const request = answerable(decodedOne({ options: [{ id: "yes-7", label: "ส่งเลย", effect: "approve" }, { id: "no-7", label: "ไม่ส่ง", effect: "decline" }] }))!;
    expect(optionFor(request, "approve")).toEqual({ id: "yes-7", label: "ส่งเลย", effect: "approve" });
    expect(optionFor(request, "decline")).toEqual({ id: "no-7", label: "ไม่ส่ง", effect: "decline" });
    expect(optionFor(request, "session")).toBeNull();
    expect(optionFor(request, "always")).toBeNull();
    expect(optionFor(answerable(decodedOne({ options: [OPTIONS[0]] }))!, "decline")).toBeNull();
  });

  it("names the revision the person saw in the ask's id, and reads it back", () => {
    expect(askId(decodedOne({ id: "req-9", revision: 3 }))).toBe("req-9@3");
    expect(parseAskId("req-9@3")).toEqual({ id: "req-9", revision: 3 });
    expect(parseAskId("odd@id@2")).toEqual({ id: "odd@id", revision: 2 });
    for (const bad of ["req-9", "req-9@", "req-9@0", "req-9@-1", "req-9@1.5", "req-9@x", "@1", ""]) expect(parseAskId(bad), bad).toBeNull();
  });
});

describe("a shop's listing through the web routes", () => {
  it("reads a list, an ended session, a removal or an unlinking, and anything else as unreadable, never as nothing waiting", () => {
    const listed = readListing({ status: 200, body: { state: "open", approvals: [approvalJson(), "junk"] } });
    expect(listed.ok && listed.approvals.map((a) => a.record.request.id)).toEqual(["action-1"]);
    expect(listed.ok && listed.unreadable).toEqual(["junk"]);
    expect(readListing({ status: 401, body: { error: "session_ended", shop: "pilot:a" } })).toEqual({ ok: false, why: "session_ended" });
    expect(readListing({ status: 401, body: { error: "removed", removedAt: iso(T0), shop: "pilot:a" } }))
      .toEqual({ ok: false, why: "left", left: { why: "removed", at: T0 } });
    expect(readListing({ status: 401, body: { error: "unlinked", unlinkedAt: "not a date" } }))
      .toEqual({ ok: false, why: "left", left: { why: "unlinked", at: null } });
    for (const answer of [{ status: 503, body: { error: "approvals_unavailable" } }, { status: 200, body: { state: "open" } },
      { status: 200, body: "nonsense" }, { status: 400, body: { error: "invalid_state" } }]) {
      expect(readListing(answer), JSON.stringify(answer)).toEqual({ ok: false, why: "unavailable" });
    }
  });
});

describe("every answer of the decision route", () => {
  const refused = (status: number, error: string, result: Record<string, unknown> = {}, action = "proposed") =>
    readDecision({ status, body: { error, result: { ok: false, refused: error, ...result }, action } }, true);

  it("reads a decision only when the route says it settled, with where the send stands", () => {
    expect(readDecision({ status: 200, body: { result: { ok: true, decision }, action: "confirmed" } }, true))
      .toEqual({ kind: "decided", approved: true, action: "confirmed" });
    expect(readDecision({ status: 200, body: { result: { ok: true, decision }, action: "rejected" } }, false))
      .toEqual({ kind: "decided", approved: false, action: "rejected" });
    for (const action of ["approved", "dispatching", "failed", "unknown"]) {
      expect(readDecision({ status: 200, body: { result: { ok: true, decision }, action } }, true))
        .toEqual({ kind: "decided", approved: true, action });
    }
    expect(readDecision({ status: 200, body: { result: { ok: true }, action: "sent-ish" } }, true))
      .toEqual({ kind: "decided", approved: true, action: null });
    expect(readDecision({ status: 200, body: { result: { ok: "yes" } } }, true)).toEqual({ kind: "unclear" });
  });

  it("reads each of approval-core's refusals, and who decided first", () => {
    expect(refused(409, "already_decided", { decision }, "confirmed")).toEqual({ kind: "already", decision, action: "confirmed" });
    expect(refused(409, "already_decided")).toEqual({ kind: "unclear" });
    expect(refused(409, "changed", { currentRevision: 2 })).toEqual({ kind: "changed" });
    expect(refused(409, "superseded", { reason: "withdrawn" })).toEqual({ kind: "superseded", reason: "withdrawn" });
    expect(refused(410, "expired", { expiredAt: T0 })).toEqual({ kind: "expired", at: T0 });
    expect(refused(410, "expired", { expiredAt: "soon" })).toEqual({ kind: "expired", at: null });
    expect(refused(403, "not_permitted")).toEqual({ kind: "not_permitted" });
    expect(refused(400, "not_offered")).toEqual({ kind: "not_offered" });
    expect(refused(404, "not_found")).toEqual({ kind: "gone" });
  });

  it("reads the switches, consent, an ended session, a removal, and anything else as unclear", () => {
    expect(readDecision({ status: 403, body: { error: "consent_required" } }, true)).toEqual({ kind: "consent_required" });
    expect(readDecision({ status: 403, body: { error: "feature_disabled", feature: "officeCloud" } }, true)).toEqual({ kind: "switched_off" });
    expect(readDecision({ status: 401, body: { error: "session_ended", shop: "pilot:a" } }, true)).toEqual({ kind: "session_ended" });
    expect(readDecision({ status: 401, body: { error: "removed", removedAt: iso(T0) } }, true))
      .toEqual({ kind: "left", left: { why: "removed", at: T0 } });
    for (const answer of [{ status: 503, body: { error: "approvals_unavailable" } }, { status: 400, body: { error: "invalid_request" } },
      { status: 500, body: null }, { status: 418, body: { error: "teapot" } }]) {
      expect(readDecision(answer, true), JSON.stringify(answer)).toEqual({ kind: "unclear" });
    }
  });
});
