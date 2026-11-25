// What each coding session's lane has learned from its events (lane.ts), kept by the session's chat key while the app
// runs. The sessions store hands every event of a coding session's chat to `noteLaneEvent`; the Code page reads the
// records back. Nothing is saved: a lane's state is of this run, and a restart starts each lane's record again.
import { useSyncExternalStore } from "react";
import { emptyLane, noteLane, type LaneRecord, type LaneWhere } from "./lane";

const lanes = new Map<string, LaneRecord>();
const listeners = new Set<() => void>();
let version = 0;

const NONE = Object.freeze(emptyLane()) as LaneRecord;

/** Whether the chat with key `key` is a lane's: a coding session that runs as a chat in the app (`agent:<id>`). A session in its own
 *  terminal has no chat to read a lane from, and a Hermes folder chat is not a coding agent's. */
export const isLaneChat = (key: string | null | undefined): key is string => !!key && key.startsWith("agent:");

const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** An event of the coding session whose chat has key `chat`, which works in `where` (its lane's own folder). */
export function noteLaneEvent(chat: string, ev: { event: string; [k: string]: unknown }, now: number = Date.now(), where?: LaneWhere): void {
  if (!chat) return;
  const before = lanes.get(chat) ?? NONE;
  const after = noteLane(before, ev, now, where);
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

// ---- the lanes' folders kept on this computer ----------------------------------------------------------------------
//
// A lane's folder is kept when its session closes with changes in it (sessions.ts `letLaneGo`), and the Code page lists the
// kept ones (KeptLanes.tsx). Whatever adds or removes one says so here, so the list is read again at once.

const keptListeners = new Set<() => void>();
let keptVersion = 0;

/** A lane's folder was kept or removed: the Code page reads its list again. */
export function keptLanesChanged(): void {
  keptVersion++;
  keptListeners.forEach((l) => l());
}

const subscribeKept = (l: () => void) => {
  keptListeners.add(l);
  return () => keptListeners.delete(l);
};

/** Changes when a lane's folder was kept or removed. */
export function useKeptLanesVersion(): number {
  return useSyncExternalStore(subscribeKept, () => keptVersion, () => keptVersion);
}

/** Forgets every lane (tests). */
export function resetLanes(): void {
  lanes.clear();
  changed();
}
