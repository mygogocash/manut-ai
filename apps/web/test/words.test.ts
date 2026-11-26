import { describe, expect, it } from "vitest";
import { APPROVAL_KINDS, mayDecide } from "@manut/approval-core";
import {
  ApiError,
  SIGN_IN_MEMBERS,
  type AuditEntry,
  type DeletedShop,
  type Identity,
  type ModelCap,
  type ModelCounts,
  type ModelUsage,
  type People,
  type PilotGate,
  type Routine,
  type Shop,
  type Team,
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
  CONNECTIONS_MOVED_ON,
  connectionMemberName,
  connectionsErrorText,
  connectionsWords,
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
  nextRunText,
  noNextReasons,
  outpostTag,
  peopleChangedBy,
  peopleChangesOf,
  peopleErrorText,
  peopleWords,
  percentUsed,
  routineReasonText,
  routinesErrorText,
  routinesWords,
  routineTag,
  ROUTINES_MOVED_ON,
  runTag,
  runText,
  shopsWords,
  signInTag,
  spendLevel,
  subscriptionErrorText,
  teamTag,
  unfinishedText,
} from "../src/ops/words";
// The vault's own list of how an outpost may say a step failed, read as text for the reason apiAuditLog.ts gives.
import signInVaultSource from "../../api/src/sign-in-vault.ts?raw";
// The API's own sources for why a routine's run did not start or did not finish, read as text for the words the Routines page has for them.
import routinesSource from "../../api/src/routines.ts?raw";
import routineStoreSource from "../../api/src/routine-store.ts?raw";
import shopWaitsSource from "../../api/src/shop-waits.ts?raw";

