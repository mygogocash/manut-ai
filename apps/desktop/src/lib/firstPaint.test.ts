import { beforeEach, describe, expect, it } from "vitest";
import { ARRIVING_MS, hasArrived, markArrived, resetArrived, stepsOf } from "./firstPaint";

describe("first paint", () => {
  beforeEach(resetArrived);

  it("spends a page's key once, for the session, and keeps pages apart", () => {
    expect(hasArrived("home")).toBe(false);
    markArrived("home");
    expect(hasArrived("home")).toBe(true);
    expect(hasArrived("history")).toBe(false);
  });

  it("starts a fresh session on reset", () => {
    markArrived("team");
    resetArrived();
    expect(hasArrived("team")).toBe(false);
  });

  it("counts steps per list, so each part of a page starts from the first step", () => {
    const a = {};
    const b = {};
    expect(stepsOf([a, a, a, b, b])).toEqual([0, 1, 2, 0, 1]);
  });

  it("counts a window as long as Rise with its four steps", () => {
    expect(ARRIVING_MS).toBeGreaterThanOrEqual(500 + 4 * 50);
    expect(ARRIVING_MS).toBeLessThan(1000);
  });
});
