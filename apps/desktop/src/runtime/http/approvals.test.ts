// The shop's approvals as `GET /v1/approvals` lists them, read with approval-core's own wire decoders: each standing, a
// kind, an effect, a status or a role this build does not know (kept, shown, never answerable), what a request shows,
// a note a helper passed on, and the ask id that carries the revision the person saw.
import { isUnknown } from "@manut/approval-core";
import { describe, expect, it } from "vitest";
import { answerable, askId, choicesOf, decodeApprovals, detailOf, isAsk, optionFor, parseAskId, type ShopApproval } from "./approvals";
import { approvalJson, iso, OPTIONS, replyDetail, T0 } from "./testkit";

/** Decodes one listing entry, and says what could not be read. */
function one(entry: unknown): { approval: ShopApproval | undefined; unreadable: unknown[] } {
  const unreadable: unknown[] = [];
  const [approval] = decodeApprovals({ state: "open", approvals: [entry] }, unreadable);
  return { approval, unreadable };
}
const decoded = (over: Parameters<typeof approvalJson>[0] = {}) => one(approvalJson(over)).approval!;
const decision = { requestId: "action-1", optionId: "approve", seenRevision: 1, decidedBy: "helper-mint", role: "helper", decidedAt: T0 + 300_000 };

describe("an open request", () => {
  it("reads a reply waiting for the owner as approval-core's record and standing, answerable once or not at all", () => {
    const a = decoded();
    expect(a.taskId).toBe("task-1");
    expect(a.record).toMatchObject({ status: "pending", request: { id: "action-1", kind: "reply", revision: 1, createdAt: T0 + 90_000, expiresAt: T0 + 24 * 3600_000 } });
    expect(a.standing).toEqual({ state: "open", reason: "waiting" });
    expect(a.passedOn).toBeNull();
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toMatchObject({ id: "action-1", kind: "reply", revision: 1, options: OPTIONS });
    expect(choicesOf(a)).toEqual(["once", "deny"]);
    expect(askId(a)).toBe("action-1@1");
  });

  it("keeps what the request shows, and only the words this app shows: the operation, where it goes, to whom, and its text", () => {
    const a = decoded({ detail: { ...replyDetail(), canary: "CANARY", nested: { token: "CANARY" } } });
    expect(detailOf(a.record.request)).toEqual({ actionId: "action-1", operationType: "line.message.push", targetResourceId: "bot-user-1", recipient: "U-customer", text: "Your order ships tomorrow morning." });
    expect(JSON.stringify(a.record)).not.toContain("CANARY");
    // the API's whole entry is kept apart, as every record the runtime reads keeps it, for a later slice
    expect(JSON.stringify(a.raw)).toContain("CANARY");
  });

  it("reads a worker's command, whose request names no words, and one with no detail at all", () => {
    const command = decoded({ id: "req-7", kind: "command", attemptId: "attempt-2", detail: { actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1", payloadHash: "h" } });
    expect(command.record.request).toMatchObject({ kind: "command", attemptId: "attempt-2" });
    expect(detailOf(command.record.request)).toEqual({ actionId: "req-7", operationType: "linear.issue.create", targetResourceId: "project-1" });
    expect(detailOf(decoded({ detail: "not an object" }).record.request)).toEqual({});
  });

  it("reads a note a helper passed on with the request", () => {
    const a = decoded({ passedOn: { by: "helper-mint", name: "Mint", note: "The jar arrived broken. It looks right to me.", at: iso(T0 + 200_000) } });
    expect(a.passedOn).toEqual({ by: "helper-mint", name: "Mint", note: "The jar arrived broken. It looks right to me.", at: T0 + 200_000 });
    expect(decoded({ passedOn: { by: "helper-mint", note: 3 } }).passedOn).toEqual({ by: "helper-mint", name: "", note: "", at: null });
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
      const a = decoded({ standing });
      expect(a.standing, JSON.stringify(standing)).toEqual(want);
      expect(isAsk(a), JSON.stringify(standing)).toBe(false);
      expect(answerable(a), JSON.stringify(standing)).toBeNull();
      expect(choicesOf(a), JSON.stringify(standing)).toEqual([]);
    }
  });

  it("keeps a superseded reason this build does not know, as approval-core keeps it", () => {
    const a = decoded({ standing: { state: "superseded", reason: "shop_closed" } });
    expect(a.standing).toEqual({ state: "superseded", reason: { unknown: true, raw: "shop_closed" } });
    expect(isAsk(a)).toBe(false);
  });

  it("keeps a state this build does not know, shows it as still asked, and never answers it", () => {
    const a = decoded({ standing: { state: "paused_by_owner" } });
    expect(isUnknown(a.standing.state)).toBe(true);
    expect(a.standing).toEqual({ state: { unknown: true, raw: "paused_by_owner" } });
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
    expect(choicesOf(a)).toEqual([]);
  });
});

describe("what this build does not know", () => {
  it("keeps a kind it does not know, shows it as still asked, and never answers it", () => {
    const a = decoded({ kind: "refund_partial" });
    expect(a.record.request.kind).toEqual({ unknown: true, raw: "refund_partial" });
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
    expect(choicesOf(a)).toEqual([]);
    expect(askId(a)).toBe("action-1@1");
  });

  it("does not answer a request with an option whose effect it does not know", () => {
    const a = decoded({ options: [...OPTIONS, { id: "later", label: "Later", effect: "snooze" }] });
    expect(a.record.request.options[2]).toEqual({ id: "later", label: "Later", effect: { unknown: true, raw: "snooze" } });
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
  });

  it("does not answer a record whose status it does not know, even when the standing says open", () => {
    const a = decoded({ status: "escalated" });
    expect(a.record.status).toEqual({ unknown: true, raw: "escalated" });
    expect(isAsk(a)).toBe(true);
    expect(answerable(a)).toBeNull();
  });

  it("keeps a decider's role it does not know as unknown, never as the owner", () => {
    const a = decoded({ standing: { state: "decided", reason: "decided", decision: { ...decision, role: "manager" } } });
    expect(a.standing).toMatchObject({ state: "decided", decision: { role: { unknown: true, raw: "manager" } } });
  });

  it("answers only what the card can offer one to one: one approve, one decline", () => {
    const twoApprovals = decoded({ options: [...OPTIONS, { id: "approve-all", label: "Approve all", effect: "approve" }] });
    expect(answerable(twoApprovals)).toBeNull();
    expect(choicesOf(twoApprovals)).toEqual([]);
    expect(answerable(decoded({ options: [] }))).toBeNull();
    const approveOnly = decoded({ options: [OPTIONS[0]] });
    expect(choicesOf(approveOnly)).toEqual(["once"]);
    const declineOnly = decoded({ options: [OPTIONS[1]] });
    expect(choicesOf(declineOnly)).toEqual(["deny"]);
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

  it("reads a body with no list as no approvals", () => {
    const unreadable: unknown[] = [];
    expect(decodeApprovals({ state: "open" }, unreadable)).toEqual([]);
    expect(decodeApprovals("nonsense", unreadable)).toEqual([]);
    expect(unreadable).toEqual([]);
  });

  it("keeps an entry whose task id is missing, as asked in no task the app knows", () => {
    const { taskId: _gone, ...entry } = approvalJson();
    expect(one(entry).approval?.taskId).toBe("");
  });
});

describe("answering", () => {
  it("chooses the option by what it does, never by its label: Allow once approves, Deny declines, and nothing else is offered", () => {
    const request = answerable(decoded({ options: [{ id: "yes-7", label: "ส่งเลย", effect: "approve" }, { id: "no-7", label: "ไม่ส่ง", effect: "decline" }] }))!;
    expect(optionFor(request, "once")).toEqual({ id: "yes-7", label: "ส่งเลย", effect: "approve" });
    expect(optionFor(request, "deny")).toEqual({ id: "no-7", label: "ไม่ส่ง", effect: "decline" });
    // approval-core has no standing approval: every decision covers exactly one request at one revision
    expect(optionFor(request, "session")).toBeNull();
    expect(optionFor(request, "always")).toBeNull();
    expect(optionFor(answerable(decoded({ options: [OPTIONS[0]] }))!, "deny")).toBeNull();
  });

  it("names the revision the person saw in the ask's id, and reads it back", () => {
    expect(askId(decoded({ id: "req-9", revision: 3 }))).toBe("req-9@3");
    expect(parseAskId("req-9@3")).toEqual({ id: "req-9", revision: 3 });
    expect(parseAskId("odd@id@2")).toEqual({ id: "odd@id", revision: 2 });
    for (const bad of ["req-9", "req-9@", "req-9@0", "req-9@-1", "req-9@1.5", "req-9@x", "@1", ""]) expect(parseAskId(bad), bad).toBeNull();
  });
});
