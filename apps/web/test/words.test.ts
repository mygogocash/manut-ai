import { describe, expect, it } from "vitest";
import { ApiError, type AuditEntry, type DeletedShop, type PilotGate, type Shop } from "../src/api";
import {
  auditActorText,
  auditOutcomeTag,
  auditReasonText,
  auditSentence,
  auditSubjectText,
  auditWords,
  deletedText,
  deleteRefusalText,
  deleteWhatText,
  gateWords,
  subscriptionErrorText,
  unfinishedText,
} from "../src/ops/words";

const RESULT: DeletedShop = {
  tasksWiped: 1,
  connectionsWiped: 1,
  schedulesWiped: 0,
  occurrencesWiped: 0,
  sessionsWiped: 0,
  deletedAt: "2026-11-23T03:00:00Z",
};
const SAME_DAY = Date.parse("2026-11-23T04:00:00Z");
const NEXT_DAY = Date.parse("2026-11-24T04:00:00Z");

describe("the words for deleting a shop", () => {
  it("names only what the shop has when saying what goes", () => {
    const shop: Shop = { tenant: "t", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true };
    expect(deleteWhatText(shop)).toBe(
      "This removes everything stored for Baan Mali: customer messages, replies, recorded payments, the LINE connection and Fon's permission to send.",
    );
    expect(deleteWhatText({ tenant: "t", name: "Sabai Tea", ownerName: "Dao", consent: false })).toBe(
      "This removes everything stored for Sabai Tea: customer messages, replies and recorded payments.",
    );
  });

  it("says what a deletion removed and when, leaving out what there was none of", () => {
    expect(deletedText("Baan Mali", RESULT, SAME_DAY)).toBe(
      "Deleted Baan Mali at 10:00. Removed 1 task with its replies, 1 LINE connection and the shop's messages and payments.",
    );
    expect(
      deletedText(
        "Baan Mali",
        { ...RESULT, tasksWiped: 2, connectionsWiped: 0, schedulesWiped: 3, occurrencesWiped: 1, sessionsWiped: 2 },
        SAME_DAY,
      ),
    ).toBe(
      "Deleted Baan Mali at 10:00. Removed 2 tasks with their replies, 3 schedules, 1 scheduled run, 2 sign-in sessions and the shop's messages and payments.",
    );
    expect(deletedText("Sabai Tea", { ...RESULT, tasksWiped: 0, connectionsWiped: 0 }, NEXT_DAY)).toBe(
      "Deleted Sabai Tea on 23 November at 10:00. Removed the shop's messages and payments.",
    );
    expect(deletedText("Sabai Tea", { ...RESULT, tasksWiped: 0, connectionsWiped: 0, deletedAt: "" }, SAME_DAY)).toBe(
      "Deleted Sabai Tea. Removed the shop's messages and payments.",
    );
    expect(deletedText("Baan Mali", null)).toBe("Baan Mali is already deleted. Nothing of it was left to delete.");
  });

  it("says plainly whether a deletion that did not finish left data behind", () => {
    const incomplete = new ApiError(500, "wipe_incomplete");
    expect(unfinishedText({ name: "Baan Mali", partial: true, tries: 1, error: incomplete })).toBe(
      "Deleting Baan Mali did not finish. Part of its data is deleted and the rest is still stored. Run it again to finish the job.",
    );
    expect(unfinishedText({ name: "Baan Mali", partial: true, tries: 2, error: new ApiError(0, "network") })).toBe(
      "Deleting Baan Mali still did not finish after 2 tries. Part of its data is deleted and the rest is still stored. Could not reach the API. Check the connection and try again. Run it again to finish the job.",
    );
    expect(unfinishedText({ name: "Baan Mali", partial: false, tries: 1, error: new ApiError(503, "storage_unavailable") })).toBe(
      "It is not clear whether Baan Mali was deleted. The API answered with an error (storage_unavailable). Running it again is safe, and finishes the job if anything is left.",
    );
    expect(unfinishedText({ name: "Baan Mali", partial: false, tries: 3, error: new ApiError(0, "network") })).toBe(
      "After 3 tries, it is still not clear whether Baan Mali was deleted. Could not reach the API. Check the connection and try again. Running it again is safe, and finishes the job if anything is left.",
    );
  });

  it("says nothing was deleted when the API refuses", () => {
    expect(deleteRefusalText(new ApiError(409, "name_mismatch"))).toBe(
      "Nothing was deleted. The name did not match the shop's name exactly. Check the name and type it again.",
    );
    expect(deleteRefusalText(new ApiError(400, "invalid_request"))).toBe(
      "Nothing was deleted. The API did not accept this (invalid_request).",
    );
    expect(deleteRefusalText(new ApiError(503, "audit_unavailable"))).toBe(
      "Nothing was deleted. The API could not record the deletion, so it did not start. It is safe to try again.",
    );
  });

  it("says why a run of an unfinished deletion did not start", () => {
    expect(
      unfinishedText({ name: "Baan Mali", partial: true, tries: 2, error: new ApiError(503, "audit_unavailable") }),
    ).toBe(
      "Deleting Baan Mali still did not finish after 2 tries. Part of its data is deleted and the rest is still stored. The API could not record the deletion, so it did not start. It is safe to try again. Run it again to finish the job.",
    );
  });
});

