// Find in a chat (item 150): which chat a ⌘F opens its bar in, and when ⌘F is not the chat's at all.
//
// Every timeline on the page registers as a host while it is mounted. The key is a window shortcut like ⌘K
// (app/shortcuts.ts); it asks `openChatFind`, which says whether a chat took it. Several timelines can be on the page
// (the lanes of a job side by side), so the one the key reaches is the one the keyboard or the pointer is in, else the one
// used last, else the first that is on screen.
/** Places that keep ⌘F for themselves: a terminal and its find bar, this bar, any pane or field that marks itself
 *  `data-own-find` (the pane beside a lane: its files and its editor will have a find of their own), and a menu, a list
 *  or a dialog that is open over the chat. */
export const OWN_FIND = ".xterm, .tfind, .cfind, [data-own-find], [role=dialog], [role=menu], [role=listbox]";

/** Does the place a key went to keep ⌘F for itself? */
export const keepsFind = (target: EventTarget | null): boolean => !!(target as Element | null)?.closest?.(OWN_FIND);

export interface FindHost {
  /** Is `node` inside this chat (its timeline and its box)? */
  holds(node: Node | null): boolean;
  /** Is the chat on screen? */
  shown(): boolean;
  open(): void;
  /** Shut the bar without taking the keyboard: another chat's bar is opening. */
  close(): void;
  isOpen(): boolean;
}

const hosts = new Set<FindHost>();
let lastUsed: FindHost | null = null;

/** A timeline is on the page; the returned function says it left. */
export function registerFindHost(h: FindHost): () => void {
  hosts.add(h);
  return () => {
    hosts.delete(h);
    if (lastUsed === h) lastUsed = null;
  };
}

/** The pointer or the keyboard went into this chat. */
export function usedFindHost(h: FindHost): void {
  lastUsed = h;
}

/** The host a ⌘F reaches: the chat that holds the key's target, else the one that holds the focus, else the one used last,
 *  else the first on screen. Null when no chat is on screen. */
export function pickHost(list: readonly FindHost[], target: Node | null, focused: Node | null, last: FindHost | null): FindHost | null {
  const on = list.filter((h) => h.shown());
  return on.find((h) => h.holds(target)) ?? on.find((h) => h.holds(focused)) ?? (last && on.includes(last) ? last : null) ?? on[0] ?? null;
}

/** ⌘F in a chat: opens that chat's bar (or takes the keyboard back to it when it is open) and says so. False when no chat
 *  is on screen, so the key goes unanswered. */
export function openChatFind(target: EventTarget | null, focused: Node | null = typeof document === "undefined" ? null : document.activeElement): boolean {
  const host = pickHost([...hosts], target as Node | null, focused, lastUsed);
  if (!host) return false;
  // one bar at a time: the highlights and the folded group it holds are one chat's
  for (const h of hosts) if (h !== host && h.isOpen()) h.close();
  lastUsed = host;
  host.open();
  return true;
}
