import { describe, expect, it } from "vitest";
import { EFFORT_DEGREES, EFFORT_IMPACT, EFFORT_IMPACT_VOLUME, EFFORT_LOUDEST, EFFORT_QUIETEST, effortRecipe, effortTick, FINISH, SETTLE, TOOLTIP } from "./recipes";
import { PEAK, renderRecipe, renderWave, SAMPLE_RATE } from "./synth";

const peakOf = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
/** Sign changes in the first `seconds` of `a`: twice a note's frequency, times the seconds. */
const crossings = (a: Float32Array, seconds: number) => {
  let n = 0;
  const end = Math.floor(SAMPLE_RATE * seconds);
  for (let i = 1; i < end; i++) if (a[i - 1] < 0 !== a[i] < 0) n++;
  return n;
};

describe("the sounds' numbers are GoSpark's", () => {
  // Typed out again here from FinishChime.swift, SettleChime.swift, EffortChime.swift and TooltipSound.swift (GoSpark a7537c80),
  // so a change to recipes.ts that is not a change of GoSpark's numbers fails.
  it("finish chime: D5 up to A5, three partials, 0.7 s, volume 0.35", () => {
    expect(FINISH).toEqual({
      notes: [
        { frequency: 587.33, onset: 0, level: 0.8 },
        { frequency: 880, onset: 0.14, level: 1 },
      ],
      partials: [
        { multiple: 1, level: 1, decay: 0.14 },
        { multiple: 2, level: 0.22, decay: 0.06 },
        { multiple: 4, level: 0.08, decay: 0.04 },
      ],
      duration: 0.7,
      volume: 0.35,
    });
  });

  it("settle chime: E5 down to C5, 0.32 s, volume 0.18", () => {
    expect(SETTLE).toEqual({
      notes: [
        { frequency: 659.26, onset: 0, level: 0.7 },
        { frequency: 523.25, onset: 0.075, level: 1 },
      ],
      partials: [
        { multiple: 1, level: 1, decay: 0.075 },
        { multiple: 3, level: 0.16, decay: 0.02 },
        { multiple: 2, level: 0.08, decay: 0.03 },
      ],
      duration: 0.32,
      volume: 0.18,
    });
  });

  it("effort impact: a thump and two sweeps, 0.24 s, volume 0.36", () => {
    expect(EFFORT_IMPACT).toEqual({
      notes: [
        { frequency: 104, onset: 0, level: 0.9 },
        { frequency: 523.25, onset: 0.004, level: 0.7, endFrequency: 2093 },
        { frequency: 784, onset: 0.03, level: 0.34, endFrequency: 3136 },
      ],
      partials: [
        { multiple: 1, level: 1, decay: 0.055 },
        { multiple: 2, level: 0.42, decay: 0.03 },
        { multiple: 3, level: 0.2, decay: 0.016 },
        { multiple: 5, level: 0.09, decay: 0.01 },
      ],
      duration: 0.24,
      volume: 0.36,
    });
    expect([EFFORT_QUIETEST, EFFORT_LOUDEST, EFFORT_IMPACT_VOLUME]).toEqual([0.16, 0.28, 0.36]);
    expect(EFFORT_DEGREES).toEqual([0, 2, 4, 7, 9, 12, 14, 16]);
  });

  it("tooltip tick: a sweep up to open, a sweep down to close, at 0.5 of 0.24", () => {
    const partials = [
      { multiple: 1, level: 1, decay: 0.055 },
      { multiple: 3, level: 0.2, decay: 0.03 },
      { multiple: 5, level: 0.08, decay: 0.02 },
    ];
    expect(TOOLTIP.open).toEqual({ notes: [{ frequency: 320, onset: 0, level: 1, endFrequency: 620 }], partials, duration: 0.16, volume: 0.12 });
    expect(TOOLTIP.close).toEqual({ notes: [{ frequency: 560, onset: 0, level: 1, endFrequency: 300 }], partials, duration: 0.14, volume: 0.12 });
  });
});

