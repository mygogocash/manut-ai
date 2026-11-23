import { describe, expect, it } from "vitest";
import {
  ApiError,
  type AuditEntry,
  type DeletedShop,
  type ModelCap,
  type ModelCounts,
  type ModelUsage,
  type PilotGate,
  type Shop,
} from "../src/api";
import {
  auditActorText,
  auditOutcomeTag,
  auditReasonText,
  auditSentence,
  auditSubjectText,
  auditWords,
  callOutcomeTag,
  deletedText,
  deleteRefusalText,
  deleteWhatText,
  errorText,
  factSourceText,
  gateWords,
  memoryErrorText,
  memoryWords,
  modelErrorText,
  modelSpendWords,
  moneyText,
  monthName,
  monthsBack,
  percentUsed,
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
