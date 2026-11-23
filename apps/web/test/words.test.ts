import { describe, expect, it } from "vitest";
import { ApiError, type DeletedShop, type OwnerCard, type PilotGate, type Shop } from "../src/api";
import {
  canRetryCard,
  cardText,
  deletedText,
  deleteRefusalText,
  deleteWhatText,
  gateWords,
  ownerLineWords,
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

describe("the words for owner messages on LINE", () => {
  const TRIED = "2026-11-23T03:02:00Z";
  const card = (overrides: Partial<OwnerCard>): OwnerCard => ({ state: "sent", attempts: 1, lastTriedAt: TRIED, ...overrides });

  it("says where each card stands", () => {
    expect(cardText(card({ sentAt: TRIED }), "Fon", SAME_DAY)).toBe("Card sent to Fon on LINE at 10:02.");
    expect(cardText(card({ sentAt: TRIED }), "Fon", NEXT_DAY)).toBe("Card sent to Fon on LINE on 23 November at 10:02.");
    expect(cardText(card({ state: "sending" }), "Fon", SAME_DAY)).toBe("Sending the card to Fon on LINE.");
    expect(cardText(card({ state: "failed", reason: "provider_429" }), "Fon", SAME_DAY))
      .toBe("The card to Fon did not go out: LINE refused it (provider_429).");
    expect(cardText(card({ state: "failed", reason: "account_not_set" }), "Fon", SAME_DAY))
      .toBe("The card to Fon did not go out: Manut AI's LINE account is not set up.");
    expect(cardText(card({ state: "failed", reason: "vault_unavailable" }), "Fon", SAME_DAY))
      .toBe("The card to Fon did not go out: it could not be prepared (vault_unavailable).");
    expect(cardText(card({ state: "unknown", reason: "provider_unreachable" }), "Fon", SAME_DAY))
      .toBe("Not sure the card reached Fon: LINE did not answer. Sending it again is safe, since LINE never shows it twice.");
    expect(cardText(card({ state: "unknown", reason: "provider_500" }), "Fon", SAME_DAY))
      .toBe("Not sure the card reached Fon: LINE did not answer. Sending it again is safe, since LINE never shows it twice.");
  });

  it("offers to send a card again only when it may not have arrived and the reply still waits", () => {
    expect(canRetryCard(card({ state: "failed" }), "proposed", SAME_DAY)).toBe(true);
    expect(canRetryCard(card({ state: "unknown" }), "proposed", SAME_DAY)).toBe(true);
    expect(canRetryCard(card({ state: "failed" }), "confirmed", SAME_DAY)).toBe(false);
    expect(canRetryCard(card({ state: "sent" }), "proposed", SAME_DAY)).toBe(false);
    // A push still under way is left alone for two minutes; after that it was cut off.
    expect(canRetryCard(card({ state: "sending" }), "proposed", Date.parse(TRIED) + 60_000)).toBe(false);
    expect(canRetryCard(card({ state: "sending" }), "proposed", Date.parse(TRIED) + 120_000)).toBe(true);
  });

  it("tells the operator how a link code is used, and when it stops working", () => {
    expect(ownerLineWords.codeSteps("Dao", "@manutai", "2026-11-23T03:30:00Z", SAME_DAY)).toEqual([
      "Ask Dao to add Manut AI (@manutai) as a friend on LINE.",
      "Dao sends this code in that chat. Spaces do not matter.",
      "It works once, until 10:30. Dao gets an answer in the chat when it works. Refresh to see it here.",
    ]);
    expect(ownerLineWords.codeSteps("Dao", undefined, "2026-11-23T03:30:00Z", SAME_DAY)[0])
      .toBe("Ask Dao to add Manut AI's LINE account as a friend.");
    expect(ownerLineWords.linked("Fon", "2026-11-20T03:00:00Z", SAME_DAY)).toBe("Fon linked on LINE on 20 November at 10:00.");
  });
});
