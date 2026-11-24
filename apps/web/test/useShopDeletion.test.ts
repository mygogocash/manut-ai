import { describe, expect, it } from "vitest";
import { ApiError, type Shop } from "../src/api";
import { classifyDeleteError, confirmsShopName, isDeleting, unfinishedDeletions } from "../src/ops/useShopDeletion";

describe("deletions that did not finish", () => {
  const gone = (tenant: string, name: string): Shop =>
    ({ tenant, name, ownerName: "", consent: false, deleting: { shopRecord: false } });

  it("shows the console's own first, then each the list reports for a shop that cannot be opened, once", () => {
    const own = { tenant: "a", name: "A", partial: true, tries: 2, error: new ApiError(500, "wipe_incomplete") };
    const shops: Shop[] = [
      gone("a", "A"),
      gone("b", "B"),
      { tenant: "c", name: "C", ownerName: "Dao", consent: false, deleting: { shopRecord: true } },
      { tenant: "d", name: "D", ownerName: "Fon", consent: true },
      gone("e", "E"),
    ];
    // "e" was just seen deleted here, before the list was read again; "c" still has a page that says so.
    expect(unfinishedDeletions({ gone: new Set(["e"]), unfinished: [own] }, shops)).toEqual([
      own,
      { tenant: "b", name: "B", partial: true, tries: 0, error: null },
    ]);
    expect(unfinishedDeletions({ gone: new Set(), unfinished: [] }, null)).toEqual([]);
  });

  it("reads a shop as deleting by the list's word or by the owner's yes that has not finished", () => {
    const shop: Shop = { tenant: "c", name: "C", ownerName: "Dao", consent: false };
    expect(isDeleting(shop)).toBe(false);
    expect(isDeleting({ ...shop, deleting: { shopRecord: true } })).toBe(true);
    const asked = { confirmUrl: "https://web.test/delete/x", expiresAt: "2026-11-24T03:00:00Z" };
    expect(isDeleting({ ...shop, deletion: { state: "deleting", ...asked } })).toBe(true);
    for (const state of ["awaiting_owner", "declined", "expired", "deleted"] as const) {
      expect(isDeleting({ ...shop, deletion: { state, ...asked } }), state).toBe(false);
    }
  });
});

describe("what a failed deletion's answer means", () => {
  it("reads a shop the API has deleted as gone, as the API and the practice fake both say it", () => {
    expect(classifyDeleteError(new ApiError(404, "tenant_deleted"))).toBe("gone");
    expect(classifyDeleteError(new ApiError(404, "tenant_deleted", undefined,
      { deletedAt: "2026-11-23T03:00:00Z", deletedBy: null }))).toBe("gone");
  });

  it("reads a wipe that stopped part way as partial", () => {
    expect(classifyDeleteError(new ApiError(500, "wipe_incomplete"))).toBe("partial");
  });

  it("reads a 4xx, an unrecorded deletion, or a call never sent for want of a key, as a refusal", () => {
    expect(classifyDeleteError(new ApiError(409, "name_mismatch"))).toBe("refused");
    // Never a pilot shop, so there was nothing of it to delete.
    expect(classifyDeleteError(new ApiError(404, "shop_not_found"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(404, "not_found"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(403, "forbidden"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(400, "invalid_request"))).toBe("refused");
    // The API writes its record of a deletion before the wipe, and does not start one it cannot record.
    expect(classifyDeleteError(new ApiError(503, "audit_unavailable"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(0, "operator_key_missing"))).toBe("refused");
  });

  it("reads no answer, a server error, an unreadable success or anything unexpected as unclear", () => {
    expect(classifyDeleteError(new ApiError(0, "network"))).toBe("unclear");
    expect(classifyDeleteError(new ApiError(503, "storage_unavailable"))).toBe("unclear");
    expect(classifyDeleteError(new ApiError(200, "bad_response"))).toBe("unclear");
    expect(classifyDeleteError(new TypeError("Failed to fetch"))).toBe("unclear");
  });
});

describe("the typed name that confirms a deletion", () => {
  it("must be the shop's name, with the same capitals and every space", () => {
    expect(confirmsShopName("Baan Mali", "Baan Mali")).toBe(true);
    expect(confirmsShopName("ร้านบ้านมะลิ", "ร้านบ้านมะลิ")).toBe(true);
    for (const nearly of ["Baan Mal", "baan mali", "Baan Mali ", " Baan Mali", "Baan  Mali", ""]) {
      expect(confirmsShopName(nearly, "Baan Mali"), nearly).toBe(false);
    }
  });

  it("does not care how an accented letter was composed, which no one can see", () => {
    const composed = "Café Mali";
    const decomposed = "Café Mali";
    expect(confirmsShopName(decomposed, composed)).toBe(true);
    expect(confirmsShopName(composed, decomposed)).toBe(true);
  });
});
