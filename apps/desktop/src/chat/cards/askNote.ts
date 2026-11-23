// What became of an answer given from a notification, for the card to say. The person pressed Approve on a notification
// while the app was in the background, so no card was on screen to show a refusal under its buttons; the app then comes
// forward on that card (store.ts `approveFromNotification`), and the card reads the words from here. By the request's id
// with its revision, the card's own. A card's own button press clears it: what the person does there is the news then.
import { useSyncExternalStore } from "react";

const notes = new Map<string, string>();
const subs = new Set<() => void>();
const emit = () => {
  for (const fn of [...subs]) fn();
};

/** Remember the words for request `requestId`. */
export function noteAsk(requestId: string, words: string): void {
  notes.set(requestId, words);
  emit();
}

export function clearAskNote(requestId: string): void {
  if (notes.delete(requestId)) emit();
}

export const askNoteOf = (requestId: string): string | null => notes.get(requestId) ?? null;

/** The words for request `requestId`, or null; the card re-renders when they change. */
export function useAskNote(requestId: string): string | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => askNoteOf(requestId),
    // the page is never rendered on a server; a test that renders to a string reads the same words
    () => askNoteOf(requestId),
  );
}