describe("the Pilot gate's words", () => {
  /// A cohort of `counted` shops, each share meeting its line or not.
  function gate(paidMet: boolean, activeMet: boolean, counted = 2): PilotGate {
    return {
      asOf: "2026-12-22T03:00:00.000Z",
      rules: { trialDays: 14, priceSatang: 49900, activeWindowDays: 7 },
      shops: [],
      cohort: {
        counted,
        paid: { count: paidMet ? counted : 0, percent: paidMet ? 100 : 0, thresholdPercent: 25, met: paidMet },
        active: { count: activeMet ? counted : 0, percent: activeMet ? 100 : 0, thresholdPercent: 50, met: activeMet },
        status: paidMet && activeMet ? "on_track" : "below_line",
      },
    };
  }

  it("names the share that is under its line", () => {
    expect(gateWords.statusText(gate(true, true))).toBe("Both shares are at or above their lines, counting 2 shops.");
    expect(gateWords.statusText(gate(false, true))).toBe("Paying shops are under 25%, counting 2 shops.");
    expect(gateWords.statusText(gate(true, false))).toBe("Shops active on day 14 are under 50%, counting 2 shops.");
    expect(gateWords.statusText(gate(false, false, 1))).toBe(
      "Paying shops are under 25% and shops active on day 14 under 50%, counting 1 shop.");
  });

  it("tells a slip recorded twice apart from the API's other refusals", () => {
    expect(subscriptionErrorText(new ApiError(409, "slip_already_recorded"), "Baan Mali")).toBe(
      "This slip is already recorded for Baan Mali. Nothing was recorded again.");
    expect(subscriptionErrorText(new ApiError(400, "invalid_request"), "Baan Mali")).toBe(
      "The API did not accept this (invalid_request).");
  });
});

