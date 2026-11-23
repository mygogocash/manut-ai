import { describe, expect, it } from "vitest";
import { sortableId } from "../src/pilot-store";

// Lists read newest first by walking keys backwards, so ids must sort in the order they were made. Two calls in
// the same millisecond used to be ordered by a random tail: wrong about half the time, which made the payments
// list's "newest first" test flaky.
describe("sortableId", () => {
  it("issues ids that sort in the order they were made, even within one millisecond", () => {
    const ids = Array.from({ length: 50 }, () => sortableId("pay", 1_800_000_000_000, 0));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it("keeps sorting forward when the clock steps back", () => {
    const later = sortableId("msg", 1_800_000_100_000, 0);
    const earlierClock = sortableId("msg", 1_800_000_000_000, 0);
    expect([later, earlierClock].sort()).toEqual([later, earlierClock]);
  });

  it("keeps the order of several ids made in one call", () => {
    const ms = 1_800_000_200_000;
    const ids = [0, 1, 2].map((seq) => sortableId("msg", ms, seq));
    expect([...ids].sort()).toEqual(ids);
  });
});
