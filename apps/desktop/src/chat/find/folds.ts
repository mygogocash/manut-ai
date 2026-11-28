// Find in a chat (item 150): what the find bar tells the activity lines, kept outside React so the bar, a window key and
// every line see one answer (as palette/state.ts does for the palette).
//
// Two things. A chat whose bar is open (`finding`): its activity lines then draw their folded steps hidden, so the bar can
// read them like the rest of the page. And the folded groups the find holds open (`forced`): the one a match is in while
// it is the current match. A line shows its steps when the person opened it OR the find holds it open, so letting go of
// the group puts it back exactly as the person had it: shut if they never opened it, open if they had.
import { useSyncExternalStore } from "react";

const bars = new Set<string>();
let forced = new Set<string>();
const subs = new Set<() => void>();
const tell = () => {
  for (const f of [...subs]) f();
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** A folded group's name: the chat it is in and its row's id, so two chats that reuse an id never share one. */
export const foldId = (chat: string, row: string): string => `${chat}\u0001${row}`;

/** The find bar of `chat` opened (true) or closed (false). */
export function setFinding(chat: string, on: boolean): void {
  if (bars.has(chat) === on) return;
  if (on) bars.add(chat);
  else bars.delete(chat);
  tell();
}
export const finding = (chat: string): boolean => bars.has(chat);

/** Hold exactly these groups open; every other group the find held goes back to the person's own state. */
export function forceOpen(ids: readonly string[]): void {
  if (ids.length === forced.size && ids.every((i) => forced.has(i))) return;
  forced = new Set(ids);
  tell();
}

/** The person closed this group by hand while the find held it open: the find lets go of it, and does not open it again
 *  until the person moves to another match. */
export function releaseFold(id: string): void {
  if (!forced.has(id)) return;
  forced = new Set([...forced].filter((x) => x !== id));
  tell();
}
export const isForced = (id: string): boolean => forced.has(id);

export function useFinding(chat: string): boolean {
  const now = () => bars.has(chat);
  return useSyncExternalStore(subscribe, now, now);
}
export function useForced(id: string): boolean {
  const now = () => forced.has(id);
  return useSyncExternalStore(subscribe, now, now);
}
