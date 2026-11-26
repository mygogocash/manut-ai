import { describe, expect, it } from "vitest";
import { isObj } from "./guards";

describe("isObj", () => {
  it("takes objects and nothing else", () => {
    expect(isObj({})).toBe(true);
    expect(isObj({ a: 1 })).toBe(true);
    for (const v of [null, undefined, [], [1], "x", "", 0, 1, NaN, true, false, () => 1]) expect(isObj(v)).toBe(false);
  });
  it("agrees with the null-checked spelling on every input", () => {
    const old = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
    for (const v of [null, undefined, [], {}, "a", "", 0, 1, NaN, true, false, new Date(), () => 1, Symbol("s")]) expect(isObj(v)).toBe(old(v));
  });
});
