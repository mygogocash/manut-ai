// What each coding session's lane has learned from its events (lane.ts), kept by the session's chat key while the app
// runs. The sessions store hands every event of a coding session's chat to `noteLaneEvent`; the Code page reads the
// records back. Nothing is saved: a lane's state is of this run, and a restart starts each lane's record again.
import { useSyncExternalStore } from "react";
import { emptyLane, noteLane, type LaneRecord } from "./lane";

const lanes = new Map<string, LaneRecord>();
const listeners = new Set<() => void>();
let version = 0;

const NONE = Object.freeze(emptyLane()) as LaneRecord;

const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** An event of the coding session whose chat has key `chat`. */
export function noteLaneEvent(chat: string, ev: { event: string; [k: string]: unknown }, now: number = Date.now()): void {
  if (!chat) return;
  const before = lanes.get(chat) ?? NONE;
  const after = noteLane(before, ev, now);
  if (after === before) return;
  lanes.set(chat, after);
  changed();
}

/** The lane of the session whose chat has key `chat`: nothing yet when no event has told it anything. */
export const laneOf = (chat: string): LaneRecord => lanes.get(chat) ?? NONE;

/** The session was closed: its lane goes with it. */
export function forgetLane(chat: string): void {
  if (lanes.delete(chat)) changed();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Re-renders when any lane learns something. */
export function useLanesVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Forgets every lane (tests). */
export function resetLanes(): void {
  lanes.clear();
  changed();
}
