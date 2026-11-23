import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { classifyDeleteError, confirmsShopName } from "../src/ops/useShopDeletion";

describe("what a failed deletion's answer means", () => {
  it("reads a shop the API has deleted as gone, as the API and the practice fake say it", () => {
    expect(classifyDeleteError(new ApiError(404, "tenant_deleted"))).toBe("gone");
    expect(classifyDeleteError(new ApiError(404, "unknown_tenant"))).toBe("gone");
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
