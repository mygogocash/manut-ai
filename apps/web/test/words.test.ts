import { describe, expect, it } from "vitest";
import { ApiError, type DeletedShop, type Shop } from "../src/api";
import { deletedText, deleteRefusalText, deleteWhatText, unfinishedText } from "../src/ops/words";

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
  });
});