describe("the audit log's words", () => {
  const op = { kind: "operator" as const, email: "ops@manut.test" };
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-23T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok",
    ...overrides });

  it("names who did it the way an operator knows them", () => {
    expect(auditActorText(op, "Fon")).toBe("ops@manut.test");
    expect(auditActorText({ kind: "operator", email: null }, "Fon")).toBe("An operator (no Access identity)");
    expect(auditActorText({ kind: "owner" }, "Fon")).toBe("Fon");
    expect(auditActorText({ kind: "owner", id: "owner-phone-1" }, "Fon")).toBe("Fon (owner-phone-1)");
    expect(auditActorText({ kind: "helper", id: "staff-2" }, "Fon")).toBe("Helper staff-2");
    expect(auditActorText({ kind: "worker", attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" }, "Fon"))
      .toBe("Worker attempt 6f9d1f0e");
    expect(auditActorText({ kind: "system" }, "Fon")).toBe("Manut AI");
  });

  it("says what happened in one sentence, with the money it was about", () => {
    expect(auditSentence(entry({ actor: op, action: "payment.recorded", amountSatang: 129000 }), "Fon"))
      .toBe("ops@manut.test recorded an order payment of ฿1,290.");
    expect(auditSentence(entry({ actor: op, action: "subscription_payment.recorded", amountSatang: 49900 }), "Fon"))
      .toBe("ops@manut.test recorded a subscription payment of ฿499.");
    expect(auditSentence(entry({ actor: op, action: "model.cap_set", amountSatang: 15050 }), "Fon"))
      .toBe("ops@manut.test set the monthly model cap to ฿150.50.");
    expect(auditSentence(entry({ actor: op, action: "line.connected", subject: { connectionId: "c1" } }), "Fon"))
      .toBe("ops@manut.test connected the shop's LINE account.");
    expect(auditSentence(entry({ actor: op, action: "line.connected",
      subject: { connectionId: "c2", previousConnectionId: "c1" } }), "Fon"))
      .toBe("ops@manut.test connected a new LINE account in place of the old one.");
    expect(auditSentence(entry({ actor: { kind: "owner" }, action: "reply.decided", outcome: "approved" }), "Fon"))
      .toBe("Fon decided a reply.");
    expect(auditSentence(entry({ action: "dispatch.settled", outcome: "confirmed" }), "Fon"))
      .toBe("Manut AI finished sending an approved action.");
    expect(auditSentence(entry({ actor: { kind: "worker", attemptId: "6f9d1f0e-9a7e" }, action: "approval.requested" }),
      "Fon")).toBe("Worker attempt 6f9d1f0e asked for approval of an action.");
    expect(auditSentence(entry({ action: "something.new" }), "Fon")).toBe("Manut AI did something.new.");
  });

  it("tags each outcome, and explains a refusal or an attempt's end in plain words", () => {
    expect(auditOutcomeTag("ok", "Fon")).toBeNull();
    expect(auditOutcomeTag("approved", "Fon")).toEqual({ label: "Approved", className: "tag ok" });
    expect(auditOutcomeTag("declined", "Fon")).toEqual({ label: "Declined", className: "tag" });
    expect(auditOutcomeTag("awaiting_owner", "Fon")).toEqual({ label: "Waiting for Fon", className: "tag warn" });
    expect(auditOutcomeTag("confirmed", "Fon")).toEqual({ label: "Sent", className: "tag ok" });
    expect(auditOutcomeTag("failed", "Fon")).toEqual({ label: "Failed", className: "tag err" });
    expect(auditOutcomeTag("unknown", "Fon")).toEqual({ label: "Not sure it was sent", className: "tag warn" });
    expect(auditOutcomeTag("refused", "Fon")).toEqual({ label: "Refused", className: "tag warn" });
    expect(auditOutcomeTag("superseded", "Fon")).toEqual({ label: "No longer open", className: "tag" });
    expect(auditOutcomeTag("brand_new", "Fon")).toEqual({ label: "brand_new", className: "tag" });
    expect(auditReasonText("budget")).toBe("The shop's model budget ran out.");
    expect(auditReasonText("silent")).toBe("The worker stopped reporting.");
    expect(auditReasonText("attempt_ended")).toBe("Its attempt had already ended.");
    expect(auditReasonText("not_permitted")).toBe("That role may not decide it.");
    expect(auditReasonText("gave_up")).toBe("Reason: gave_up.");
  });

  it("lists the ids an entry is about, each once, in a fixed order", () => {
    expect(auditSubjectText({ requestId: "r1", actionId: "r1", taskId: "t1", attemptId: "a1" }))
      .toBe("task t1 · attempt a1 · action r1");
    expect(auditSubjectText({ actionId: "act_1", messageId: "msg_1", taskId: "t1" })).toBe("task t1 · action act_1 · message msg_1");
    expect(auditSubjectText({})).toBe("");
  });

  it("warns that a log with misses is not complete", () => {
    expect(auditWords.missed({ count: 1, lastAt: "2026-11-23T03:05:00.000Z", lastAction: "dispatch.settled" }, SAME_DAY))
      .toBe("1 entry could not be written, so this log is not complete. The last was at 10:05 (dispatch.settled).");
    expect(auditWords.missed({ count: 3, lastAt: "2026-11-23T03:05:00.000Z", lastAction: "reply.decided" }, NEXT_DAY))
      .toBe("3 entries could not be written, so this log is not complete. The last was at 23 November 10:05 (reply.decided).");
  });
});
