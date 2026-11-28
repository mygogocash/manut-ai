// Keys taught where their actions are (item 167d, `docs/paradev-ux.md`, "The palette and the keys"): the palette's rows, a
// button's tooltip, an empty state beside what it opens and the palette's foot all show an action's key, and always the key
// the person set on Settings › General › Keyboard (keys.ts), else this system's default, drawn for this keyboard (⇧⌘G on a
// Mac, Ctrl+Shift+G elsewhere). An action the person gave no key shows none, and a tooltip is then only its words.
//
// Pure but for the two small hooks at the end, so a test reads every rule without a DOM. Paradev's `useHotkeyDisplay`,
// `HotkeyLabel` and `HotkeyTooltip` (MIT, `paradevai/paradev`) were read for the shape and written again here over this app's
// registry; nothing of their code is used (CREDITS.md).
import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { chordAria, chordCaps, chordText, currentKeys, isMacHere, onKeysChange, type KeyAction, type Keys } from "./keys";

/** One action's key as it is shown: a cap for each key (a row's tail, the canvas's Search board), the text for a tooltip, and the
 *  chord as `aria-keyshortcuts` writes it. */
export interface KeyShown {
  readonly caps: readonly string[];
  readonly text: string;
  readonly aria: string;
}

/** The key shown for `action`: the first of its keys, which is its main one (the person's own when they set one, else this system's
 *  first default: ⌘N before ⌘T), or null when it has none. The Keyboard list and the key sheet show them all. */
export function keyShown(keys: Keys, action: KeyAction, mac: boolean): KeyShown | null {
  const c = keys[action][0];
  return c ? { caps: chordCaps(c, mac), text: chordText(c, mac), aria: chordAria(c) } : null;
}

/** What Return is called on this keyboard: a Mac's key is "Return", the others' "Enter" (the Search board's palette foot names it so). */
export const enterName = (mac: boolean): string => (mac ? "Return" : "Enter");

/** A button's words with its key after them, `Search (⌘K)` (the language's own brackets); the words alone when there is no key. */
export const withKey = (label: string, shown: KeyShown | null): string => (shown ? t("key.hint", { label, keys: shown.text }) : label);

/** What a button takes for its key: the tooltip with the key after the words, and the key for assistive technology. */
export const keyedProps = (label: string, shown: KeyShown | null): { title: string; "aria-keyshortcuts"?: string } => ({
  title: withKey(label, shown),
  ...(shown ? { "aria-keyshortcuts": shown.aria } : {}),
});

// ---- following the person's keys ------------------------------------------------------------------------------------

/** The current keys, the same object until they change, as `useSyncExternalStore` needs. */
let cached: { mac: boolean; keys: Keys } | null = null;
onKeysChange(() => (cached = null));
function keysNow(mac: boolean): Keys {
  if (!cached || cached.mac !== mac) cached = { mac, keys: currentKeys(mac) };
  return cached.keys;
}

/** Every action's keys, drawn again when the person changes one. */
export function useKeys(): Keys {
  const mac = isMacHere();
  return useSyncExternalStore(onKeysChange, () => keysNow(mac), () => keysNow(mac));
}

/** One action's key as it is shown now, drawn again when the person changes it. */
export function useKeyShown(action: KeyAction): KeyShown | null {
  return keyShown(useKeys(), action, isMacHere());
}
