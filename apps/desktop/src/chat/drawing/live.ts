// Which drawings are live, across every open chat (point 8 of the safety model in drawingDoc.ts): at most LIVE_MAX at
// once. Showing one more sends the oldest back to a still card with Show; a card that goes far out of view or away
// lets its place go. Kept in memory only, so nothing about a shown drawing survives a restart.
import { useSyncExternalStore } from "react";
import { LIVE_MAX, nextLive } from "./drawingDoc";
import { changes } from "../../lib/changes";

let live: string[] = [];
const subs = changes();
const emit = () => subs.emit();

/** `id`'s drawing is shown: it becomes the newest, and the oldest past the limit go still. */
export function claimLive(id: string): void {
  live = nextLive(live, id, LIVE_MAX).live;
  emit();
}

/** `id`'s drawing is put away (far out of view, hidden, or its chat closed). */
export function releaseLive(id: string): void {
  if (!live.includes(id)) return;
  live = live.filter((x) => x !== id);
  emit();
}

/** The live drawings, oldest first (for the tests). */
export const liveNow = (): readonly string[] => live;

const subscribe = (f: () => void) => {
  return subs.subscribe(f);
};

/** Whether `id`'s drawing has a live frame now. */
export function useLive(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => live.includes(id),
    () => false,
  );
}