describe("renderWave", () => {
  it("makes duration x 44.1 kHz samples, as Swift truncates Int(sampleRate * duration), 0.7 s being 30,869", () => {
    expect(renderRecipe(FINISH).length).toBe(30_869);
    expect(renderRecipe(SETTLE).length).toBe(14_112);
    expect(renderRecipe(EFFORT_IMPACT).length).toBe(10_584);
    expect(renderRecipe(TOOLTIP.open).length).toBe(7_056);
    expect(renderRecipe(TOOLTIP.close).length).toBe(6_174);
    expect(renderRecipe(effortTick(0)).length).toBe(5_733);
  });

  it("scales every sound so its loudest sample is 0.9", () => {
    for (const r of [FINISH, SETTLE, EFFORT_IMPACT, TOOLTIP.open, TOOLTIP.close, effortTick(0), effortTick(1)]) expect(peakOf(renderRecipe(r))).toBeCloseTo(PEAK, 5);
  });

  it("starts at silence (the raised-cosine onset) and ends faded out", () => {
    const w = renderRecipe(FINISH);
    expect(w[0]).toBe(0);
    expect(Math.abs(w[w.length - 1])).toBeLessThan(1e-3);
  });

  it("rings the notes it is given: settle steps from E5 to C5", () => {
    const w = renderRecipe(SETTLE);
    // the first 60 ms is only the 659.26 Hz note (the second enters at 75 ms): about 2 x 659 x 0.06 sign changes
    expect(crossings(w, 0.06)).toBeGreaterThan(70);
    expect(crossings(w, 0.06)).toBeLessThan(90);
  });

  it("a glide moves from its first pitch to its last: the open tick rises, the close tick falls", () => {
    const rate = (w: Float32Array, from: number, to: number) => {
      let n = 0;
      for (let i = Math.floor(from * SAMPLE_RATE) + 1; i < Math.floor(to * SAMPLE_RATE); i++) if (w[i - 1] < 0 !== w[i] < 0) n++;
      return n / (to - from);
    };
    const open = renderRecipe(TOOLTIP.open);
    expect(rate(open, 0.1, 0.14)).toBeGreaterThan(rate(open, 0, 0.04));
    const close = renderRecipe(TOOLTIP.close);
    expect(rate(close, 0.09, 0.13)).toBeLessThan(rate(close, 0, 0.04));
  });

  it("is silent for no notes, and is the same each time it is rendered", () => {
    expect(peakOf(renderWave([], FINISH.partials, 0.2))).toBe(0);
    expect(Array.from(renderRecipe(FINISH).slice(0, 2000))).toEqual(Array.from(renderRecipe(FINISH).slice(0, 2000)));
  });
});

describe("the effort ladder", () => {
  it("ticks up the pentatonic ladder and lands on the impact at the top", () => {
    const r = Array.from({ length: 5 }, (_, i) => effortRecipe(i, 5));
    expect(r[4]).toBe(EFFORT_IMPACT);
    const pitches = r.slice(0, 4).map((x) => x!.notes[0].frequency);
    expect(pitches).toEqual([...pitches].sort((a, b) => a - b));
    expect(new Set(pitches).size).toBe(4);
    expect(pitches[0]).toBeCloseTo(523.25, 2);
  });

  it("is louder as it climbs, from 0.16 up to 0.28, and brighter", () => {
    const first = effortRecipe(0, 5)!;
    const third = effortRecipe(3, 5)!;
    expect(first.volume).toBeCloseTo(0.16, 6);
    expect(third.volume).toBeGreaterThan(first.volume);
    expect(third.volume).toBeLessThan(0.28);
    expect(effortTick(1).volume).toBeCloseTo(0.28, 6);
    expect(effortTick(1).partials[1].level).toBeGreaterThan(effortTick(0).partials[1].level);
  });

  it("a one-level slider ticks at the lowest pitch and has no top", () => {
    expect(effortRecipe(0, 1)).toEqual(effortTick(0));
  });

  it("is nothing for a level that is not on the slider", () => {
    for (const [i, n] of [[-1, 3], [3, 3], [0, 0], [1.5, 3], [0, -2]]) expect(effortRecipe(i, n)).toBeNull();
  });
});
