// The suggested next message of each coding chat (item 76), by the chat's key: the one text a coding agent predicted after its last turn.
// It is kept in memory only (a restart has no turn to follow), replaced by the next suggestion, and dropped when a turn starts or the
// person sends something. It is shown only while the setting is on (lib/suggest.ts); a suggestion that arrives after the person turned
// it off is dropped, so turning it off stops showing them at once.
import { useSyncExternalStore } from "react";
import { suggestOn } from "../lib/suggest";

const book = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** The longest suggestion kept. */
const MAX = 500;

/** The agent's suggestion for chat `key`. Blank text, or the setting being off, keeps none. */
export function noteSuggestion(key: string, text: string): void {
  const t = text.trim().slice(0, MAX);
  if (!t || !suggestOn()) return;
  if (book.get(key) === t) return;
  book.set(key, t);
  changed();
}

/** Drop the suggestion of chat `key` (a turn started, the person sent a message, the chat closed). */
export function clearSuggestion(key: string): void {
  if (book.delete(key)) changed();
}

/** The suggestion for chat `key`, or null; none while the setting is off. */
export const suggestionFor = (key: string): string | null => (suggestOn() ? (book.get(key) ?? null) : null);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The suggestion for chat `key`, kept current. */
export function useSuggestion(key: string): string | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return suggestionFor(key);
}

/** Tests: start from nothing. */
export function resetSuggestions(): void {
  book.clear();
  changed();
}
