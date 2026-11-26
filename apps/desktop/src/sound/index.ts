// The app's sounds (item 131, ported from GoSpark): what plays, when it may, and the switches. `docs/sounds.md` lists each
// moment. Other code calls these functions and nothing else of the folder.
import { sounds } from "./player";
import type { ToneId } from "./tones";
import type { TooltipCue } from "./recipes";

export { allowsSound, silencedCount, setGateForTests, FAKE_AUDIO_FLAG } from "./gate";
export { createPlayer, sharedAudio, type Player, type PlayerDeps } from "./player";
export { TONES, TONE_LABEL, type ToneId } from "./tones";
export * from "./prefs";

/** The finish chime, or the chosen tone. `key` names the finish: one that already sounded makes no second sound. */
export const playFinish = (key?: string): Promise<boolean> => sounds().finish({ key });
/** Play a finish choice for Settings' Preview, whatever the switches say. */
export const previewTone = (tone: ToneId): Promise<boolean> => sounds().finish({ tone, preview: true });
/** The small tick of a row settling. */
export const playSettle = (): Promise<boolean> => sounds().settle();
export const previewSettle = (): Promise<boolean> => sounds().settle({ preview: true });
/** The effort slider's sound for level `index` of `count`: a ladder of ticks rising with the level, and an impact on the
 *  top one. Item 132's effort card calls this as the thumb crosses a level; it is silent when the switch is off. */
export const effortTick = (index: number, count: number): Promise<boolean> => sounds().effort(index, count);
export const previewEffort = (index: number, count: number): Promise<boolean> => sounds().effort(index, count, { preview: true });
/** The soft tick of a tooltip opening or closing. The app has no tooltip component yet, so nothing calls it. */
export const tooltipTick = (cue: TooltipCue): Promise<boolean> => sounds().tooltip(cue);
/** Fetch a tone's file ahead of its first play. */
export const warmTone = (tone: ToneId): Promise<void> => sounds().warm(tone);
