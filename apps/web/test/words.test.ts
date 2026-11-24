import { describe, expect, it } from "vitest";
import { APPROVAL_KINDS, mayDecide } from "@manut/approval-core";
import {
  ApiError,
  type AuditEntry,
  type DeletedShop,
  type Identity,
  type ModelCap,
  type ModelCounts,
  type ModelUsage,
  type People,
  type PilotGate,
  type Shop,
} from "../src/api";
import {
  auditActorText,
  auditNamesOf,
  auditOutcomeTag,
  auditReasonText,
  auditSentence,
  auditSubjectText,
  auditWords,
  callOutcomeTag,
  deletedText,
  deleteRefusalText,
  deleteWhatText,
  draftSendText,
  draftsErrorText,
  draftsWords,
  errorText,
  factSourceText,
  gateWords,
  jobAboutText,
  jobEndingNote,
  jobEndingTag,
  jobKindText,
  jobReasonText,
  memberName,
  memberRole,
  memoryErrorText,
  ownerAccountErrorText,
  memoryWords,
  modelErrorText,
  modelSpendWords,
  moneyText,
  monthName,
  monthsBack,
  peopleErrorText,
  peopleWords,
  percentUsed,
  shopsWords,
  spendLevel,
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
    // The shop list reports a deletion that did not finish with no answer of this console's to quote.
    expect(unfinishedText({ name: "Baan Mali", partial: true, tries: 0, error: null })).toBe(
      "Deleting Baan Mali did not finish. Part of its data is deleted and the rest is still stored. Run it again to finish the job.",
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

  it("says what a change to the team's memory did, naming the fact by its id", () => {
    const fact = { factId: "f3" };
    expect(auditSentence(entry({ actor: op, action: "memory.remembered", subject: fact }), "Fon"))
      .toBe("ops@manut.test told the team something to remember.");
    expect(auditSentence(entry({ actor: op, action: "memory.confirmed", subject: fact }), "Fon"))
      .toBe("ops@manut.test confirmed a fact as true.");
    expect(auditSentence(entry({ actor: op, action: "memory.corrected", subject: fact }), "Fon"))
      .toBe("ops@manut.test corrected a fact.");
    expect(auditSentence(entry({ actor: op, action: "memory.forgotten", subject: fact }), "Fon"))
      .toBe("ops@manut.test made the team forget a fact.");
    expect(auditSentence(entry({ action: "memory.proposed", subject: fact, outcome: "awaiting_owner" }), "Fon"))
      .toBe("Manut AI added something the team learned.");
    expect(auditSentence(entry({ actor: { kind: "worker", attemptId: "6f9d1f0e-9a7e" }, action: "memory.proposed", subject: fact }),
      "Fon")).toBe("Worker attempt 6f9d1f0e added something the team learned.");
    expect(auditSubjectText(fact)).toBe("fact f3");
    expect(auditSubjectText({ taskId: "t1", factId: "f3" })).toBe("task t1 · fact f3");
  });
});

describe("the memory page's words", () => {
  it("says where each fact came from, in the words of the canvas's board", () => {
    const priceList = { kind: "document" as const, name: "your price list", date: Date.parse("2026-11-03T05:00:00Z") };
    expect(factSourceText(priceList, "Fon")).toBe("From your price list, 3 November");
    expect(factSourceText({ kind: "edits", count: 12 }, "Fon")).toBe("Learned from 12 of your edits");
    expect(factSourceText({ kind: "orders", days: 90 }, "Fon")).toBe("From the last 90 days of orders");
    expect(factSourceText({ kind: "orders", days: 1 }, "Fon")).toBe("From the last day of orders");
    expect(factSourceText({ kind: "connection", name: "Google Sheets", detail: "cost sheet" }, "Fon"))
      .toBe("From your cost sheet in Google Sheets");
    expect(factSourceText({ kind: "connection", name: "Google Sheets", detail: " " }, "Fon")).toBe("From Google Sheets");
    expect(factSourceText({ kind: "owner" }, "Fon")).toBe("Told to the team by Fon");
    expect(factSourceText({ kind: "customer", chat: "line:Ufah" }, "Fon")).toBe("A customer said it, in chat line:Ufah");
  });

  it("never fails on a source it cannot read: a date that is not one is left out, and a kind it does not know is shown as it is", () => {
    expect(factSourceText({ kind: "document", name: "your price list", date: 1e300 }, "Fon")).toBe("From your price list");
    expect(factSourceText({ kind: "satellite", name: "x" } as never, "Fon")).toBe("From satellite");
    expect(factSourceText(null as never, "Fon")).toBe("From somewhere this console does not know yet");
  });

  it("says the board's own words once, and counts characters the way the API does", () => {
    expect(memoryWords.knownTitle).toBe("What your team knows");
    expect(memoryWords.sourceLabel).toBe("Where it came from");
    expect(memoryWords.waitingTitle).toBe("Waiting for your OK");
    expect(memoryWords.waitingNote).toBe("Not used until you confirm");
    expect(memoryWords.waitingLabel).toBe("Waiting for your OK: not used until you confirm");
    expect([memoryWords.confirm, memoryWords.correct, memoryWords.forget, memoryWords.remember, memoryWords.notConfirmed])
      .toEqual(["It's true", "Correct", "Forget", "Remember", "Not confirmed"]);
    expect(memoryWords.tellTitle).toBe("Tell Buddy something to remember");
    expect(memoryWords.tellHelp(0)).toBe("0 of 280 characters. The team uses it as soon as you save it.");
    expect(memoryWords.forgottenNote(1)).toBe(
      "1 text was forgotten. Only a fingerprint of it is kept, so the team does not learn it again.");
    expect(memoryWords.forgottenNote(3)).toBe(
      "3 texts were forgotten. Only a fingerprint of each is kept, so the team does not learn them again.");
  });

  it("explains each refusal the memory routes give, and the console's usual words for the rest", () => {
    expect(memoryErrorText(new ApiError(409, "already_known"))).toBe("The team already knows this: a fact says the same.");
    expect(memoryErrorText(new ApiError(409, "full"))).toBe("The team already holds 200 facts. Forget one to make room.");
    expect(memoryErrorText(new ApiError(400, "invalid_text"))).toBe("Write between 1 and 280 characters.");
    expect(memoryErrorText(new ApiError(404, "not_found"))).toBe("That fact is already gone. The list was refreshed.");
    expect(memoryErrorText(new ApiError(503, "memory_unavailable"))).toBe(
      "The API could not read or save what the team knows. Try again.");
    expect(memoryErrorText(new ApiError(403, "forbidden"))).toMatch(/^The API refused the operator key/);
    expect(memoryErrorText(new ApiError(0, "network"))).toBe("Could not reach the API. Check the connection and try again.");
    expect(memoryErrorText(new Error("x"))).toBe("Something unexpected went wrong. Try again.");
  });
});