/// The codes of the API's `STEP_FAILURES`, as its source writes them.
function stepFailures(): string[] {
  const start = signInVaultSource.indexOf("export const STEP_FAILURES = [");
  const end = signInVaultSource.indexOf("] as const;", start);
  if (start < 0 || end < 0) throw new Error("apps/api/src/sign-in-vault.ts no longer has STEP_FAILURES as a list: teach this test where it went");
  return [...signInVaultSource.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
}

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

  it("says what became of the shop's Google access, and only for a shop that had a Google connection", () => {
    expect(deletedText("Baan Mali", { ...RESULT, googleRevoked: 1, googleNotRevoked: 0 }, SAME_DAY)).toBe(
      "Deleted Baan Mali at 10:00. Removed 1 task with its replies, 1 LINE connection and the shop's messages and payments. Manut AI's access to the owner's Google account was ended at Google.",
    );
    // Google not answering never stops a deletion, so the words say what is left for the owner to do.
    expect(deletedText("Baan Mali", { ...RESULT, googleRevoked: 0, googleNotRevoked: 1 }, SAME_DAY)).toBe(
      "Deleted Baan Mali at 10:00. Removed 1 task with its replies, 1 LINE connection and the shop's messages and payments. Google could not be reached, so Manut AI's access to the owner's Google account may still stand: ask the owner to remove it in their Google account's settings.",
    );
    expect(deletedText("Baan Mali", RESULT, SAME_DAY)).not.toContain("Google");
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
    expect(auditActorText({ kind: "owner", id: "owner-phone-1" }, "Fon")).toBe("Fon (linked account owner-phone-1)");
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
    // Since the owner's own routes (slice 4) a linked owner can change the list too; without a linked account only an operator can.
    expect(peopleWords.intro("Fon", true)).toBe(
      "Who can use Manut AI for this shop. Fon can invite, cancel, remove and set cover from their own sign-in too, so a change may be theirs. Make a change here when Fon asks you to.");
    expect(peopleWords.intro("Fon", false)).toBe(
      "Who can use Manut AI for this shop. Fon has no account linked yet, so only an operator can change this list. Make a change here when Fon asks you to.");
    expect(peopleWords.intro("Fon", true)).not.toMatch(/cannot change/);
  });

  it("says which of the owner and an operator made each change to the list, from the audit log's own entries", () => {
    const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
      at: "2026-11-24T03:00:00.000Z", actor: { kind: "operator", email: "ops@manut.test" }, action: "invite.created", subject: {},
      outcome: "ok", ...overrides });
    // Only the changes an owner or an operator makes to who can use Manut AI, never a reply, a helper joining or a payment.
    const log = [
      entry({ action: "reply.proposed" }),
      entry({ action: "invite.created" }),
      entry({ action: "helper.joined", actor: { kind: "helper", id: "h1" } }),
      entry({ action: "invite.revoked", actor: { kind: "owner", id: "owner-fon" } }),
      entry({ action: "helper.removed", actor: { kind: "owner", id: "owner-session" } }),
      entry({ action: "away.set" }),
      entry({ action: "away.cleared", actor: { kind: "owner", id: "owner-fon" } }),
      entry({ action: "owner.linked" }),
      entry({ action: "owner.unlinked" }),
      entry({ action: "payment.recorded" }),
    ];
    const all = peopleChangesOf(log, 10);
    expect(all.shown.map((one) => one.action)).toEqual(["invite.created", "invite.revoked", "helper.removed", "away.set",
      "away.cleared", "owner.linked", "owner.unlinked"]);
    expect(all.more).toBe(false);
    const few = peopleChangesOf(log, 3);
    expect(few.shown.map((one) => one.action)).toEqual(["invite.created", "invite.revoked", "helper.removed"]);
    expect(few.more).toBe(true);
    expect(peopleChangesOf([], 10)).toEqual({ shown: [], more: false });

    expect(peopleChangedBy({ kind: "owner", id: "owner-fon" }, "Fon")).toEqual({ label: "By Fon", className: "tag" });
    expect(peopleChangedBy({ kind: "owner", id: "owner-session" }, "Fon")).toEqual({ label: "By Fon", className: "tag" });
    expect(peopleChangedBy({ kind: "owner" }, "Fon")).toEqual({ label: "By Fon", className: "tag" });
    expect(peopleChangedBy({ kind: "operator", email: "ops@manut.test" }, "Fon")).toEqual({ label: "By an operator", className: "tag" });
    expect(peopleChangedBy({ kind: "operator", email: null }, "Fon")).toEqual({ label: "By an operator", className: "tag" });
    // Anyone else is named by the sentence alone.
    expect(peopleChangedBy({ kind: "helper", id: "h1" }, "Fon")).toBeNull();
    expect(peopleChangedBy({ kind: "system" }, "Fon")).toBeNull();
  });

  it("words the list of who changed it, and what it says when there is nothing to show", () => {
    expect(peopleWords.changesTitle).toBe("Who changed this list");
    expect(peopleWords.changesNote).toBe("Newest first");
    expect(peopleWords.changesLabel("Baan Mali")).toBe("Changes to Baan Mali's list of people");
    expect(peopleWords.changesNone).toBe("No change to the list is recorded yet.");
    expect(peopleWords.changesNoneNewest(200)).toBe(
      "No change to the list in the newest 200 audit entries. The Audit page has older ones.");
    expect(peopleWords.changesMore(10)).toBe("Showing the newest 10. The Audit page has the rest.");
    expect(peopleWords.changesUnavailable).toBe(
      "The API could not read the audit log, so who changed the list is not shown. Press Refresh to try again.");
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

  it("says the owner removing a sign-in, changing where it is used, and the operator choosing who may use one", () => {
    const fon = { kind: "owner" as const, id: "owner-1" };
    expect(said({ actor: fon, action: "signin.removed", subject: { signInId: "s1" } }))
      .toBe("Fon (linked account owner-1) removed a site sign-in from the vault.");
    // A change that could send the password somewhere new is made only with the password typed again, and the words say so.
    expect(said({ actor: fon, action: "signin.changed", subject: { signInId: "s1" } }))
      .toBe("Fon (linked account owner-1) changed a site sign-in's account or addresses, and typed its password again.");
    expect(said({ actor: { kind: "owner", id: "owner-session" }, action: "signin.narrowed", subject: { signInId: "s1" } }))
      .toBe("Fon (the shop's own session) took addresses away from a site sign-in, keeping its password.");
    expect(said({ actor: op, action: "signin.members_changed", subject: { signInId: "s1" } }))
      .toBe("ops@manut.test changed who may use a site sign-in.");
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
    // How an outpost may say a write step went, in words too.
    expect(auditReasonText("submit_refused")).toBe("The site refused what was submitted and kept the form.");
    expect(auditReasonText("not_run")).toBe("The outpost did not run the step, so nothing was submitted.");
    expect(auditReasonText("navigation_refused")).toBe("The page or one of its frames tried to go to a site the step may not use "
      + "before anything was pressed, so the outpost stopped and nothing was submitted.");
    // The reasons that already had words keep them.
    expect(auditReasonText("attempt_ended")).toBe("Its attempt had already ended.");
    expect(auditReasonText("new_reason")).toBe("Reason: new_reason.");
  });

  it("says what the step channel and an outpost's removal or new credential did, never by raw name", () => {
    expect(said({ actor: op, action: "outpost.removed", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test removed an outpost.");
    expect(said({ actor: op, action: "outpost.credential_rotated", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test gave an outpost a new credential.");
    expect(said({ actor: op, action: "vault.resealed", subject: {} }))
      .toBe("ops@manut.test sealed the shop's vault again under a new key.");
    expect(said({ actor: worker, action: "browser_step.queued", subject: { stepId: "st1", outpostId: "o1" } }))
      .toBe("Worker attempt 6f9d1f0e asked an outpost to run a browser step.");
    expect(said({ actor: outpost, action: "browser_step.fetched", subject: { stepId: "st1", outpostId: "o1" } }))
      .toBe("Outpost b4c8d1e2 picked up a browser step.");
    expect(said({ actor: outpost, action: "browser_step.reported", subject: { stepId: "st1", outpostId: "o1" },
      outcome: "done" })).toBe("Outpost b4c8d1e2 reported how a browser step went.");
    expect(auditSubjectText({ outpostId: "o1", stepId: "st1", attemptId: "a1", taskId: "t1" }))
      .toBe("task t1 · attempt a1 · outpost o1 · browser step st1");
    for (const [reason, words] of [
      ["step_kind_not_allowed", "That kind of step cannot be asked for this way. A form is submitted only as an approved write."],
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

  it("has words of its own for every code an outpost may report, read from the API's list", () => {
    const codes = stepFailures();
    expect(codes).toContain("navigation_refused");
    expect(codes).toContain("sign_in_interrupted");
    expect(codes.length).toBeGreaterThanOrEqual(11);
    expect(auditReasonText("sign_in_interrupted")).toBe("The site asked for more than the saved sign-in, such as a check "
      + "that you are a person or a code, so the outpost stopped there.");
    for (const code of codes) {
      const words = auditReasonText(code);
      expect(words, code).not.toMatch(/^Reason:/);
      expect(words, code).not.toContain(code);
      expect(words.endsWith("."), code).toBe(true);
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
      .toBe("Fon (linked account owner-1) signed in to the shop on a device.");
    expect(said({ actor: owner, action: "owner.session_ended", subject: { ownerAccountId: "owner-1" } }))
      .toBe("Fon (linked account owner-1) signed out of the shop on a device.");
    expect(said({ actor: helper, action: "helper.session_ended", subject: { helperId: "helper-1" } }))
      .toBe("Helper helper-1 signed out on a device.");
    expect(said({ actor: helper, action: "helper.session_ended", subject: { helperId: "helper-1" } }, { "helper-1": "Mint" }))
      .toBe("Mint signed out on a device.");
  });

  it("says how a shop its owner made came to be, by the owner's linked account, never by an operator", () => {
    const made = { subject: { ownerAccountId: "owner-1" } };
    expect(said({ actor: owner, action: "shop.created" })).toBe("Fon (linked account owner-1) created the shop.");
    expect(said({ actor: owner, action: "shop.made_by_owner", ...made }))
      .toBe("Fon (linked account owner-1) made the shop themselves in the app, with no operator.");
    expect(said({ actor: owner, action: "owner.linked", ...made }))
      .toBe("Fon (linked account owner-1) became the shop's owner as they made it.");
  });

  it("has words for each of them: none is shown by its raw name or as an action it does not know", () => {
    for (const [action, actor] of [["owner.linked", op], ["owner.linked", owner], ["shop.made_by_owner", owner],
      ["owner.unlinked", op], ["owner.session_opened", owner],
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

// Since the owner can change the shop's people, memory, consent and routines from their own session (docs/several-shops.md,
// slice 4), the log names the owner three ways: the linked account's id (an owner session), `owner-session` (the shop's own
// signed-in session) and no id at all (a signed link). The page says which, in words, never the raw `owner-session`.
describe("the audit log says who acted: the operator, the owner's linked account, the shop's own session, a helper or an outpost", () => {
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-24T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok", ...overrides });
  const said = (overrides: Partial<AuditEntry>, names: Record<string, string> = {}) =>
    auditSentence(entry(overrides), "Fon", names);

  it("names the owner's linked account by its id, the shop's own session in words, and a link by the owner alone", () => {
    expect(auditActorText({ kind: "owner", id: "owner-fon" }, "Fon")).toBe("Fon (linked account owner-fon)");
    expect(auditActorText({ kind: "owner", id: "owner-session" }, "Fon")).toBe("Fon (the shop's own session)");
    expect(auditActorText({ kind: "owner" }, "Fon")).toBe("Fon");
    // `owner-link` is the name the owner's link gives in a decision's record; it is the link, not an account.
    expect(auditActorText({ kind: "owner", id: "owner-link" }, "Fon")).toBe("Fon");
    // An id that merely starts like the shop's own session is an account's.
    expect(auditActorText({ kind: "owner", id: "owner-session-2" }, "Fon")).toBe("Fon (linked account owner-session-2)");
  });

  it("says so in the sentence of each change the owner can now make from their own session", () => {
    const account = { kind: "owner" as const, id: "owner-fon" };
    const own = { kind: "owner" as const, id: "owner-session" };
    const names = { "inv-1": "Beam", "helper-1": "Mint" };
    expect(said({ actor: account, action: "invite.created", subject: { inviteId: "inv-1" } }, names))
      .toBe("Fon (linked account owner-fon) invited Beam.");
    expect(said({ actor: own, action: "invite.revoked", subject: { inviteId: "inv-1" } }, names))
      .toBe("Fon (the shop's own session) cancelled Beam's invite.");
    expect(said({ actor: account, action: "helper.removed", subject: { helperId: "helper-1" } }, names))
      .toBe("Fon (linked account owner-fon) removed Mint.");
    expect(said({ actor: own, action: "away.set", subject: { helperId: "helper-1" } }, names))
      .toBe("Fon (the shop's own session) set Mint to cover messages while Fon is away.");
    expect(said({ actor: account, action: "away.cleared", subject: { helperId: "helper-1" } }, names))
      .toBe("Fon (linked account owner-fon) ended Mint's cover.");
    expect(said({ actor: account, action: "memory.confirmed", subject: { factId: "f1" } }))
      .toBe("Fon (linked account owner-fon) confirmed a fact as true.");
    expect(said({ actor: own, action: "consent.withdrawn" }))
      .toBe("Fon (the shop's own session) withdrew permission to send for the shop.");
    expect(said({ actor: account, action: "approval.decided", outcome: "approved" }))
      .toBe("Fon (linked account owner-fon) decided an approval request.");
  });

  it("still names an operator by their Access identity, a helper by the owner's name for them, an outpost by its id", () => {
    expect(said({ actor: { kind: "operator", email: "ops@manut.test" }, action: "away.cleared", subject: { helperId: "h" } }))
      .toBe("ops@manut.test ended the cover.");
    expect(said({ actor: { kind: "operator", email: null }, action: "away.cleared", subject: { helperId: "h" } }))
      .toBe("An operator (no Access identity) ended the cover.");
    expect(said({ actor: { kind: "helper", id: "helper-1" }, action: "helper.session_ended", subject: { helperId: "helper-1" } },
      { "helper-1": "Mint" })).toBe("Mint signed out on a device.");
    expect(said({ actor: { kind: "outpost", id: "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b" }, action: "browser_step.fetched" }))
      .toBe("Outpost b4c8d1e2 picked up a browser step.");
  });
});

// A browser write (docs/pilot-api.md, "Submitting through a browser") adds no audit actions of its own: it is told by the
// entries the job flow already writes, and by the ids they carry. A write's ask names a sign-in, and its steps name the request
// it carries; a sign-in's steps name a grant instead. The words read those ids to say which, and what each outcome means.
describe("the audit log's words for a browser write, from the ask to how it settled", () => {
  const worker = { kind: "worker" as const, attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" };
  const outpost = { kind: "outpost" as const, id: "b4c8d1e2-5f60-4a71-8b92-0c3d4e5f6a7b" };
  const op = { kind: "operator" as const, email: "ops@manut.test" };
  const write = { taskId: "t1", attemptId: "a1", signInId: "s1", requestId: "req_1", actionId: "req_1" };
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-24T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok", ...overrides });
  const said = (overrides: Partial<AuditEntry>) => auditSentence(entry(overrides), "Fon", {});

  it("says a worker asked for approval to submit a form on a site, and tells that from any other approval request", () => {
    expect(said({ actor: worker, action: "approval.requested", subject: write }))
      .toBe("Worker attempt 6f9d1f0e asked for approval to submit a form on a site.");
    // The same words whether the ask opened a request, was refused, or was only kept as a draft.
    expect(said({ actor: worker, action: "approval.requested", subject: { taskId: "t1", attemptId: "a1", signInId: "s1" },
      outcome: "refused", reason: "not_my_job" })).toBe("Worker attempt 6f9d1f0e asked for approval to submit a form on a site.");
    expect(said({ actor: worker, action: "approval.requested", subject: { taskId: "t1", attemptId: "a1", signInId: "s1" },
      outcome: "skipped", reason: "draft_only" })).toBe("Worker attempt 6f9d1f0e asked for approval to submit a form on a site.");
    // An approval request with no sign-in is any other action's, and keeps its old words.
    expect(said({ actor: worker, action: "approval.requested",
      subject: { taskId: "t1", attemptId: "a1", requestId: "req_2", actionId: "req_2" } }))
      .toBe("Worker attempt 6f9d1f0e asked for approval of an action.");
  });

  it("tells a write's steps from a sign-in's and a read's, by the request, the grant or neither", () => {
    const step = { stepId: "st1", outpostId: "o1" };
    const forWrite = { ...write, ...step };
    const forSignIn = { stepId: "st2", outpostId: "o1", taskId: "t1", attemptId: "a1", signInId: "s1", grantId: "g1" };
    const forRead = { stepId: "st3", outpostId: "o1", taskId: "t1", attemptId: "a1" };
    expect(said({ actor: worker, action: "browser_step.queued", subject: forWrite }))
      .toBe("Worker attempt 6f9d1f0e asked an outpost to submit the approved form.");
    expect(said({ actor: worker, action: "browser_step.queued", subject: forSignIn }))
      .toBe("Worker attempt 6f9d1f0e asked an outpost to sign in to a site.");
    expect(said({ actor: worker, action: "browser_step.queued", subject: forRead }))
      .toBe("Worker attempt 6f9d1f0e asked an outpost to run a browser step.");
    expect(said({ actor: outpost, action: "browser_step.fetched", subject: forWrite }))
      .toBe("Outpost b4c8d1e2 picked up the approved form to submit.");
    expect(said({ actor: outpost, action: "browser_step.fetched", subject: forSignIn }))
      .toBe("Outpost b4c8d1e2 picked up a sign-in step.");
    expect(said({ actor: outpost, action: "browser_step.fetched", subject: forRead }))
      .toBe("Outpost b4c8d1e2 picked up a browser step.");
    expect(said({ actor: outpost, action: "browser_step.reported", subject: forWrite, outcome: "done" }))
      .toBe("Outpost b4c8d1e2 reported how submitting the form went.");
    expect(said({ actor: outpost, action: "browser_step.reported", subject: forSignIn, outcome: "done" }))
      .toBe("Outpost b4c8d1e2 reported how signing in went.");
    expect(said({ actor: outpost, action: "browser_step.reported", subject: forRead, outcome: "done" }))
      .toBe("Outpost b4c8d1e2 reported how a browser step went.");
    // A report whose step the vault did not find names the outpost alone, so it can only be said in general.
    expect(said({ actor: outpost, action: "browser_step.reported", subject: { outpostId: "o1" }, outcome: "refused",
      reason: "step_not_found" })).toBe("Outpost b4c8d1e2 reported how a browser step went.");
  });

  it("says an outpost that was refused a step was not handed it, rather than that it picked it up", () => {
    const refused = (subject: Record<string, string>) =>
      said({ actor: outpost, action: "browser_step.fetched", subject, outcome: "refused", reason: "payload_changed" });
    expect(refused({ ...write, stepId: "st1", outpostId: "o1" })).toBe("Outpost b4c8d1e2 was not handed the approved form to submit.");
    expect(refused({ stepId: "st2", outpostId: "o1", signInId: "s1", grantId: "g1" }))
      .toBe("Outpost b4c8d1e2 was not handed a sign-in step.");
    expect(refused({ stepId: "st3", outpostId: "o1" })).toBe("Outpost b4c8d1e2 was not handed a browser step.");
  });

  it("names an outpost the owner registered from their Mac, and an operator's as an outpost only", () => {
    expect(said({ actor: { kind: "owner", id: "owner-fon" }, action: "outpost.registered", subject: { outpostId: "o1" } }))
      .toBe("Fon (linked account owner-fon) registered their Mac as an outpost.");
    expect(said({ actor: { kind: "owner", id: "owner-session" }, action: "outpost.registered", subject: { outpostId: "o1" } }))
      .toBe("Fon (the shop's own session) registered their Mac as an outpost.");
    expect(said({ actor: op, action: "outpost.registered", subject: { outpostId: "o1" } }))
      .toBe("ops@manut.test registered an outpost.");
  });

  it("has plain words for each reason a write can stop at, none shown as its code", () => {
    const codes = ["not_my_job", "not_connected", "kind_mismatch", "unknown_member", "unknown_capability", "unknown_kind",
      "unknown_action", "invalid_write", "draft_only", "invalid_request", "request_not_found", "not_approved", "request_changed",
      "already_begun", "action_expired", "request_queued", "already_settled", "dispatch_in_flight", "action_unknown",
      "payload_changed", "grant_changed", "task_settled"];
    for (const code of codes) {
      const words = auditReasonText(code);
      expect(words, code).not.toContain(code);
      expect(words, code).not.toMatch(/^Reason:/);
      expect(words.endsWith("."), code).toBe(true);
    }
    expect(auditReasonText("draft_only")).toBe("The job is in practice mode, so the form was kept as a draft and nobody was asked to approve it.");
    expect(auditReasonText("not_approved")).toBe("The write had not been approved.");
    expect(auditReasonText("request_changed")).toBe("The request had changed since it was approved.");
    expect(auditReasonText("payload_changed"))
      .toBe("What was approved no longer matched what would be submitted, so nothing was submitted.");
    expect(auditReasonText("action_expired")).toBe("The approved write had run out of time.");
    // Words the Drafts page already had for its own jobs stay its own.
    expect(jobReasonText("not_my_job")).toBe("It was not this member's job, and it could not be passed on.");
    expect(jobReasonText("not_connected")).toBe("The shop's LINE connection to that customer is gone.");
  });

  it("says what a write's report means for the form: not submitted, not known, or settled all the same", () => {
    const report = (outcome: string, reason: string) => entry({ actor: outpost, action: "browser_step.reported",
      subject: { ...write, stepId: "st1", outpostId: "o1" }, outcome, reason });
    const read = (reason: string) => auditReasonText(reason, report("failed", reason));
    // The codes that are about writes keep their words, which already say that nothing was submitted.
    expect(read("submit_refused")).toBe("The site refused what was submitted and kept the form.");
    expect(read("not_run")).toBe("The outpost did not run the step, so nothing was submitted.");
    expect(read("navigation_refused")).toBe(auditReasonText("navigation_refused"));
    expect(read("navigation_refused")).toMatch(/nothing was submitted\.$/);
    // Every other code an outpost reports before it types anything says so for a form.
    expect(read("page_unavailable")).toBe("The page did not load, so nothing was submitted.");
    expect(read("selector_not_found")).toBe("A field or the form was not on the page, so nothing was submitted.");
    expect(read("sign_in_refused")).toBe("The site refused the saved password, so nothing was submitted.");
    expect(read("grant_refused")).toBe("There was no sign-in to type, so nothing was submitted.");
    // After these nobody can say the site did not take it.
    expect(read("timed_out")).toBe("The step took too long. It is not known whether the site took the form.");
    expect(read("browser_error")).toBe("The browser stopped part way. It is not known whether the site took the form.");
    expect(read("origin_not_allowed"))
      .toBe("The page or one of its frames went off the page's site. It is not known whether the site took the form.");
    // A report the attempt could not take back leaves the write as the outpost said it went.
    for (const reason of ["attempt_ended", "consent_required", "feature_disabled", "task_unavailable"]) {
      expect(auditReasonText(reason, report("refused", reason)), reason)
        .toBe(`${auditReasonText(reason)} The form itself stands as the outpost reported it.`);
    }
    // A report the vault itself refused settled nothing, so it says nothing more than the reason.
    expect(auditReasonText("step_expired", report("refused", "step_expired"))).toBe(auditReasonText("step_expired"));
    // Other entries, and a read step's report, read the reason as before.
    expect(auditReasonText("timed_out", entry({ actor: outpost, action: "browser_step.reported",
      subject: { stepId: "st3", outpostId: "o1" }, outcome: "failed", reason: "timed_out" }))).toBe("The step took too long.");
    expect(auditReasonText("timed_out")).toBe("The step took too long.");
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
    expect(Object.values(shopsWords.open)).toEqual(["Messages", "Drafts", "Audit", "Memory", "People", "Model spend", "Connections", "Routines"]);
  });

  it("says why nothing is shown for the trial, payment and activity when the gate could not be read", () => {
    expect(shopsWords.gateFailed).toBe(
      "The pilot gate could not be read, so trials, payments and activity are not shown. Try again.");
    expect(shopsWords.unreadable).toBe("Could not be read");
    expect(shopsWords.columns.active(14)).toBe("Active on day 14");
    expect(shopsWords.columns.activeUnknown).toBe("Active");
  });
});

// The owner's own Connections (docs/browser-control.md, "The owner's Connections"): from the desktop, the owner types a new
// password into the vault, renames an outpost or removes one. The log names the owner and the record by id only.
describe("the audit log's words for the owner's Connections", () => {
  const owner = { kind: "owner" as const, id: "owner-1" };
  const shopSession = { kind: "owner" as const, id: "owner-session" };
  const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({ id: "aud-mi8x2k4c0-000-0a1b2c3d",
    at: "2026-11-24T03:00:00.000Z", actor: { kind: "system" }, action: "shop.created", subject: {}, outcome: "ok", ...overrides });
  const said = (overrides: Partial<AuditEntry>) => auditSentence(entry(overrides), "Fon");

  it("says what the owner's password, rename and removal did, by the owner, and never by a raw name", () => {
    expect(said({ actor: owner, action: "signin.password_replaced", subject: { signInId: "s1" } }))
      .toBe("Fon (linked account owner-1) replaced a site sign-in's password.");
    expect(said({ actor: owner, action: "outpost.renamed", subject: { outpostId: "o1" } }))
      .toBe("Fon (linked account owner-1) renamed an outpost.");
    expect(said({ actor: shopSession, action: "outpost.removed", subject: { outpostId: "o1" } }))
      .toBe("Fon (the shop's own session) removed an outpost.");
    const sentence = said({ actor: owner, action: "outpost.renamed" });
    expect(sentence).not.toContain("outpost.renamed");
    expect(sentence).not.toMatch(/\bdid\b/);
  });

  it("says what the owner's added sign-in and their choice of who may use one did, by the owner", () => {
    expect(said({ actor: owner, action: "signin.created", subject: { signInId: "s1" } }))
      .toBe("Fon (linked account owner-1) added a site sign-in to the vault.");
    expect(said({ actor: owner, action: "signin.members_changed", subject: { signInId: "s1" } }))
      .toBe("Fon (linked account owner-1) changed who may use a site sign-in.");
    expect(said({ actor: shopSession, action: "signin.members_changed", subject: { signInId: "s1" } }))
      .toBe("Fon (the shop's own session) changed who may use a site sign-in.");
    expect(said({ actor: owner, action: "signin.members_changed" })).not.toContain("signin.members_changed");
  });
});

// The Connections page's words: one shop's site sign-ins and outposts, as an operator reads them. A sentence that holds a name or a
// time is a function, a time is worded against the day it is read, and a state, kind or member the console does not know yet is
// shown as the API sent it.
describe("the Connections page's words", () => {
  const W = connectionsWords;
  // 11:00 on 23 November in Bangkok, and the same time a day later.
  const TODAY = SAME_DAY;
  const TOMORROW = NEXT_DAY;
  const EARLIER_TODAY = "2026-11-23T01:00:00.000Z"; // 08:00 in Bangkok

  it("names the four members who may use a sign-in, and shows any other as it was sent, whatever it is called", () => {
    expect(SIGN_IN_MEMBERS.map(connectionMemberName)).toEqual(["Nam", "Pim", "Ton", "Kit"]);
    expect(connectionMemberName("lin")).toBe("lin");
    expect(connectionMemberName("constructor")).toBe("constructor");
    expect(connectionMemberName("__proto__")).toBe("__proto__");
    // The Drafts page's `memberName` knows only the three who run as workers, and still shows Kit as it was sent.
    expect(memberName("kit")).toBe("kit");
  });

  it("tags a sign-in as working or broken, and an outpost as online or asleep, and shows any other state as it was sent", () => {
    expect(signInTag("working")).toEqual({ label: "Working", className: "tag ok" });
    expect(signInTag("broken")).toEqual({ label: "Broken", className: "tag err" });
    expect(signInTag("retired")).toEqual({ label: "retired", className: "tag" });
    expect(outpostTag("online")).toEqual({ label: "Online", className: "tag ok" });
    expect(outpostTag("asleep")).toEqual({ label: "Asleep", className: "tag warn" });
    expect(outpostTag("dozing")).toEqual({ label: "dozing", className: "tag" });
  });

  it("counts the sign-ins and says how many are broken, and counts the outposts and says how many are online", () => {
    expect(W.signInsCount(0, 0)).toBe("0 sign-ins");
    expect(W.signInsCount(1, 0)).toBe("1 sign-in");
    expect(W.signInsCount(1, 1)).toBe("1 sign-in, 1 broken");
    expect(W.signInsCount(3, 2)).toBe("3 sign-ins, 2 broken");
    expect(W.outpostsCount(0, 0)).toBe("0 outposts");
    expect(W.outpostsCount(1, 0)).toBe("1 outpost, 0 online");
    expect(W.outpostsCount(2, 1)).toBe("2 outposts, 1 online");
  });

  it("words a time as 'at 08:00' on the day it is read, and as 'on 23 November at 08:00' on any other", () => {
    expect(W.passwordSet(EARLIER_TODAY, TODAY)).toBe("Password set at 08:00.");
    expect(W.passwordSet(EARLIER_TODAY, TOMORROW)).toBe("Password set on 23 November at 08:00.");
    expect(W.lastUsed(EARLIER_TODAY, "nam", TODAY)).toBe("Last used by Nam at 08:00.");
    expect(W.lastUsed(EARLIER_TODAY, "lin", TOMORROW)).toBe("Last used by lin on 23 November at 08:00.");
    expect(W.lastUsed(EARLIER_TODAY, null, TODAY)).toBe("Last used at 08:00.");
    expect(W.lastUsed(null, null, TODAY)).toBe("Never used.");
    expect(W.lastUsed(null, "nam", TODAY)).toBe("Never used.");
    expect(W.heartbeat(EARLIER_TODAY, TODAY)).toBe("Last heartbeat at 08:00.");
    expect(W.heartbeat(EARLIER_TODAY, TOMORROW)).toBe("Last heartbeat on 23 November at 08:00.");
    expect(W.heartbeat(null, TODAY)).toBe("It has not sent a heartbeat yet.");
    expect(W.registered(EARLIER_TODAY, TOMORROW)).toBe("Registered on 23 November at 08:00.");
    // A time that is not one is left out rather than shown wrong.
    expect(W.passwordSet("not a time", TODAY)).toBe("Password set.");
  });

  it("says a broken sign-in is broken by whom and when, and what mends it, leaving out what the API did not say", () => {
    const mend = "It works again once the owner gives a new password in their own app.";
    expect(W.brokenText("nam", EARLIER_TODAY, TODAY)).toBe(`The site refused the saved password at 08:00, as Nam reported. ${mend}`);
    expect(W.brokenText("ton", EARLIER_TODAY, TOMORROW))
      .toBe(`The site refused the saved password on 23 November at 08:00, as Ton reported. ${mend}`);
    expect(W.brokenText(null, EARLIER_TODAY, TODAY)).toBe(`The site refused the saved password at 08:00. ${mend}`);
    expect(W.brokenText("nam", null, TODAY)).toBe(`The site refused the saved password, as Nam reported. ${mend}`);
    expect(W.brokenText(null, null, TODAY)).toBe(`The site refused the saved password. ${mend}`);
  });

  it("lists addresses and members as people say a list, without the serial comma", () => {
    expect(W.addresses(["https://a.example"])).toBe("Signs in only at https://a.example.");
    expect(W.addresses(["https://a.example", "https://b.example", "https://c.example"]))
      .toBe("Signs in only at https://a.example, https://b.example and https://c.example.");
    expect(W.members(["nam"])).toBe("May be used by Nam.");
    expect(W.members(["nam", "pim", "ton", "kit"])).toBe("May be used by Nam, Pim, Ton and Kit.");
    expect(W.account("baanmali")).toBe("Account baanmali");
    expect(W.kindOf("this_mac")).toBe("A Mac with the app");
    expect(W.kindOf("cloud")).toBe("A cloud outpost");
    expect(W.kindOf("edge")).toBe("edge");
  });

  it("says exactly what saving who may use a sign-in would do, before it is sent", () => {
    const effect = (before: string[], after: string[]) => W.whoEffect("Shopee Seller Centre", before, after);
    expect(effect(["nam", "pim"], ["nam", "pim"])).toBe("That is who may use it now.");
    // The same members in another order are the same members.
    expect(effect(["nam", "pim"], ["pim", "nam"])).toBe("That is who may use it now.");
    expect(effect(["nam"], [])).toBe("Choose at least one member. To stop everyone using it, remove the sign-in.");
    expect(effect([], [])).toBe("Choose at least one member. To stop everyone using it, remove the sign-in.");
    expect(effect(["nam"], ["nam", "ton"])).toBe("Ton may use Shopee Seller Centre from now on.");
    expect(effect(["nam", "pim"], ["nam"]))
      .toBe("Pim can no longer use it, and anything they asked for and have not used yet is refused.");
    expect(effect(["nam", "pim"], ["ton", "kit"])).toBe(
      "Ton and Kit may use Shopee Seller Centre from now on. Nam and Pim can no longer use it, and anything they asked for and have not used yet is refused.");
    expect(effect(["nam", "lin"], ["nam"])).toBe("lin can no longer use it, and anything they asked for and have not used yet is refused.");
    expect(W.whoYes(["nam"])).toBe("Let Nam use it");
    expect(W.whoYes(["nam", "ton", "kit"])).toBe("Let Nam, Ton and Kit use it");
    expect(W.whoSaved("Shopee Seller Centre", ["ton", "nam"])).toBe("Saved. Ton and Nam may use Shopee Seller Centre from now on.");
  });

  it("names, in each question, what will be removed or changed, and that a removed sign-in cannot be got back by the console", () => {
    expect(W.removeSignInTitle("Shopee Seller Centre", "baanmali")).toBe("Remove the sign-in to Shopee Seller Centre as baanmali?");
    expect(W.removeSignInEffect("Shopee Seller Centre")).toBe("The team can no longer sign in to Shopee Seller Centre. Its saved password is deleted from the vault, and a sign-in already asked for and not yet used is refused.");
    expect(W.removeSignInNote).toBe("This cannot be undone. To use it again, the owner adds it again with its password, in their own app.");
    expect(W.credentialTitle("Fon's MacBook")).toBe("Give Fon's MacBook a new credential?");
    expect(W.credentialEffect("Fon's MacBook")).toBe("The old credential stops working at once, and Fon's MacBook is asleep until whoever runs it starts it with the new one.");
    expect(W.credentialNote).toBe("The new credential is shown once. Nothing keeps it, so copy it before you leave this page.");
    expect(W.removeOutpostTitle("Fon's MacBook")).toBe("Remove Fon's MacBook?");
    expect(W.removeOutpostEffect("Fon's MacBook")).toBe("Fon's MacBook stops working for this shop at once: its credential no longer works, and any step waiting for it is refused.");
    // What is said afterwards never holds the credential, whatever the name.
    expect(W.credentialMade("Fon's MacBook")).toBe("A new credential was made for Fon's MacBook. The old one no longer works.");
  });

  it("says what removing an outpost refused, only when it refused anything, in the singular and the plural", () => {
    const said = (stepsRefused: number, grantsRefused: number) => W.outpostRemoved("Fon's MacBook", "Baan Mali", { stepsRefused, grantsRefused });
    expect(said(0, 0)).toBe("Removed. Fon's MacBook no longer works for Baan Mali.");
    expect(said(1, 0)).toBe("Removed. Fon's MacBook no longer works for Baan Mali. 1 step waiting for it was refused.");
    expect(said(3, 0)).toBe("Removed. Fon's MacBook no longer works for Baan Mali. 3 steps waiting for it were refused.");
    expect(said(0, 1)).toBe("Removed. Fon's MacBook no longer works for Baan Mali. 1 sign-in permission it held, not yet used, was cancelled.");
    expect(said(2, 2)).toBe("Removed. Fon's MacBook no longer works for Baan Mali. 2 steps waiting for it were refused. 2 sign-in permissions it held, not yet used, were cancelled.");
  });

  it("puts the API's own refusals in the page's words, and the console's usual words for the rest", () => {
    const text = (error: unknown, what: "sign-ins" | "outposts" | "change") => connectionsErrorText(error, what);
    // A vault that did not answer: nothing is read, or a change may or may not have been made.
    expect(text(new ApiError(503, "vault_unavailable"), "sign-ins")).toBe(W.signInsUnavailable);
    expect(text(new ApiError(503, "vault_unavailable"), "outposts")).toBe(W.outpostsUnavailable);
    expect(text(new ApiError(503, "vault_unavailable"), "change")).toBe(W.saveUnavailable);
    expect(W.signInsUnavailable).toBe("The API could not read this shop's vault, so its sign-ins are not shown. Try again.");
    expect(W.saveUnavailable).toBe("The API could not reach this shop's vault, so nothing may have changed. Press Refresh to check, then try again.");
    expect(text(new ApiError(404, "sign_in_not_found"), "change")).toBe("That sign-in is already gone. The list was refreshed.");
    expect(text(new ApiError(404, "outpost_not_found"), "change")).toBe("That outpost is already gone. The list was refreshed.");
    expect(text(new ApiError(400, "invalid_members"), "change")).toBe("Choose who may use it: one or more of Nam, Pim, Ton and Kit.");
    // The rest is the console's own: a refused key, an API out of reach, a code it has no words for, and something that is no error.
    expect(text(new ApiError(403, "forbidden"), "change")).toBe(errorText(new ApiError(403, "forbidden")));
    expect(text(new ApiError(401, "vault_unavailable"), "change")).toBe(errorText(new ApiError(401, "vault_unavailable")));
    expect(text(new ApiError(0, "network"), "sign-ins")).toBe("Could not reach the API. Check the connection and try again.");
    expect(text(new ApiError(400, "tenant_required"), "outposts")).toBe("The API did not accept this (tenant_required).");
    expect(text(new ApiError(500, "boom"), "change")).toBe("The API answered with an error (boom).");
    expect(text(new Error("x"), "change")).toBe("Something unexpected went wrong. Try again.");
  });

  it("treats exactly the two refusals that say a record is gone as the list having moved on", () => {
    expect([...CONNECTIONS_MOVED_ON].sort()).toEqual(["outpost_not_found", "sign_in_not_found"]);
  });
});


// The Routines page's words (docs/pilot-api.md, "Routines"): the team, each routine's timing and next run, and how its last run ended.
describe("the Routines page's words", () => {
  const W = routinesWords;
  // 10:00 on Monday 23 November in Bangkok.
  const NOW = Date.parse("2026-11-23T03:00:00Z");
  const TEAM: Team = { paused: false, since: null, members: ["nam", "pim", "ton"] };
  const routine = (overrides: Partial<Routine> = {}): Routine => ({
    id: "rt-1", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok", asksFirst: false,
    member: "ton", when: "Every day at 08:00", paused: false, next: "2026-11-24T01:00:00.000Z", createdAt: "2026-11-10T03:00:00.000Z",
    lastRun: null, ...overrides,
  });

  it("names the page and says a routine only drafts, and sends an empty shop to the form that makes one, not to the route", () => {
    expect(W.nav).toBe("Routines");
    expect(W.title).toBe("Routines");
    expect(W.intro).toContain("only makes a draft for the owner to read");
    expect(W.intro).toContain("Bangkok time");
    expect(W.routinesEmpty).toBe("No routines yet. A shop made from a template starts with the template's routines, each paused. Make one with the form below.");
    // The page makes routines now: nothing on it says it cannot, or sends an operator to curl.
    expect(W).not.toHaveProperty("makeNote");
    for (const words of Object.values(W)) if (typeof words === "string") expect(words).not.toContain("POST /v1/admin/routines");
  });

  it("says since when everyone is paused, today with the time and another day with the date, and leaves out a time that is not one", () => {
    expect(W.teamPaused("2026-11-23T01:30:00.000Z", NOW)).toBe("Everyone is paused since 08:30 today.");
    expect(W.teamPaused("2026-11-21T10:15:00.000Z", NOW)).toBe("Everyone is paused since 21 November at 17:15.");
    expect(W.teamPaused(null, NOW)).toBe("Everyone is paused.");
    expect(W.teamPaused("recently", NOW)).toBe("Everyone is paused.");
    expect(W.teamOn).toBe("Everyone is on.");
  });

  it("says who is on, and who is off and why that matters, for every size of team", () => {
    expect(W.membersOn(["nam", "pim", "ton"])).toBe("Nam, Pim and Ton are on.");
    expect(W.membersOn(["nam", "ton"])).toBe("Nam and Ton are on. Pim is off, because the shop's template turned on fewer members, so a routine that is their job does not run.");
    expect(W.membersOn(["ton"])).toBe("Ton is on. Nam and Pim are off, because the shop's template turned on fewer members, so a routine that is their job does not run.");
    expect(W.membersOn([])).toBe("Nobody is on. Nam, Pim and Ton are off, because the shop's template turned on fewer members, so a routine that is their job does not run.");
    expect(W.membersOn(["nam", "kit"])).toBe("Nam and kit are on. Pim and Ton are off, because the shop's template turned on fewer members, so a routine that is their job does not run.");
  });

  it("says a routine's trigger in the API's words, and the zone only when it is not the shop's", () => {
    expect(W.when({ when: "Every day at 08:00", timeZone: "Asia/Bangkok" })).toBe("Every day at 08:00");
    expect(W.when({ when: "Every day at 08:00", timeZone: "Asia/Tokyo" })).toBe("Every day at 08:00 (Asia/Tokyo)");
    expect(W.when({ when: "", timeZone: "Asia/Bangkok" })).toBe("Its timing could not be read.");
  });

  it("says whether a routine asks the owner first, and why one that does not need to", () => {
    expect(W.asksFirst(true)).toBe("Asks the owner first.");
    expect(W.asksFirst(false)).toBe("Does not ask first: it only makes a draft for the owner to read.");
    expect(W.fromTemplate("Handmade and gifts")).toBe("Made from the Handmade and gifts template.");
    expect(W.jobOf("pim")).toBe("Pim's job.");
    expect(W.jobOf("kit")).toBe("kit's job.");
  });

  it("says when the last run was meant for, today or on another day, and tolerates a time that is not one", () => {
    expect(W.lastRun("2026-11-23T01:00:00.000Z", NOW)).toBe("Last run was meant for 08:00 today.");
    expect(W.lastRun("2026-11-22T05:00:00.000Z", NOW)).toBe("Last run was meant for 22 November at 12:00.");
    expect(W.lastRun("yesterday", NOW)).toBe("Last run.");
    expect(W.neverRan).toBe("Has not run yet.");
  });

  it("counts routines and the paused among them", () => {
    expect(W.routinesCount(0, 0)).toBe("0 routines");
    expect(W.routinesCount(1, 0)).toBe("1 routine");
    expect(W.routinesCount(6, 1)).toBe("6 routines, 1 paused");
    expect(W.routinesCount(2, 2)).toBe("2 routines, 2 paused");
  });

  it("says why a routine has no next run, every reason that holds, in the order the API decides them", () => {
    expect(noNextReasons({ paused: false, member: "ton" }, TEAM)).toEqual([]);
    expect(noNextReasons({ paused: true, member: "ton" }, TEAM)).toEqual(["this routine is paused"]);
    expect(noNextReasons({ paused: false, member: "ton" }, { ...TEAM, paused: true })).toEqual(["everyone is paused"]);
    expect(noNextReasons({ paused: false, member: "pim" }, { ...TEAM, members: ["nam", "ton"] })).toEqual(["Pim is not on this shop's team"]);
    expect(noNextReasons({ paused: false, member: "ton", waitsFor: "stock_feed" }, TEAM))
      .toEqual(["it waits for a stock feed, which Manut AI does not have yet"]);
    expect(noNextReasons({ paused: true, member: "pim", waitsFor: "stock_feed" }, { paused: true, since: null, members: ["nam"] })).toEqual([
      "this routine is paused", "everyone is paused", "Pim is not on this shop's team", "it waits for a stock feed, which Manut AI does not have yet"]);
  });

  it("says the next run in Bangkok time when there is one, why there is none when there is not, and never a blank", () => {
    expect(nextRunText(routine({ next: "2026-11-23T05:00:00.000Z" }), TEAM, NOW)).toBe("Next run at 12:00.");
    expect(nextRunText(routine(), TEAM, NOW)).toBe("Next run on 24 November at 08:00.");
    // A time that falls just after midnight in Bangkok is the next day's, whatever the date in UTC is.
    expect(nextRunText(routine({ next: "2026-11-23T17:30:00.000Z" }), TEAM, NOW)).toBe("Next run on 24 November at 00:30.");
    expect(nextRunText(routine({ next: null, paused: true }), TEAM, NOW)).toBe("No next run: this routine is paused.");
    expect(nextRunText(routine({ next: null }), TEAM, NOW)).toBe("No next run is set.");
    expect(nextRunText(routine({ next: "soon" }), TEAM, NOW)).toBe("No next run is set.");
    expect(nextRunText(routine({ next: "soon" }), { ...TEAM, paused: true }, NOW)).toBe("No next run: everyone is paused.");
  });

  it("says what pausing a routine does, leaving out the skipped runs for one that has no clock", () => {
    expect(W.pauseEffect({ name: "Morning brief" })).toBe("Morning brief stops running at once, and nothing else about it changes. Each time it would have run, a skipped run is written down, saying the routine was paused.");
    expect(W.pauseEffect({ name: "Low stock", waitsFor: "stock_feed" })).toBe("Low stock stops running at once, and nothing else about it changes.");
    expect(W.pauseTitle("Morning brief")).toBe("Pause Morning brief?");
    expect(W.paused("Morning brief")).toBe("Paused Morning brief. It will not run until it is resumed.");
  });

  it("says what resuming does and what will still keep the routine from running, before anything is sent", () => {
    expect(W.resumeEffect({ name: "Morning brief", member: "ton" }, TEAM))
      .toBe("Morning brief runs again from its next time, which is worked out from now. A run it skipped while it was paused is not made up.");
    expect(W.resumeEffect({ name: "Morning brief", member: "pim", waitsFor: "stock_feed" }, { paused: true, since: null, members: ["nam", "ton"] }))
      .toBe("Morning brief runs again from its next time, which is worked out from now. A run it skipped while it was paused is not made up. It will still not run: everyone is paused, Pim is not on this shop's team and it waits for a stock feed, which Manut AI does not have yet.");
    expect(W.resumeTitle("Morning brief")).toBe("Turn Morning brief back on?");
    expect(W.resumed(routine(), TEAM, NOW)).toBe("Resumed Morning brief. Next run on 24 November at 08:00.");
    expect(W.resumed(routine({ next: null }), { ...TEAM, paused: true }, NOW)).toBe("Resumed Morning brief. No next run: everyone is paused.");
  });

  it("says what removing a routine takes with it, and that it cannot be undone", () => {
    expect(W.removeTitle("Morning brief")).toBe("Remove Morning brief?");
    expect(W.removeEffect("Morning brief")).toBe("Morning brief, its runs and its clock go at once, and it will not run again. The audit log keeps how each of its runs ended.");
    expect(W.removeNote).toBe("This cannot be undone. To have it again, make it again with the form below.");
    expect(W.removed("Morning brief")).toBe("Removed Morning brief. Its runs and its clock are gone.");
  });

  it("names the one team change by what it stops, and each routine change in a label that says which routine", () => {
    expect(W.pauseTeamTitle("Baan Mali")).toBe("Pause everyone for Baan Mali?");
    expect(W.pauseTeamEffect).toContain("no routine runs");
    expect(W.pauseTeamEffect).toContain("the owner's ask for a month of the books, is refused");
    expect(W.pauseTeamEffect).toContain("A job already started is not stopped.");
    expect(W.resumeTeamTitle("Baan Mali")).toBe("Resume the team for Baan Mali?");
    expect(W.pauseLabel("Morning brief")).toBe("Pause the routine Morning brief");
    expect(W.resumeLabel("Morning brief")).toBe("Resume the routine Morning brief");
    expect(W.removeLabel("Morning brief")).toBe("Remove the routine Morning brief");
    expect(W.pauseTeamLabel("Baan Mali")).toBe("Pause everyone for Baan Mali");
    expect(W.resumeTeamLabel("Baan Mali")).toBe("Resume the team for Baan Mali");
  });

  it("tags a routine and a team as on or paused, and a run by how it ended, with a status it does not know shown as it is", () => {
    expect(routineTag(false)).toEqual({ label: "On", className: "tag ok" });
    expect(routineTag(true)).toEqual({ label: "Paused", className: "tag warn" });
    expect(teamTag(false)).toEqual({ label: "On", className: "tag ok" });
    expect(teamTag(true)).toEqual({ label: "Paused", className: "tag warn" });
    expect(runTag("done")).toEqual({ label: "Done", className: "tag ok" });
    expect(runTag("failed")).toEqual({ label: "Failed", className: "tag err" });
    expect(runTag("skipped")).toEqual({ label: "Skipped", className: "tag" });
    expect(runTag("missed")).toEqual({ label: "Missed", className: "tag warn" });
    expect(runTag("running")).toEqual({ label: "Running", className: "tag run" });
    expect(runTag("novel")).toEqual({ label: "novel", className: "tag" });
  });

  it("says what a run's reason means, and falls back to what the status alone says", () => {
    expect(runText({ status: "skipped", reason: "routines_off" })).toBe("Routines were switched off.");
    expect(runText({ status: "failed", reason: "not_configured" })).toBe("No model is set up yet.");
    // The reason wins over the status; a status with no reason says what that status means.
    expect(runText({ status: "done", reason: "nothing_to_answer" })).toBe("No customer message was waiting.");
    expect(runText({ status: "done" })).toBe("It made a draft for the owner to read, on the Drafts page.");
    expect(runText({ status: "missed" })).toBe("Its alarm came more than 15 minutes late, so it was not run.");
    expect(runText({ status: "running" })).toBe("It started and has not said how it ended.");
    expect(runText({ status: "failed" })).toBe("It ended without saying why.");
    expect(runText({ status: "skipped" })).toBe("It was not run.");
    expect(runText({ status: "novel" as never })).toBe("");
    expect(runText({ status: "failed", reason: "" })).toBe("It ended without saying why.");
  });

  it("has words for every reason the API's routines give a run, and shows one it does not know as it is", () => {
    // Read from the API's own sources: a reason the claim or the runner can write down is in plain words here, never the code.
    const sources = `${routinesSource}\n${routineStoreSource}\n${shopWaitsSource}`;
    for (const code of ["routine_paused", "team_paused", "member_off", "not_counted_in", "routines_off", "cloud_off", "consent_required",
      "nothing_to_answer", "messages_unavailable", "job_error", "failed"]) {
      expect(sources, `${code} in the API`).toContain(`"${code}"`);
      expect(routineReasonText(code), code).not.toBe(`Reason: ${code}.`);
    }
    expect(routineReasonText("routines_off")).toBe("Routines were switched off.");
    expect(routineReasonText("messages_unavailable")).toBe("The shop's customer messages could not be read.");
    expect(routineReasonText("something_new")).toBe("Reason: something_new.");
  });

  it("puts the API's refusals in the page's words, the console's usual words for the rest, and what moved on as the list moving on", () => {
    const text = routinesErrorText;
    expect(text(new ApiError(503, "routines_unavailable"), "read")).toBe(W.readUnavailable);
    expect(text(new ApiError(503, "routines_unavailable"), "change")).toBe(W.changeUnavailable);
    expect(W.readUnavailable).toBe("The API could not read this shop's routines, so they are not shown. Try again.");
    expect(W.changeUnavailable).toBe("The API could not reach this shop's routines, so nothing may have changed. Press Refresh to check, then try again.");
    expect(text(new ApiError(503, "shop_unavailable"), "change")).toBe("The API could not read this shop's record, so it cannot say whether it is a pilot shop. Nothing was changed. Try again.");
    expect(text(new ApiError(404, "shop_not_found"), "read")).toBe("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
    expect(text(new ApiError(404, "shop_not_found"), "change")).toBe(W.notAShop);
    expect(text(new ApiError(404, "not_found"), "change")).toBe("That routine is already gone. The list was refreshed.");
    // The rest is the console's own: a refused key, an API out of reach, a code it has no words for, and something that is no error.
    expect(text(new ApiError(403, "forbidden"), "change")).toBe(errorText(new ApiError(403, "forbidden")));
    expect(text(new ApiError(401, "routines_unavailable"), "read")).toBe(errorText(new ApiError(401, "routines_unavailable")));
    expect(text(new ApiError(0, "network"), "read")).toBe("Could not reach the API. Check the connection and try again.");
    expect(text(new ApiError(400, "invalid_request"), "change")).toBe("The API did not accept this (invalid_request).");
    expect(text(new ApiError(400, "tenant_required"), "read")).toBe("The API did not accept this (tenant_required).");
    expect(text(new ApiError(500, "boom"), "change")).toBe("The API answered with an error (boom).");
    expect(text(new Error("x"), "change")).toBe("Something unexpected went wrong. Try again.");
  });

  it("treats exactly the one refusal that says the routine is gone as the list having moved on", () => {
    expect([...ROUTINES_MOVED_ON]).toEqual(["not_found"]);
  });
});
