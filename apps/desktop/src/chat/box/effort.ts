// The effort card's rules (item 132, the owner's request of 26 Nov 2026 that changing a chat's effort works and looks as
// it does in GoSpark): what the card's title says, where the knob rests, which level Reset goes back to, which stop a
// drag or a key lands on, and the provider's colour at the top level. Each is a port of GoSpark's
// `GoGoCode/Views/Composer/EffortSlider.swift` (`ModelOption.effortTitle`, `defaultEffort`, `EffortSliderCard`'s
// `resolvedIndex` and `isMaxEffort`, `EffortSlider.nearestStop`, `EffortBrand`), kept free of React so the card's tests
// read them directly. Nothing here sends anything: a level reaches the agent only through the caller's `onEffort`, the
// same path the old segmented control used.
import { agentIcon } from "../../ui/AgentIcon";
import { effortTick } from "../../sound";

/** The track's height, and so how far the first and last stops sit in from its ends (GoSpark's `trackHeight`). */
export const TRACK_H = 34;
/** The knob's size (GoSpark's `thumbSize`): larger than the track, so it reads as the thing to take hold of. */
export const KNOB = 42;
const INSET = TRACK_H / 2;

/** A level's name as the card's title and the chip say it: GoSpark's `effortTitle`, the agent's own word with a
 *  capital, and `xhigh` written out. It stays in English in every language, as the levels always have: it names the
 *  agent's setting, and a translated word would hide which one it is. */
export function effortTitle(level: string): string {
  if (level === "xhigh" || level === "extra-high") return "Extra High";
  if (level === "") return "Default";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** The level the card falls back on, and the one Reset goes back to: GoSpark's `defaultEffort` for a model that
 *  names no default of its own, which is every model here (no agent reports one). The first of high or medium in the
 *  agent's own order, else its first level; null when it listed none. */
export function defaultEffort(levels: readonly string[]): string | null {
  return levels.find((l) => l === "high" || l === "medium") ?? levels[0] ?? null;
}

/** Where the knob rests: the level in force, else the default, else the first stop (GoSpark's `resolvedIndex`). */
export function restingIndex(levels: readonly string[], level: string): number {
  const at = levels.indexOf(level);
  if (at >= 0) return at;
  const fallback = defaultEffort(levels);
  const d = fallback === null ? -1 : levels.indexOf(fallback);
  return d >= 0 ? d : 0;
}

/** The top level of more than one: where the title and the track take the provider's colour. */
export const isTop = (index: number, count: number): boolean => count > 1 && index === count - 1;

/** How far along the track `index` sits, from 0 at the first stop to 1 at the last. */
export const stopFraction = (index: number, count: number): number => (count > 1 ? Math.min(1, Math.max(0, index / (count - 1))) : 0);

/** How far along the track a pointer `x` pixels from its left edge is, for a track `width` wide: the first and last
 *  stops sit half the track's height in from its ends, so a pointer past either is at that stop. */
export function pointerFraction(x: number, width: number): number {
  const span = width - INSET * 2;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (x - INSET) / span));
}

/** The stop nearest a place on the track (GoSpark's `nearestStop`). */
export const nearestStop = (fraction: number, count: number): number => (count > 1 ? Math.min(count - 1, Math.max(0, Math.round(fraction * (count - 1)))) : 0);

/** Where a key moves the knob from `index`, or null for a key the slider leaves alone. Right and Up raise the level,
 *  Left and Down lower it, Home and End go to either end, as a slider's keys do everywhere. */
export function keyStop(key: string, index: number, count: number): number | null {
  if (count < 1) return null;
  if (key === "ArrowRight" || key === "ArrowUp") return Math.min(count - 1, index + 1);
  if (key === "ArrowLeft" || key === "ArrowDown") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The colour the top level wears: the provider's own, read from its published mark (item 122, src/ui/agentMarks.ts),
 *  as GoSpark's `EffortBrand` gives each provider its brand. A mark drawn in one colour of its own gives that colour
 *  (Claude's terracotta, DeepSeek's blue). A mark drawn in the text's colour, or in several, gives null: the card then
 *  uses the ink, as GoSpark gives its black-and-white brands (Codex, Cursor, Grok, Copilot) a plain white fill. */
export function brandColour(provider: string | null | undefined): string | null {
  const mark = agentIcon(provider);
  if (mark.kind !== "svg") return null;
  const fills = new Set([...mark.body.matchAll(/fill="(#[0-9a-f]{3,8})"/gi)].map((m) => m[1].toLowerCase()));
  if (fills.size !== 1) return null;
  const [only] = fills;
  // a white or black fill is the mark's own ground, never its colour
  return /^#(fff|ffffff|000|000000)$/.test(only) ? null : only;
}

/** A stop's sound: GoSpark ticks once per stop, rising as the knob climbs, and lands an impact on the top level
 *  (`EffortChime.swift`). Item 131's `effortTick` plays it; it is silent while Settings' effort slider switch is off, and
 *  its gate keeps every test quiet. */
export type Tick = (index: number, count: number) => unknown;

/** Follows a drag from the stop it starts on: each move names the stop under the pointer, and a stop the knob has just
 *  crossed into ticks once, as GoSpark plays its chime where `EffortSlider.swift` sets a new index (about line 1193). A
 *  move within one stop makes no sound, so a slow drag ticks once a stop. */
export function stopTracker(start: number, count: number, tick: Tick = effortTick) {
  let under = start;
  return {
    /** The stop under the pointer at `fraction` of the track. */
    move(fraction: number): number {
      const i = nearestStop(fraction, count);
      if (i !== under) {
        under = i;
        void tick(i, count);
      }
      return under;
    },
    get under() {
      return under;
    },
  };
}

/** Where a key moves the knob from `index`, ticking for the stop it lands on, as GoSpark plays its chime after each
 *  adjustment by the keys (`EffortSlider.swift`, about line 1211). Null for a key the slider leaves alone; a key at
 *  either end moves nothing and makes no sound. */
export function keyStep(key: string, index: number, count: number, tick: Tick = effortTick): number | null {
  const next = keyStop(key, index, count);
  if (next !== null && next !== index) void tick(next, count);
  return next;
}
