// What the screen in front of the person offers right now, told to the command palette by the parts that own it. A chat
// box has a microphone only while it is on screen, a Lanes band has a New lane only while a project is open, the Team
// page offers Pause everyone only while it can, and Settings › Developer offers Practice and Connected only on its own
// page. The palette lists an action only while its place has registered, so one that needs a place that is not open is
// never shown (and never shown disabled). Each place hands over the very function its own button calls: the palette
// has no way of doing these things that the button has not.
import { useEffect, useSyncExternalStore } from "react";

export interface BoxPlace {
  /** the microphone is listening or starting */
  micLive(): boolean;
  /** voice mode is on in some phase */
  modeLive(): boolean;
  /** the language spoken, as the buttons name it ("Thai") */
  spoken(): string;
  /** the microphone button's press */
  toggleMic(): void;
  /** the voice mode button's press */
  toggleMode(): void;
}

export interface Places {
  box?: BoxPlace;
  /** the Lanes band's New lane, for the project open on the Code page */
  lane?: { newLane(): void };
  /** the Team page's Pause everyone button; it opens the question and nothing more */
  pause?: { ask(): void };
  /** Settings › Developer's Practice or Connected: the segment shown and the press of the other */
  runtime?: { mode: "practice" | "connected"; set(mode: "practice" | "connected"): void };
}

type Entry<K extends keyof Places> = { token: object; value: NonNullable<Places[K]> };
const held: { [K in keyof Places]: Entry<K>[] } = {};
const subs = new Set<() => void>();
let version = 0;
let snapshot: Places = {};

const rebuild = () => {
  const next: Places = {};
  for (const k of Object.keys(held) as (keyof Places)[]) {
    const list = held[k] as Entry<typeof k>[] | undefined;
    // the newest registration wins: two boxes mounted at once (a chat kept behind a page) leave the one on top
    if (list?.length) (next as Record<string, unknown>)[k] = list[list.length - 1].value;
  }
  snapshot = next;
  version += 1;
  for (const f of [...subs]) f();
};

/** Register a place until the returned function is called. */
export function registerPlace<K extends keyof Places>(key: K, value: NonNullable<Places[K]>): () => void {
  const token = {};
  ((held[key] ??= []) as Entry<K>[]).push({ token, value });
  rebuild();
  return () => {
    const list = held[key] as Entry<K>[] | undefined;
    if (!list) return;
    const at = list.findIndex((e) => e.token === token);
    if (at >= 0) list.splice(at, 1);
    rebuild();
  };
}

export const getPlaces = (): Places => snapshot;
export const placesVersion = () => version;

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** The places registered now, for the palette. */
export function usePlaces(): Places {
  return useSyncExternalStore(subscribe, getPlaces, getPlaces);
}

/** Register `value` for as long as the calling component shows it (null: nothing to offer). Re-registers when `value`
 *  changes, so pass an object that is stable between renders (or that changes only when what it offers does). */
export function usePlace<K extends keyof Places>(key: K, value: Places[K] | null): void {
  useEffect(() => (value ? registerPlace(key, value as NonNullable<Places[K]>) : undefined), [key, value]);
}
