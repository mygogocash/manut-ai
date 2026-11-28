// Where Settings › General › Keyboard takes the eye when it opens from the key sheet (item 167d): the sheet's Change on a row asks
// for that action's row, its link at the foot for the list. The list may not be on screen yet (Settings opens on another page, or
// not at all), so the ask waits for it, and goes stale after a few seconds so a later visit to Settings is never moved by it.
import { changes } from "../lib/changes";
import type { KeyAction } from "../app/keys";

export type KeysFocus = KeyAction | "list";

const STALE_MS = 3000;
let wanted: { what: KeysFocus; at: number } | null = null;
const listeners = changes();

/** Ask the Keyboard list to scroll to `what` and focus it: an action's Change, or the list's own head. */
export function askKeysFocus(what: KeysFocus, now = Date.now()): void {
  wanted = { what, at: now };
  listeners.emitSnapshot();
}

/** The ask that is waiting, once, or null when none is or it has gone stale. */
export function takeKeysFocus(now = Date.now()): KeysFocus | null {
  const w = wanted;
  wanted = null;
  return w && now - w.at <= STALE_MS ? w.what : null;
}

export const onKeysFocus = (fn: () => void) => listeners.subscribe(fn);
