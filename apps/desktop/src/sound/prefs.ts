// The sound switches, saved on this computer like the app's other preferences (localStorage, `manut.*`). Every sound is on
// by default, as in GoSpark (`chimeWhenFinished`, `settleSound`, `effortSound`, `tooltipSoundEnabled`; the tone is Default).
// A storage that cannot be read gives the default, one that cannot be written drops the choice for this run.
import { TONES, type ToneId } from "./tones";

export const PREF_KEYS = {
  finish: "manut.sound.finish",
  tone: "manut.sound.tone",
  settle: "manut.sound.settle",
  effort: "manut.sound.effort",
  tooltip: "manut.sound.tooltip",
} as const;

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage */
  }
}

const flag = (key: string): boolean => read(key) !== "off";
const setFlag = (key: string, on: boolean): void => write(key, on ? "on" : "off");

/** A soft chime when a turn finishes, whether or not the chat is in view (still held by quiet hours and "Sounds"). */
export const finishChimeEnabled = (): boolean => flag(PREF_KEYS.finish);
export const setFinishChimeEnabled = (on: boolean): void => setFlag(PREF_KEYS.finish, on);

/** The sound a finish makes: Default (the synthesized chime) or one of the five tones. An unknown value is Default. */
export function finishTone(): ToneId {
  const v = read(PREF_KEYS.tone);
  return (TONES as readonly string[]).includes(v ?? "") ? (v as ToneId) : "default";
}
export const setFinishTone = (tone: ToneId): void => write(PREF_KEYS.tone, tone);

/** A small tick as a row is put away with Done for now. */
export const settleSoundEnabled = (): boolean => flag(PREF_KEYS.settle);
export const setSettleSoundEnabled = (on: boolean): void => setFlag(PREF_KEYS.settle, on);

/** A tick per level as the effort slider is dragged, and an impact at the top. */
export const effortSoundEnabled = (): boolean => flag(PREF_KEYS.effort);
export const setEffortSoundEnabled = (on: boolean): void => setFlag(PREF_KEYS.effort, on);

/** The soft tick when one of the app's own tooltips opens and closes. */
export const tooltipSoundEnabled = (): boolean => flag(PREF_KEYS.tooltip);
export const setTooltipSoundEnabled = (on: boolean): void => setFlag(PREF_KEYS.tooltip, on);
