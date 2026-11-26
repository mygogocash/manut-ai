// What each sound is: its notes, partials, length and volume. Every number is GoSpark's (`FinishChime.swift`,
// `SettleChime.swift`, `EffortChime.swift` and `TooltipSound.swift` at a7537c80), lifted as they stand and not re-tuned by
// ear. Frequencies are Hz, onsets and durations seconds, volumes the fraction of the system volume a sound plays at.
import type { Note, Partial, Recipe } from "./synth";

/** A turn finishing: a rising fifth, D5 up to A5, the second note a beat later and a touch stronger, the way "done" lands.
 *  The fundamental carries the tone; the octave and double octave add a brief glint at the strike and are gone within a tenth
 *  of a second, which keeps it soft rather than pingy. Well under a stock alert: it registers without cutting into whatever
 *  else is playing. */
export const FINISH: Recipe = {
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
};

/** A row settling: two soft wooden notes stepping down, E5 to C5, the second right behind the first. A woody tone: the
 *  fundamental fades fast, a quiet third harmonic gives it a knock at the strike, and the octave only glints. Barely there:
 *  a tick under the list's motion, not a notification. */
export const SETTLE: Recipe = {
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
};

/** Under the drag, not over it: a slider is a control, not a notification. */
export const EFFORT_QUIETEST = 0.16;
export const EFFORT_LOUDEST = 0.28;
/** The top level carries further, because it is the one worth noticing. */
export const EFFORT_IMPACT_VOLUME = 0.36;
/** The ladder's pitches in semitones above C5, pentatonic so no two levels clash however many the model offers. */
export const EFFORT_DEGREES: readonly number[] = [0, 2, 4, 7, 9, 12, 14, 16];

/** One struck glass tick of the effort ladder, at `fraction` (0 lowest level, 1 the top) of the way up. The upper partials
 *  come in as the level rises: low effort sounds soft and wooden, high effort sounds bright and hard. */
export function effortTick(fraction: number): Recipe {
  const step = EFFORT_DEGREES[Math.min(EFFORT_DEGREES.length - 1, Math.round(fraction * (EFFORT_DEGREES.length - 1)))];
  const frequency = 523.25 * Math.pow(2, step / 12);
  const brightness = 0.1 + 0.34 * fraction;
  return {
    notes: [{ frequency, onset: 0, level: 1 }],
    partials: [
      { multiple: 1, level: 1, decay: 0.035 },
      { multiple: 2, level: brightness, decay: 0.018 },
      { multiple: 3, level: brightness * 0.45, decay: 0.01 },
    ],
    duration: 0.13,
    volume: EFFORT_QUIETEST + (EFFORT_LOUDEST - EFFORT_QUIETEST) * fraction,
  };
}

/** Maximum effort: a low body struck at the same instant as a sweep that climbs two octaves in under a fifth of a second.
 *  The rise is what makes it read as fast rather than merely loud, and the body is what makes it land. */
export const EFFORT_IMPACT: Recipe = {
  notes: [
    // the thump: short, so it punctuates instead of booming
    { frequency: 104, onset: 0, level: 0.9 },
    // the sweep, C5 up to C7: the sound of the slider arriving at the end
    { frequency: 523.25, onset: 0.004, level: 0.7, endFrequency: 2_093 },
    // a fifth above, entering a beat later, so the top of the sweep glints
    { frequency: 784, onset: 0.03, level: 0.34, endFrequency: 3_136 },
  ],
  partials: [
    { multiple: 1, level: 1, decay: 0.055 },
    { multiple: 2, level: 0.42, decay: 0.03 },
    { multiple: 3, level: 0.2, decay: 0.016 },
    { multiple: 5, level: 0.09, decay: 0.01 },
  ],
  duration: 0.24,
  volume: EFFORT_IMPACT_VOLUME,
};

/** The recipe for level `index` of `count`: a tick on the ladder, or the impact on the top level of a ladder of more than
 *  one. Null for a level that is not on the slider. */
export function effortRecipe(index: number, count: number): Recipe | null {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0 || index < 0 || index >= count) return null;
  if (count > 1 && index === count - 1) return EFFORT_IMPACT;
  return effortTick(count > 1 ? index / (count - 1) : 0);
}

/** Odd harmonics fading fast: a small wooden whoosh rather than a sine ping. */
const TRIANGLE: Partial[] = [
  { multiple: 1, level: 1, decay: 0.055 },
  { multiple: 3, level: 0.2, decay: 0.03 },
  { multiple: 5, level: 0.08, decay: 0.02 },
];
/** GoSpark's built-in tooltip tick plays at its slider's default (0.5) of the 0.24 built-in volume. The slider is not
 *  ported, so the product is the volume. */
const TOOLTIP_VOLUME = 0.5 * 0.24;

export type TooltipCue = "open" | "close";

/** The built-in tooltip tick: a sweep up when a tooltip opens, a sweep down when it closes. */
export const TOOLTIP: Record<TooltipCue, Recipe> = {
  open: { notes: [{ frequency: 320, onset: 0, level: 1, endFrequency: 620 }] satisfies Note[], partials: TRIANGLE, duration: 0.16, volume: TOOLTIP_VOLUME },
  close: { notes: [{ frequency: 560, onset: 0, level: 1, endFrequency: 300 }] satisfies Note[], partials: TRIANGLE, duration: 0.14, volume: TOOLTIP_VOLUME },
};
