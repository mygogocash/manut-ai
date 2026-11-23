// Noticing that the Mac slept. A page cannot ask: its timers stand still while the Mac sleeps, so the first tick after waking
// finds the clock far ahead of the last one. That gap, and what was working before it, is all this knows.
import { describe, expect, it } from "vitest";
import { createWakeWatch, WAKE_GAP_MS, WAKE_TICK_MS } from "./wake";

const SEC = 1000;
type Wake = { count: number; wokeAt: number; sleptAt: number };

function watch(counts: number[] | number = 0, gapMs = 60 * SEC) {
  const wakes: Wake[] = [];
  const read = Array.isArray(counts) ? counts : [counts];
  let i = 0;
  const w = createWakeWatch({ gapMs, working: () => read[Math.min(i++, read.length - 1)], onWake: (x) => wakes.push(x) });
  return { w, wakes };
}

describe("noticing that the Mac slept", () => {
  it("checks every 5 seconds and takes a gap of 2 minutes for sleep: a busy page is late by seconds, not minutes", () => {
    expect(WAKE_TICK_MS).toBe(5 * SEC);
    expect(WAKE_GAP_MS).toBe(120 * SEC);
  });

  it("says nothing on the first tick, nor while the ticks keep their pace", () => {
    const { w, wakes } = watch(2);
    for (let t = 0; t <= 40 * SEC; t += 5 * SEC) w.tick(t);
    expect(wakes).toEqual([]);
  });

  it("says what was working before the gap, once the gap is long enough to be sleep", () => {
    const { w, wakes } = watch([0, 3, 3]);
    w.tick(0);
    w.tick(5 * SEC); // reads 3 jobs working
    w.tick(5 * SEC + 90 * SEC); // asleep for 90 s
    expect(wakes).toEqual([{ count: 3, wokeAt: 95 * SEC, sleptAt: 5 * SEC }]);
  });

  it("says nothing for a gap shorter than the one it takes for sleep", () => {
    const { w, wakes } = watch(2, 60 * SEC);
    w.tick(0);
    w.tick(59 * SEC);
    expect(wakes).toEqual([]);
  });

  it("starts counting again after a wake: one wake, one report, and the next one is its own", () => {
    const { w, wakes } = watch([1, 1, 4, 4]);
    w.tick(0);
    w.tick(100 * SEC);
    expect(wakes).toHaveLength(1);
    w.tick(105 * SEC);
    expect(wakes).toHaveLength(1);
    w.tick(300 * SEC);
    expect(wakes.map((x) => x.wokeAt)).toEqual([100 * SEC, 300 * SEC]);
  });

  it("reports nothing waited when nothing was working, leaving it to the caller to stay quiet", () => {
    const { w, wakes } = watch(0);
    w.tick(0);
    w.tick(200 * SEC);
    expect(wakes).toEqual([{ count: 0, wokeAt: 200 * SEC, sleptAt: 0 }]);
  });

  it("is not fooled by a clock set back", () => {
    const { w, wakes } = watch(2);
    w.tick(1_000_000);
    w.tick(10 * SEC);
    w.tick(15 * SEC);
    expect(wakes).toEqual([]);
  });
});