describe("the model spend page's words", () => {
  const NONE: ModelCounts = { ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 };
  /// Baan Mali's month as the sample world has it, ฿186.59 of its ฿300 cap spent and held, with any figure replaced.
  function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
    return {
      tenant: "t1", month: "2026-11", capSatang: 30000, capSource: "override",
      capOverride: { capSatang: 30000, setAt: "2026-11-18T03:00:00.000Z", setBy: "ops@manut.test" },
      spentSatang: 18600, spentMillisatang: 18_599_456, heldSatang: 59, heldMillisatang: 58_800, remainingSatang: 11341,
      counts: { ok: 49, failed: 1, unreadable: 0, abandoned: 0, refused: 0 }, tokens: { input: 935_200, output: 89_780 },
      calls: [], holds: [], ...overrides,
    };
  }
  const empty = (overrides: Partial<ModelUsage> = {}) => usage({ spentSatang: 0, spentMillisatang: 0, heldSatang: 0,
    heldMillisatang: 0, remainingSatang: 30000, counts: NONE, tokens: { input: 0, output: 0 }, ...overrides });

  it("writes money with formatMoney: whole baht plain, satang to two places, thousands grouped", () => {
    expect(moneyText(18600)).toBe("฿186");
    expect(moneyText(11341)).toBe("฿113.41");
    expect(moneyText(59)).toBe("฿0.59");
    expect(moneyText(5)).toBe("฿0.05");
    expect(moneyText(0)).toBe("฿0");
    expect(moneyText(129000)).toBe("฿1,290");
    expect(moneyText(1_000_000_000)).toBe("฿10,000,000");
  });

  it("shows a marker, never a wrong amount or a crash, for a figure the API should never send", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, undefined, "18600"]) {
      expect(moneyText(bad as number)).toBe("unknown");
    }
  });

  it("puts a month at one of four levels, warning past half of the cap and at it", () => {
    expect(spendLevel(usage())).toBe("half");
    // Exactly half of the cap is not over half; one satang more is.
    expect(spendLevel(usage({ spentSatang: 14000, heldSatang: 1000, remainingSatang: 15000 }))).toBe("ok");
    expect(spendLevel(usage({ spentSatang: 14000, heldSatang: 1001, remainingSatang: 14999 }))).toBe("half");
    expect(spendLevel(usage({ spentSatang: 29000, heldSatang: 0, remainingSatang: 1000 }))).toBe("half");
    // Nothing left is the cap, however it came about: spend, calls in progress, a cap lowered under the spend, or a
    // zero cap that stops every call before anything is spent.
    expect(spendLevel(usage({ spentSatang: 30000, heldSatang: 0, remainingSatang: 0 }))).toBe("cap");
    expect(spendLevel(usage({ spentSatang: 100, heldSatang: 29900, remainingSatang: 0 }))).toBe("cap");
    expect(spendLevel(usage({ capSatang: 10000, remainingSatang: 0 }))).toBe("cap");
    expect(spendLevel(empty({ capSatang: 0, remainingSatang: 0 }))).toBe("cap");
    // A month with nothing spent, held, called or refused is empty; one failed call, which costs nothing, is not.
    expect(spendLevel(empty())).toBe("empty");
    expect(spendLevel(empty({ counts: { ...NONE, failed: 1 } }))).toBe("ok");
    expect(spendLevel(empty({ heldSatang: 59, heldMillisatang: 58_800, remainingSatang: 29941 }))).toBe("ok");
  });

  it("reads how much of the cap spend and holds take, in whole percent rounded down and never past 100", () => {
    expect(percentUsed(usage())).toBe(62);
    expect(percentUsed(empty())).toBe(0);
    expect(percentUsed(usage({ spentSatang: 29999, heldSatang: 0 }))).toBe(99);
    expect(percentUsed(usage({ spentSatang: 30000, heldSatang: 0 }))).toBe(100);
    expect(percentUsed(usage({ capSatang: 10000 }))).toBe(100);
    expect(percentUsed(empty({ capSatang: 0 }))).toBe(100);
  });

  it("names a month, and counts back through the months before it across a year's end", () => {
    expect(monthName("2026-11")).toBe("November 2026");
    expect(monthName("2027-01")).toBe("January 2027");
    expect(monthName("bogus")).toBe("bogus");
    expect(monthsBack("2026-11", 3)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(monthsBack("2026-02", 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
    expect(monthsBack("2026-11", 11).at(-1)).toBe("2025-12");
    expect(monthsBack("2026-11", 0)).toEqual([]);
    expect(monthsBack("bogus", 3)).toEqual([]);
  });

  it("says where a month stands, and what the cap means for the next call this month or in another", () => {
    expect(modelSpendWords.level.empty).toEqual({ label: "No spend yet", className: "tag" });
    expect(modelSpendWords.level.ok).toEqual({ label: "Under half of the cap", className: "tag ok" });
    expect(modelSpendWords.level.half).toEqual({ label: "Over half of the cap", className: "tag warn" });
    expect(modelSpendWords.level.cap).toEqual({ label: "At the cap", className: "tag err" });
    expect(modelSpendWords.usedText(62)).toBe("62% of the cap is used");
    expect(modelSpendWords.emptyText("2026-11", true)).toBe("No model calls yet this month.");
    expect(modelSpendWords.emptyText("2026-10", false)).toBe("No model calls in October 2026.");
    expect(modelSpendWords.atCapText(true, 30000)).toBe("New calls are refused until the cap is raised or the month turns.");
    expect(modelSpendWords.atCapText(false, 30000)).toBe("That month's spend and holds reached the cap.");
    expect(modelSpendWords.atCapText(true, 0)).toBe("The cap is ฿0, so every call is refused.");
    // The API keeps one cap per shop, not one per month, so an earlier month is read against today's cap.
    expect(modelSpendWords.pastNote).toBe(
      "The cap and what is left use the shop's cap as it is now. The API does not keep what the cap was in an earlier month.");
  });

  it("says whether the cap is the default or an operator's, and who set it and when", () => {
    expect(modelSpendWords.capSource(usage(), SAME_DAY)).toBe("Set by ops@manut.test on 18 November at 10:00.");
    const today = { capSatang: 30000, setAt: "2026-11-23T03:00:00.000Z", setBy: null };
    expect(modelSpendWords.capSource(usage({ capOverride: today }), SAME_DAY))
      .toBe("Set by an operator (no Access identity) at 10:00.");
    expect(modelSpendWords.capSource(usage({ capOverride: { ...today, setAt: "when?" } }), SAME_DAY))
      .toBe("Set by an operator (no Access identity).");
    expect(modelSpendWords.capSource(usage({ capSource: "default", capOverride: null, capSatang: 20000 }), SAME_DAY))
      .toBe("The default. No operator has set one for this shop.");
  });

  it("counts the calls made and refused, and says what became of the ones that did not finish", () => {
    expect(modelSpendWords.callsText({ ok: 49, failed: 1, unreadable: 0, abandoned: 0, refused: 0 }))
      .toBe("50 calls made, 0 refused at the cap.");
    expect(modelSpendWords.callsText({ ...NONE, ok: 1, refused: 3 })).toBe("1 call made, 3 refused at the cap.");
    expect(modelSpendWords.callsText({ ...NONE, ok: 1203, failed: 1 })).toBe("1,204 calls made, 0 refused at the cap.");
    expect(modelSpendWords.callsText(NONE)).toBe("0 calls made, 0 refused at the cap.");
    expect(modelSpendWords.outcomesText({ ...NONE, ok: 49, refused: 2 })).toBe("");
    expect(modelSpendWords.outcomesText({ ...NONE, ok: 49, failed: 1 })).toBe("Of these, 1 failed (not charged).");
    expect(modelSpendWords.outcomesText({ ok: 40, failed: 1, unreadable: 2, abandoned: 1, refused: 0 })).toBe(
      "Of these, 1 failed (not charged), 2 answered without a usable token count (charged at the worst case) and 1 never finished (charged at the worst case).");
  });

  it("says how much is held and for how many calls, and how many tokens went in and out", () => {
    expect(modelSpendWords.heldHelp(0)).toBe("No calls in progress.");
    expect(modelSpendWords.heldHelp(1)).toBe("1 call in progress, counted at its worst case.");
    expect(modelSpendWords.heldHelp(3)).toBe("3 calls in progress, counted at their worst case.");
    expect(modelSpendWords.heldHelp(null)).toBe("Calls in progress, counted at their worst case.");
    expect(modelSpendWords.spentHelp({ input: 935_200, output: 89_780 })).toBe("935,200 tokens in, 89,780 out.");
  });

  it("writes a call's tokens, tags how it ended, and says when the list is only the newest of the month's calls", () => {
    expect(modelSpendWords.tokensText(2800, 560)).toBe("2,800 in, 560 out");
    expect(modelSpendWords.tokensText(1_234_567, 0)).toBe("1,234,567 in, 0 out");
    expect(callOutcomeTag("ok")).toEqual({ label: "Done", className: "tag ok" });
    expect(callOutcomeTag("failed")).toEqual({ label: "Failed, not charged", className: "tag" });
    expect(callOutcomeTag("unreadable")).toEqual({ label: "Worst case charged", className: "tag warn" });
    expect(callOutcomeTag("abandoned")).toEqual({ label: "Never finished, worst case charged", className: "tag warn" });
    // A code this console does not know yet is shown as it is, never dropped.
    expect(callOutcomeTag("brand_new")).toEqual({ label: "brand_new", className: "tag" });
    // Refused calls have no record, so only the calls made are counted against the list.
    expect(modelSpendWords.newestNote(200, { ok: 340, failed: 2, unreadable: 0, abandoned: 0, refused: 5 }))
      .toBe("Showing the newest 200 of 342 calls.");
    expect(modelSpendWords.newestNote(50, { ...NONE, ok: 49, failed: 1 })).toBeNull();
  });

  it("names the setting a not-configured answer points at, and says whether a cap may have been written", () => {
    expect(modelErrorText(new ApiError(503, "not_configured", undefined, { setting: "MODEL_DEFAULT_CAP_SATANG" }), "read"))
      .toBe("The model gateway is not set up: the API setting MODEL_DEFAULT_CAP_SATANG is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.");
    expect(modelErrorText(new ApiError(503, "not_configured"), "write")).toBe(
      "The model gateway is not set up: one of the API's model settings is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.");
    expect(modelErrorText(new ApiError(503, "meter_unavailable"), "read"))
      .toBe("The API could not read this shop's model meter, so no spend is shown. Try again.");
    expect(modelErrorText(new ApiError(503, "meter_unavailable"), "write"))
      .toBe("The API could not confirm the cap, so it may not have changed. Check the cap shown, then try again.");
    // Everything else is the console's usual words.
    for (const error of [new ApiError(400, "invalid_request"), new ApiError(403, "forbidden"), new ApiError(0, "network"),
      new Error("odd")]) {
      expect(modelErrorText(error, "write")).toBe(errorText(error));
    }
    expect(modelErrorText(new ApiError(400, "invalid_request"), "write")).toBe("The API did not accept this (invalid_request).");
  });

  it("confirms a cap from the API's own answer, naming who set it and what clearing did", () => {
    const set: ModelCap = { tenant: "t1", capSatang: 25050, capSource: "override",
      capOverride: { capSatang: 25050, setAt: "2026-11-23T03:00:00.000Z", setBy: "ops@manut.test" } };
    expect(modelSpendWords.capAnswer("Baan Mali", set, SAME_DAY)).toBe(
      "The cap for Baan Mali is now ฿250.50, set by ops@manut.test at 10:00. It applies from the next call; calls already in progress keep the budget they hold.");
    expect(modelSpendWords.capAnswer("Baan Mali", { ...set, capOverride: { ...set.capOverride!, setBy: null } }, SAME_DAY))
      .toContain("set by an operator (no Access identity) at 10:00.");
    expect(modelSpendWords.capAnswer("Baan Mali", { tenant: "t1", capSatang: 20000, capSource: "default", capOverride: null },
      SAME_DAY)).toBe("The cap for Baan Mali is now ฿200, the default. The override is cleared.");
  });

  it("holds the form's refusals, which name the limit from the API's own", () => {
    expect(modelSpendWords.badCap).toBe("Write the cap in baht, like 300 or 300.50. It must be more than ฿0.");
    expect(modelSpendWords.tooBigCap).toBe("The cap can be at most ฿10,000,000.");
  });
});

// The owner's people, in plain words for the operator. Every sentence that holds a name is a function; the rest are said
// once. Money and public posts are never a helper's to approve, so no sentence here says otherwise.
describe("the People page's words", () => {
  const mint: Identity = { kind: "email", address: "mint@baanmali.example" };
  const beam: Identity = { kind: "line", id: "beam.baanmali" };

  it("says what the owner and a helper may approve, and never offers a helper money or public posts", () => {
    expect(peopleWords.ownerCan).toBe("Approves everything: messages and replies, money and public posts.");
    expect(peopleWords.helperCan("Fon")).toBe(
      "Approves messages and replies to customers. Money and public posts stay with Fon.");
    expect(peopleWords.ownerRole).toBe("Owner");
    expect(peopleWords.helperRole).toBe("Helper");
    // The table is read from approval-core's own rule, so it can never say something the rule does not.
    expect(APPROVAL_KINDS.map((kind) => [peopleWords.kindRow[kind], mayDecide("owner", kind), mayDecide("helper", kind)]))
      .toEqual([
        ["Messages to customers", true, true],
        ["Replies to customers", true, true],
        ["Money: refunds, discounts and payments", true, false],
        ["Public posts", true, false],
        ["Confirming that a payment arrived", true, false],
        ["Commands the team asks to run", true, false],
      ]);
    expect(peopleWords.yes).toBe("Yes");
    expect(peopleWords.no).toBe("No");
    expect(peopleWords.noAsks("Fon")).toBe("No, asks Fon");
    for (const kind of APPROVAL_KINDS) expect(peopleWords.kindTag[kind].length).toBeGreaterThan(0);
  });

  it("counts people and invites as the board does", () => {
    expect(peopleWords.count(1, 0)).toBe("1 person");
    expect(peopleWords.count(2, 0)).toBe("2 people");
    expect(peopleWords.count(2, 1)).toBe("2 people, 1 invited");
    expect(peopleWords.count(1, 3)).toBe("1 person, 3 invited");
    expect(peopleWords.whoTitle("Baan Mali")).toBe("Who can use Manut AI for Baan Mali");
  });

  it("says who a person is, since when, and on how many devices", () => {
    expect(peopleWords.identityText(mint)).toBe("mint@baanmali.example");
    expect(peopleWords.identityText(beam)).toBe("LINE ID beam.baanmali");
    expect(peopleWords.helperSince("2026-11-13T03:05:00.000Z")).toBe("Helper since 13 November.");
    expect(peopleWords.devices(0)).toBe("Not signed in on any device.");
    expect(peopleWords.devices(1)).toBe("Signed in on 1 device.");
    expect(peopleWords.devices(2)).toBe("Signed in on 2 devices.");
  });

  it("says in the board's words who is covering and until when", () => {
    expect(peopleWords.coverInForce("Mint", "2026-11-27T16:59:59.000Z"))
      .toBe("You are away until Friday 27 November. Mint is covering messages.");
    expect(peopleWords.coverOver("Mint", "2026-11-27T16:59:59.000Z"))
      .toBe("The cover for Mint ended on Friday 27 November. Nobody is covering now.");
    expect(peopleWords.noCover("Fon")).toBe(
      "Nobody is covering. Choose a helper and a day to let them approve messages while Fon is away.");
    expect(peopleWords.coverSet("Mint", "2026-11-27T16:59:59.000Z")).toBe("Mint covers messages until Friday 27 November.");
    expect(peopleWords.coverEnded).toBe("The cover has ended.");
    expect(peopleWords.coverNote("Fon")).toBe("Money and public posts still wait for Fon.");
  });

  it("asks once more before removing a helper, in the board's own words", () => {
    expect(peopleWords.removeTitle("Mint")).toBe("Remove Mint?");
    expect(peopleWords.removeEffect("Mint", "Baan Mali")).toBe(
      "Mint can no longer sign in to Baan Mali. Requests Mint was looking at go back to you.");
    expect(peopleWords.removeKept("Mint")).toBe("What Mint approved stays in the activity log, with Mint's name.");
    expect(peopleWords.removeYes("Mint")).toBe("Remove Mint");
    expect(peopleWords.removeNo("Mint")).toBe("Keep Mint");
  });

  it("says what a removal did from the API's own counts, leaving out what did not happen", () => {
    const answer = { removed: "helper-1", sessionsEnded: 2, invitesRevoked: [] as string[], coverEnded: false };
    expect(peopleWords.removed("Mint", answer)).toBe("Mint was removed and signed out on every device.");
    expect(peopleWords.removed("Mint", { ...answer, coverEnded: true }))
      .toBe("Mint was removed and signed out on every device. Their cover has ended.");
    expect(peopleWords.removed("Mint", { ...answer, invitesRevoked: ["inv-1"] }))
      .toBe("Mint was removed and signed out on every device. 1 pending invite for them was cancelled.");
    expect(peopleWords.removed("Mint", { ...answer, invitesRevoked: ["inv-1", "inv-2"], coverEnded: true }))
      .toBe("Mint was removed and signed out on every device. 2 pending invites for them were cancelled. Their cover has ended.");
  });

  it("says that an invite's link is sent by hand, and what an invite can and cannot do", () => {
    expect(peopleWords.sendYourself).toBe("Send this link yourself; Manut AI does not send it.");
    expect(peopleWords.inviteReady("Beam")).toBe("The invite for Beam is ready.");
    expect(peopleWords.copyInviteOf("Beam")).toBe("for Beam's invite");
    expect(peopleWords.copyNewInvite).toBe("for the new invite");
    expect(peopleWords.inviteCan("Beam", "Fon")).toBe(
      "Beam can approve messages and replies to customers. Money and public posts stay with Fon.");
    expect(peopleWords.inviteCan("", "Fon")).toBe(
      "A helper can approve messages and replies to customers. Money and public posts stay with Fon.");
    expect(peopleWords.identityHelp).toContain("Manut AI does not send the invite");
    expect(peopleWords.identityHelp).toContain("works once, for 7 days");
    // What the pilot cannot do yet is said where the operator types the account, so no invite is made in hope.
    expect(peopleWords.signInNote).toBe(
      "Signing in with LINE is not built yet, so an invite to a LINE ID cannot be opened until it is. An email invite opens only for someone whose Apple ID uses that email.");
    expect(peopleWords.inviteMade("2026-11-23T01:00:00.000Z", "2026-11-30T01:00:00.000Z"))
      .toBe("Invite made 23 November at 08:00. It works once, until Monday 30 November at 08:00.");
    expect(peopleWords.inviteRanOut("2026-11-30T01:00:00.000Z"))
      .toBe("This invite ran out on Monday 30 November at 08:00. Invite again for a new link.");
  });

  it("says when a note was passed on, in the kind's short name, or as it is for a kind it does not know", () => {
    expect(peopleWords.notePassedBy("Mint")).toBe("Passed on by Mint");
    expect(peopleWords.kindOf("money")).toBe("Money");
    expect(peopleWords.kindOf("public_post")).toBe("Public post");
    expect(peopleWords.kindOf("something_new")).toBe("something_new");
    expect(peopleWords.noteWhen("2026-11-23T00:00:00.000Z")).toBe("23 November at 07:00");
    expect(peopleWords.noteRequest("req_refund")).toBe("request req_refund");
    expect(peopleWords.noNotes("Fon")).toBe(
      "No notes yet. When a helper cannot approve a request, they can pass it to Fon with a note, and it shows here.");
    expect(peopleWords.removedNote(["Mint"])).toBe(
      "Removed helpers: Mint. What they approved stays in the activity log, with their names.");
    expect(peopleWords.removedNote(["Mint", "Kai", "Pim"])).toBe(
      "Removed helpers: Mint, Kai and Pim. What they approved stays in the activity log, with their names.");
  });

  it("names the setting a link needs, and explains each refusal of the people routes", () => {
    expect(peopleWords.notConfigured("WEB_ORIGIN")).toBe(
      "The API cannot make invite links: its setting WEB_ORIGIN is missing or cannot be read. Ask whoever deploys the API to fix it, then try again.");
    expect(peopleWords.notConfigured()).toContain("one of its link settings");
    const said = (status: number, code: string, setting?: string) =>
      peopleErrorText(new ApiError(status, code, undefined, setting ? { setting } : {}));
    expect(said(409, "already_invited")).toBe(
      "That account already has an invite waiting. Send its link, or cancel it first.");
    expect(said(409, "already_helper")).toBe("That person is already a helper.");
    expect(said(400, "bad_identity")).toBe("Write a LINE ID, or an email address like name@example.com.");
    expect(said(400, "invalid_request")).toBe("Write a name of 1 to 80 characters, and a LINE ID or an email address.");
    expect(said(404, "unknown_invite")).toBe("That invite is already gone. The list was refreshed.");
    expect(said(409, "not_pending")).toBe(
      "That invite was already used or cancelled, so it cannot be cancelled. The list was refreshed.");
    expect(said(404, "not_a_helper")).toBe("That person is no longer a helper. The list was refreshed.");
    expect(said(400, "bad_date")).toBe("Choose a day that has not passed yet.");
    expect(said(503, "people_unavailable")).toBe(
      "The API could not read or save this shop's people. Check the list, then try again.");
    expect(said(503, "not_configured", "APPROVAL_LINK_SECRET")).toContain("its setting APPROVAL_LINK_SECRET");
    // Anything else is the console's usual words.
    expect(said(403, "forbidden")).toContain("The API refused the operator key");
    expect(said(0, "network")).toBe("Could not reach the API. Check the connection and try again.");
    expect(peopleErrorText(new Error("boom"))).toBe("Something unexpected went wrong. Try again.");
  });
});

// The owner's linked account on the People page (docs/several-shops.md): what the owner's row says, the code box, the question before
// unlinking, and a refusal of either route in plain words.
describe("the People page's words for the owner's linked account", () => {
  it("says on the owner's row whether an account is linked, in plain words", () => {
    expect(peopleWords.ownerLinked("2026-11-12T03:00:00.000Z")).toBe("Linked to the owner's account on 12 November");
    expect(peopleWords.ownerNotLinked).toBe("Not linked to an account yet");
    expect(peopleWords.intro("Fon")).toBe(
      "Who can use Manut AI for this shop. Fon cannot change this list from the app yet, so invite, cancel, remove and set cover only when Fon asks you to.");
  });

  it("takes the code only from the owner, and says how it is written and what Link does", () => {
    expect(peopleWords.linkTitle).toBe("Link the owner's account");
    expect(peopleWords.codeLabel).toBe("Link code");
    expect(peopleWords.codeHelp).toBe(
      "8 letters and numbers, as the owner's app shows them: like K7M4-X9RQ. Capitals or small letters, with or without the dash.");
    expect(peopleWords.codeTake).toBe("Take the code only from the owner, on a call or in the shop's own chat.");
    expect([peopleWords.link, peopleWords.linking]).toEqual(["Link", "Linking"]);
    expect(peopleWords.linked("Fon", "Baan Mali")).toBe("Linked. Baan Mali now shows in Fon's app.");
  });

  it("asks once more before unlinking with what it does, and says what it did from the API's own count", () => {
    expect(peopleWords.unlink).toBe("Unlink");
    expect(peopleWords.unlinkTitle("Fon")).toBe("Unlink Fon's account?");
    expect(peopleWords.unlinkEffect("Fon")).toBe("Fon's app will be signed out of this shop on every device.");
    expect(peopleWords.unlinkNote("Fon")).toBe("Fon can link the account again later with a new code.");
    expect(peopleWords.unlinkYes("Fon")).toBe("Unlink Fon's account");
    expect(peopleWords.unlinkNo).toBe("Keep the link");
    expect(peopleWords.unlinking).toBe("Unlinking");
    expect(peopleWords.unlinked(2)).toBe("Unlinked. 2 sessions ended.");
    expect(peopleWords.unlinked(1)).toBe("Unlinked. 1 session ended.");
    expect(peopleWords.unlinked(0)).toBe("Unlinked. 0 sessions ended.");
  });

  it("explains each refusal of linking in plain words, and the console's usual words for the rest", () => {
    const said = (status: number, code: string) => ownerAccountErrorText(new ApiError(status, code), "link");
    expect(said(404, "unknown_code")).toBe("That code is not known or has run out. Ask the owner for a new one.");
    expect(said(410, "code_expired")).toBe("That code has run out. A code works for 15 minutes. Ask the owner for a new one.");
    expect(said(409, "already_linked")).toBe("This shop is already linked to an account. Unlink it first.");
    expect(said(400, "invalid_request")).toBe("Write the code the owner's app shows: 8 letters and numbers, like K7M4-X9RQ.");
    expect(said(503, "index_unavailable")).toBe(
      "The account is linked, but the owner's app cannot list the shop yet. Ask the owner for a new code and link again to put it there.");
    expect(said(503, "shops_unavailable")).toBe(
      "The API could not link the account just now. Press Refresh to see whether it did, then try again with a new code from the owner.");
    expect(said(404, "shop_not_found")).toBe("Not found (shop_not_found). It may have been removed.");
    expect(said(403, "forbidden")).toContain("The API refused the operator key");
    expect(said(0, "network")).toBe("Could not reach the API. Check the connection and try again.");
    expect(ownerAccountErrorText(new Error("boom"), "link")).toBe("Something unexpected went wrong. Try again.");
  });

  it("explains each refusal of unlinking in plain words, and does not borrow the link's words for the same code", () => {
    const said = (status: number, code: string) => ownerAccountErrorText(new ApiError(status, code), "unlink");
    expect(said(404, "not_linked")).toBe("This shop has no linked account now. The list was refreshed.");
    expect(said(503, "shops_unavailable")).toBe("The API could not read or save this shop's people. Check the list, then try again.");
    // `invalid_request` means a bad code only when linking: unlinking sends no code.
    expect(said(400, "invalid_request")).toBe("The API did not accept this (invalid_request).");
    expect(said(404, "unknown_code")).toBe("Not found (unknown_code). It may have been removed.");
    expect(said(403, "forbidden")).toContain("The API refused the operator key");
  });
});

// The new audit actions: the owner's people and browser control. Each reads as one sentence by who did it, with the
// people's names when the people list knows them, and none is ever shown by its raw action name.
describe("the audit log's words for the owner's people and for browser control", () => {
  const op = { kind: "operator" as const, email: "ops@manut.test" };
  const helper = { kind: "helper" as const, id: "helper-1" };
  const worker = { kind: "worker" as const, attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" };
  const outpost = { kind: "outpost" as const, id: "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b" };
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-23T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok",
    ...overrides });
  const said = (overrides: Partial<AuditEntry>, names: Record<string, string> = {}) =>
    auditSentence(entry(overrides), "Fon", names);

  it("says what each of the people's eight actions did, with the owner's name where it helps", () => {
    expect(said({ actor: op, action: "invite.created", subject: { inviteId: "inv-1" } })).toBe("ops@manut.test invited a helper.");
    expect(said({ actor: op, action: "invite.revoked", subject: { inviteId: "inv-1" } })).toBe("ops@manut.test cancelled an invite.");
    expect(said({ actor: helper, action: "helper.joined", subject: { inviteId: "inv-1", helperId: "helper-1" } }))
      .toBe("Helper helper-1 joined the shop through an invite.");
    expect(said({ actor: helper, action: "helper.session_opened", subject: { helperId: "helper-1" } }))
      .toBe("Helper helper-1 signed in on another device.");
    expect(said({ actor: op, action: "helper.removed", subject: { helperId: "helper-1" } })).toBe("ops@manut.test removed a helper.");
    expect(said({ actor: op, action: "away.set", subject: { helperId: "helper-1" } }))
      .toBe("ops@manut.test set a helper to cover messages while Fon is away.");
    expect(said({ actor: op, action: "away.cleared", subject: { helperId: "helper-1" } })).toBe("ops@manut.test ended the cover.");
    expect(said({ actor: helper, action: "request.passed_on", subject: { requestId: "req_1", taskId: "t1" } }))
      .toBe("Helper helper-1 passed a request on to Fon.");
  });

  it("names a helper, a removed helper and an invite by what the owner called them, once the people list knows them", () => {
    const names = { "helper-1": "Mint", "inv-1": "Beam" };
    expect(auditActorText(helper, "Fon", names)).toBe("Mint");
    expect(auditActorText(helper, "Fon")).toBe("Helper helper-1");
    expect(auditActorText({ kind: "helper", id: "helper-9" }, "Fon", names)).toBe("Helper helper-9");
    expect(said({ actor: op, action: "invite.created", subject: { inviteId: "inv-1" } }, names)).toBe("ops@manut.test invited Beam.");
    expect(said({ actor: op, action: "invite.revoked", subject: { inviteId: "inv-1" } }, names))
      .toBe("ops@manut.test cancelled Beam's invite.");
    expect(said({ actor: helper, action: "helper.joined", subject: { inviteId: "inv-1", helperId: "helper-1" } }, names))
      .toBe("Mint joined the shop through an invite.");
    expect(said({ actor: helper, action: "helper.session_opened", subject: { helperId: "helper-1" } }, names))
      .toBe("Mint signed in on another device.");
    expect(said({ actor: op, action: "helper.removed", subject: { helperId: "helper-1" } }, names)).toBe("ops@manut.test removed Mint.");
    expect(said({ actor: op, action: "away.set", subject: { helperId: "helper-1" } }, names))
      .toBe("ops@manut.test set Mint to cover messages while Fon is away.");
    expect(said({ actor: op, action: "away.cleared", subject: { helperId: "helper-1" } }, names))
      .toBe("ops@manut.test ended Mint's cover.");
    expect(said({ actor: helper, action: "request.passed_on", subject: { requestId: "req_1" } }, names))
      .toBe("Mint passed a request on to Fon.");
    // A helper who decided an approval is named too.
    expect(said({ actor: helper, action: "approval.decided", outcome: "approved" }, names)).toBe("Mint decided an approval request.");
    // A name an id merely shares with a property every object has is not a name.
    expect(auditActorText({ kind: "helper", id: "constructor" }, "Fon", {})).toBe("Helper constructor");
  });

  it("reads the names off the people list: helpers, removed helpers and invites, skipping any it has no name for", () => {
    const people: People = {
      tenant: "t1",
      owner: { name: "Fon", account: null },
      helpers: [{ id: "helper-1", name: "Mint", identity: { kind: "email", address: "mint@baanmali.example" },
        joinedAt: "2026-11-13T03:05:00.000Z", devices: 1 }],
      invites: [{ id: "inv-1", name: "Beam", identity: { kind: "line", id: "beam.baanmali" }, status: "pending",
        createdAt: "2026-11-23T01:00:00.000Z", expiresAt: "2026-11-30T01:00:00.000Z" },
      { id: "inv-2", name: "", identity: { kind: "line", id: "x" }, status: "revoked", createdAt: "2026-11-23T01:00:00.000Z",
        expiresAt: "2026-11-30T01:00:00.000Z" }],
      away: null,
      passedOn: [],
      removed: [{ id: "helper-0", name: "Kai" }, { id: "helper-8", name: "" }],
    };
    expect(auditNamesOf(people)).toEqual({ "helper-1": "Mint", "inv-1": "Beam", "helper-0": "Kai" });
  });

  it("says what each of browser control's seven actions did, and by whom, including an outpost", () => {
    expect(auditActorText(outpost, "Fon")).toBe("Outpost b4c8d1e2");
    expect(said({ actor: op, action: "signin.created", subject: { signInId: "s1" } }))
      .toBe("ops@manut.test added a site sign-in to the vault.");
    expect(said({ actor: op, action: "signin.password_replaced", subject: { signInId: "s1" } }))
      .toBe("ops@manut.test replaced a site sign-in's password.");
    expect(said({ actor: op, action: "signin.removed", subject: { signInId: "s1" } }))
      .toBe("ops@manut.test removed a site sign-in from the vault.");
    expect(said({ actor: op, action: "outpost.registered", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test registered an outpost.");
    expect(said({ actor: worker, action: "signin.requested", subject: { signInId: "s1", outpostId: "o1" } }))
      .toBe("Worker attempt 6f9d1f0e asked to sign in to a site.");
    expect(said({ actor: worker, action: "signin.broken", subject: { signInId: "s1" } }))
      .toBe("Worker attempt 6f9d1f0e reported that a site refused a saved password.");
    expect(said({ actor: outpost, action: "signin.redeemed", subject: { outpostId: "o1" } }))
      .toBe("Outpost b4c8d1e2 asked for a sign-in to type into a site.");
  });

  it("has words for every new action: none is shown by its raw name or as an action it does not know", () => {
    const actors = { op, helper, worker, outpost };
    const actions: [string, keyof typeof actors][] = [
      ["invite.created", "op"], ["invite.revoked", "op"], ["helper.joined", "helper"], ["helper.session_opened", "helper"],
      ["helper.removed", "op"], ["away.set", "op"], ["away.cleared", "op"], ["request.passed_on", "helper"],
      ["signin.created", "op"], ["signin.password_replaced", "op"], ["signin.removed", "op"], ["signin.broken", "worker"],
      ["signin.requested", "worker"], ["signin.redeemed", "outpost"], ["outpost.registered", "op"],
    ];
    expect(actions).toHaveLength(15);
    for (const [action, who] of actions) {
      const sentence = said({ actor: actors[who], action });
      expect(sentence, action).not.toContain(action);
      expect(sentence, action).not.toMatch(/\bdid\b/);
      expect(sentence.endsWith("."), action).toBe(true);
    }
    // An action the console does not know yet is still shown as it is, never dropped.
    expect(said({ action: "something.new" })).toBe("Manut AI did something.new.");
  });

  it("labels the ids the new entries are about", () => {
    expect(auditSubjectText({ inviteId: "inv-1", helperId: "helper-1" })).toBe("invite inv-1 · helper helper-1");
    expect(auditSubjectText({ taskId: "t1", attemptId: "a1", signInId: "s1", outpostId: "o1", grantId: "g1" }))
      .toBe("task t1 · attempt a1 · sign-in s1 · outpost o1 · grant g1");
    expect(auditSubjectText({ requestId: "req_1", taskId: "t1" })).toBe("task t1 · request req_1");
  });

  it("explains why a sign-in step was refused, in plain words, and still shows a reason it does not know", () => {
    expect(auditReasonText("sign_in_not_found")).toBe("That sign-in was not found, or it had been removed.");
    expect(auditReasonText("member_not_allowed")).toBe("That member is not named on the sign-in.");
    expect(auditReasonText("sign_in_broken")).toBe("The site had refused the saved password, so a new one was needed.");
    expect(auditReasonText("outpost_not_found")).toBe("There was no such outpost.");
    expect(auditReasonText("outpost_asleep")).toBe("The outpost was asleep.");
    expect(auditReasonText("grant_not_found")).toBe("The shop had no such grant.");
    // A grant's or a browser step's: either way, it was another outpost's.
    expect(auditReasonText("wrong_outpost")).toBe("It was for another outpost.");
    expect(auditReasonText("grant_used")).toBe("The grant had already been used.");
    expect(auditReasonText("grant_expired")).toBe("The grant had run out of its 60 seconds.");
    expect(auditReasonText("feature_disabled")).toBe("That kind of work was switched off.");
    expect(auditReasonText("consent_required")).toBe("The owner had not allowed it, or had withdrawn permission.");
    expect(auditReasonText("vault_unavailable")).toBe("The vault did not answer.");
    expect(auditReasonText("vault_not_configured")).toBe("The vault has no key set.");
    expect(auditReasonText("unseal_failed")).toBe("The vault could not open the saved password.");
    expect(auditReasonText("task_unavailable")).toBe("The task could not be read.");
    // The reasons that already had words keep them.
    expect(auditReasonText("attempt_ended")).toBe("Its attempt had already ended.");
    expect(auditReasonText("new_reason")).toBe("Reason: new_reason.");
  });

  it("says what the step channel and an outpost's removal or new credential did, never by raw name", () => {
    expect(said({ actor: op, action: "outpost.removed", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test removed an outpost.");
    expect(said({ actor: op, action: "outpost.credential_rotated", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test gave an outpost a new credential.");
    expect(said({ actor: worker, action: "browser_step.queued", subject: { stepId: "st1", outpostId: "o1" } }))
      .toBe("Worker attempt 6f9d1f0e asked an outpost to run a browser step.");
    expect(said({ actor: outpost, action: "browser_step.fetched", subject: { stepId: "st1", outpostId: "o1" } }))
      .toBe("Outpost b4c8d1e2 picked up a browser step.");
    expect(said({ actor: outpost, action: "browser_step.reported", subject: { stepId: "st1", outpostId: "o1" },
      outcome: "done" })).toBe("Outpost b4c8d1e2 reported how a browser step went.");
    expect(auditSubjectText({ outpostId: "o1", stepId: "st1", attemptId: "a1", taskId: "t1" }))
      .toBe("task t1 · attempt a1 · outpost o1 · browser step st1");
    for (const [reason, words] of [
      ["step_kind_not_allowed", "Only steps that read are allowed so far."],
      ["origin_not_allowed", "The page was not on a site that member may use."],
      ["step_expired", "The step had run out of its two minutes."],
      ["text_withheld", "What it read held a saved password, so it was kept nowhere."],
      ["sign_in_refused", "The site refused the saved password."],
      ["outpost_removed", "The outpost had been removed."],
    ] as const) {
      expect(auditReasonText(reason)).toBe(words);
    }
    for (const reason of ["invalid_url", "invalid_selector", "too_many_steps", "grant_queued", "step_not_found",
      "step_not_fetched", "step_reported", "invalid_report", "page_unavailable", "selector_not_found", "grant_refused",
      "timed_out", "browser_error"]) {
      expect(auditReasonText(reason), reason).not.toContain(reason);
    }
  });
});

// The owner's linked account and the shop sessions (docs/several-shops.md): the operator links and unlinks an account, and a
// device opens and ends its own session. Each reads as one sentence by who did it, by ids only, never by its raw action name.
describe("the audit log's words for the owner's linked account", () => {
  const op = { kind: "operator" as const, email: "ops@manut.test" };
  const owner = { kind: "owner" as const, id: "owner-1" };
  const helper = { kind: "helper" as const, id: "helper-1" };
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-24T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok", ...overrides });
  const said = (overrides: Partial<AuditEntry>, names: Record<string, string> = {}) =>
    auditSentence(entry(overrides), "Fon", names);

  it("says what linking, unlinking, opening and ending a session did, with the owner's name where it helps", () => {
    expect(said({ actor: op, action: "owner.linked", subject: { ownerAccountId: "owner-1" } }))
      .toBe("ops@manut.test linked Fon's account to the shop.");
    expect(said({ actor: op, action: "owner.unlinked", subject: { ownerAccountId: "owner-1" } }))
      .toBe("ops@manut.test unlinked Fon's account from the shop.");
    expect(said({ actor: owner, action: "owner.session_opened", subject: { ownerAccountId: "owner-1" } }))
      .toBe("Fon (owner-1) signed in to the shop on a device.");
    expect(said({ actor: owner, action: "owner.session_ended", subject: { ownerAccountId: "owner-1" } }))
      .toBe("Fon (owner-1) signed out of the shop on a device.");
    expect(said({ actor: helper, action: "helper.session_ended", subject: { helperId: "helper-1" } }))
      .toBe("Helper helper-1 signed out on a device.");
    expect(said({ actor: helper, action: "helper.session_ended", subject: { helperId: "helper-1" } }, { "helper-1": "Mint" }))
      .toBe("Mint signed out on a device.");
  });

  it("has words for each of them: none is shown by its raw name or as an action it does not know", () => {
    for (const [action, actor] of [["owner.linked", op], ["owner.unlinked", op], ["owner.session_opened", owner],
      ["owner.session_ended", owner], ["helper.session_ended", helper]] as const) {
      const sentence = said({ actor, action });
      expect(sentence, action).not.toContain(action);
      expect(sentence, action).not.toMatch(/\bdid\b/);
      expect(sentence.endsWith("."), action).toBe(true);
    }
  });

  it("labels the link's id an entry is about", () => {
    expect(auditSubjectText({ ownerAccountId: "owner-1" })).toBe("owner account owner-1");
    expect(auditSubjectText({ helperId: "helper-1", ownerAccountId: "owner-1" })).toBe("helper helper-1 · owner account owner-1");
  });
});

describe("the drafts page's words", () => {
  it("says plainly, in the intro and on every draft, that nothing has been sent and that this page cannot send it", () => {
    expect(draftsWords.intro).toContain("has not been sent to anyone");
    expect(draftsWords.intro).toContain("nothing on this page sends it");
    expect(draftsWords.notSent).toBe("Not sent");
    expect(draftsWords.notSentNote).toBe("This is a draft. It has not been sent to anyone.");
    // No word on the page offers to send: the only verbs about sending say it is not done.
    for (const text of [draftsWords.nav, draftsWords.title, draftsWords.refresh, draftsWords.older, draftsWords.notSent]) {
      expect(text).not.toMatch(/\bsend\b/i);
    }
  });

  it("names the members as people say them, with the part each plays, and shows one it does not know as it is", () => {
    expect([memberName("nam"), memberName("pim"), memberName("ton")]).toEqual(["Nam", "Pim", "Ton"]);
    expect([memberRole("nam"), memberRole("pim"), memberRole("ton")]).toEqual(["sales chat", "content", "books"]);
    expect(memberName("kit")).toBe("kit");
    expect(memberRole("kit")).toBeNull();
    // An own property only: a name that is on every object is not a member.
    expect(memberName("constructor")).toBe("constructor");
    expect(memberRole("toString")).toBeNull();
  });

  it("names each kind of job, and shows a kind it does not know as it is", () => {
    expect([jobKindText("reply"), jobKindText("post"), jobKindText("daily_summary")]).toEqual([
      "Reply to a customer", "Post", "Sales summary"]);
    expect(jobKindText("refund")).toBe("refund");
  });

  it("tags each ending, naming the owner who is waited for and the member a job was passed to", () => {
    expect(jobEndingTag({ state: "running" }, "Fon")).toEqual({ label: "Running", className: "tag run" });
    expect(jobEndingTag({ state: "done" }, "Fon")).toEqual({ label: "Done", className: "tag ok" });
    expect(jobEndingTag({ state: "failed", reason: "budget" }, "Fon")).toEqual({ label: "Failed", className: "tag err" });
    expect(jobEndingTag({ state: "awaiting_owner" }, "Fon")).toEqual({ label: "Waiting for Fon", className: "tag warn" });
    expect(jobEndingTag({ state: "handed_over", to: "ton" }, "Fon")).toEqual({ label: "Passed to Ton", className: "tag" });
    expect(jobEndingTag({ state: "cancelled" }, "Fon")).toEqual({ label: "Cancelled", className: "tag" });
    // A state a newer API sends is shown as it is, never dropped.
    expect(jobEndingTag({ state: "paused" } as never, "Fon")).toEqual({ label: "paused", className: "tag" });
  });

  it("says in a line how a job that did not simply finish stands", () => {
    expect(jobEndingNote({ state: "done" })).toBeNull();
    expect(jobEndingNote({ state: "running" })).toBe("Still working on it.");
    expect(jobEndingNote({ state: "failed", reason: "budget" })).toBe("The shop's model budget ran out.");
    expect(jobEndingNote({ state: "awaiting_owner" })).toBe("Asked for an approval and stopped until it is answered.");
    expect(jobEndingNote({ state: "handed_over", to: "nam" })).toBe("Nam has not taken it up yet.");
    expect(jobEndingNote({ state: "cancelled" })).toBe("It was stopped before it finished.");
    expect(jobEndingNote({ state: "paused" } as never)).toBeNull();
  });

  it("explains why a job failed in plain words, and shows a code it does not know as it is", () => {
    expect(jobReasonText("not_connected")).toBe("The shop's LINE connection to that customer is gone.");
    expect(jobReasonText("payments_unavailable")).toBe("The shop's recorded payments could not be read.");
    expect(jobReasonText("empty_draft")).toBe("The model wrote nothing, so there is no draft.");
    expect(jobReasonText("unknown")).toBe("It ended without saying why.");
    // The attempt's own codes keep the audit page's words.
    expect(jobReasonText("budget")).toBe("The shop's model budget ran out.");
    expect(jobReasonText("silent")).toBe("The worker stopped reporting.");
    expect(jobReasonText("deadline")).toBe("The attempt ran out of time.");
    expect(jobReasonText("flood")).toBe("Reason: flood.");
    expect(jobReasonText("constructor")).toBe("Reason: constructor.");
  });

  it("says what a draft is about: the message a reply answers, the day a summary covers", () => {
    expect(jobAboutText({ messageId: "msg_nok" })).toBe("Answers message msg_nok");
    expect(jobAboutText({ date: "2026-11-21" })).toBe("Sales on 21 November");
    expect(jobAboutText({ messageId: "msg_1", date: "2026-11-21" })).toBe("Answers message msg_1 · Sales on 21 November");
    expect(jobAboutText({ date: "last Friday" })).toBe("Sales on last Friday");
    expect(jobAboutText({})).toBeNull();
    expect(jobAboutText(undefined)).toBeNull();
  });

  it("says what sending a reply would take, which is never sending it here", () => {
    expect(draftSendText({ answer: "ask", kind: "reply" }, "Fon")).toBe(
      "To send it, propose it as a reply on the Messages tab. Fon approves it before anything is sent.");
    expect(draftSendText({ answer: "draft_only", kind: "reply" }, "Fon")).toBe(
      "The shop's LINE connection is still in practice mode, so a reply can only be drafted for now.");
    expect(draftSendText(undefined, "Fon")).toBeNull();
    expect(draftSendText({ answer: "ask", kind: "post" }, "Fon")).toBeNull();
  });

  it("writes a cost as baht from whole satang, and a handover as one sentence", () => {
    expect(draftsWords.cost(2)).toBe("Model cost ฿0.02");
    expect(draftsWords.cost(129000)).toBe("Model cost ฿1,290");
    expect(draftsWords.cost(0)).toBe("Model cost ฿0");
    // A figure the API never sends is shown as unknown, not as a wrong amount.
    expect(draftsWords.cost(1.5)).toBe("Model cost unknown");
    expect(draftsWords.passed("nam", "ton")).toBe("Nam passed this job to Ton.");
    expect(draftsWords.task("worker-task-1")).toBe("task worker-task-1");
    expect(draftsWords.listLabel("Baan Mali")).toBe("Baan Mali's worker jobs");
  });

  it("puts the drafts route's own refusals in words, and the console's usual words for the rest", () => {
    expect(draftsErrorText(new ApiError(503, "drafts_unavailable"))).toBe("The API could not read this shop's jobs. Try again.");
    expect(draftsErrorText(new ApiError(503, "shop_unavailable"))).toBe("The API could not read this shop's record. Try again.");
    expect(draftsErrorText(new ApiError(404, "shop_not_found"))).toBe(errorText(new ApiError(404, "shop_not_found")));
    expect(draftsErrorText(new ApiError(403, "forbidden"))).toMatch(/refused the operator key/);
    expect(draftsErrorText(new ApiError(0, "network"))).toBe("Could not reach the API. Check the connection and try again.");
  });
});

describe("the shops overview's words", () => {
  it("names each part of a shop that could not be read, and which shop it was", () => {
    expect(shopsWords.shopsFailed([{ name: "Sabai Tea", parts: ["model spend"] }])).toBe(
      "Some shops could not be read in full: Sabai Tea (model spend). Try again.");
    expect(shopsWords.shopsFailed([
      { name: "Sabai Tea", parts: ["model spend", "audit log"] },
      { name: "Baan Mali", parts: ["audit log"] },
    ])).toBe(
      "Some shops could not be read in full: Sabai Tea (model spend and audit log) and Baan Mali (audit log). Try again.");
    expect(shopsWords.parts).toEqual({ usage: "model spend", audit: "audit log" });
  });

  it("writes a month's spend against the cap as baht, and names the page each link opens for the shop", () => {
    expect(shopsWords.spendOf(18600, 30000)).toBe("฿186 of ฿300");
    expect(shopsWords.spendOf(0, 20000)).toBe("฿0 of ฿200");
    expect(shopsWords.spendOf(5, 20000)).toBe("฿0.05 of ฿200");
    expect(shopsWords.openLabel("Audit", "Baan Mali")).toBe("Audit for Baan Mali");
    expect(Object.values(shopsWords.open)).toEqual(["Messages", "Drafts", "Audit", "Memory", "People", "Model spend"]);
  });

  it("says why nothing is shown for the trial, payment and activity when the gate could not be read", () => {
    expect(shopsWords.gateFailed).toBe(
      "The pilot gate could not be read, so trials, payments and activity are not shown. Try again.");
    expect(shopsWords.unreadable).toBe("Could not be read");
    expect(shopsWords.columns.active(14)).toBe("Active on day 14");
    expect(shopsWords.columns.activeUnknown).toBe("Active");
  });
});
