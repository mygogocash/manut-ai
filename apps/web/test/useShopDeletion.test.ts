import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { classifyDeleteError } from "../src/ops/useShopDeletion";

describe("what a failed deletion's answer means", () => {
  it("reads a shop that no longer exists as gone, from the API or the practice fake", () => {
    expect(classifyDeleteError(new ApiError(404, "shop_not_found"))).toBe("gone");
    expect(classifyDeleteError(new ApiError(404, "unknown_tenant"))).toBe("gone");
  });

  it("reads a wipe that stopped part way as partial", () => {
    expect(classifyDeleteError(new ApiError(500, "wipe_incomplete"))).toBe("partial");
  });

  it("reads a 4xx, or a call never sent for want of a key, as a refusal that deleted nothing", () => {
    expect(classifyDeleteError(new ApiError(409, "name_mismatch"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(404, "not_found"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(403, "forbidden"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(400, "invalid_request"))).toBe("refused");
    expect(classifyDeleteError(new ApiError(0, "operator_key_missing"))).toBe("refused");
  });

  it("reads no answer, a server error, an unreadable success or anything unexpected as unclear", () => {
    expect(classifyDeleteError(new ApiError(0, "network"))).toBe("unclear");
    expect(classifyDeleteError(new ApiError(503, "storage_unavailable"))).toBe("unclear");
    expect(classifyDeleteError(new ApiError(200, "bad_response"))).toBe("unclear");
    expect(classifyDeleteError(new TypeError("Failed to fetch"))).toBe("unclear");
  });
});
