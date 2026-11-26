// Open the SESSIONS + menu from elsewhere (⌘N, the first-run card's "New session"). The menu's header registers here.
// Also: the shells this computer offers for a Shell row (the + menu's Shell ▸ list, Settings › Terminal), asked once.
import { useEffect, useState } from "react";
import { getShellHost, type ShellInfo } from "../terminal/host";

/** How the menu opens when something other than the + button asks for it. `chat` puts the focus on the first Chat with Kit
 *  row, and `folder` makes the folder chip start on that folder (the Lanes band's New lane: a lane of this project). */
export interface NewMenuStart {
  chat?: boolean;
  folder?: string;
}

const openers = new Set<(start?: NewMenuStart) => void>();
/** A press made while no + menu was on screen. The menu lives on the Code page, so ⌘N elsewhere opens that page
 *  first, and the header that mounts with it opens its menu at once. */
let pending: { start?: NewMenuStart } | null = null;

let shellsAsked: Promise<ShellInfo[]> | null = null;
/** The shells a Shell row may run here (the shell's `shells_available`, default first); [] when it cannot say. */
export function loadShells(): Promise<ShellInfo[]> {
  return (shellsAsked ??= getShellHost()
    .shells()
    .then((l) => (Array.isArray(l) ? l : []))
    .catch(() => {
      shellsAsked = null;
      return [];
    }));
}

/** `loadShells()` for a component: null until it answers. */
export function useShells(): ShellInfo[] | null {
  const [list, setList] = useState<ShellInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadShells().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

export function onOpenNewSessionMenu(f: (start?: NewMenuStart) => void): () => void {
  openers.add(f);
  if (pending) {
    const { start } = pending;
    pending = null;
    f(start);
  }
  return () => {
    openers.delete(f);
  };
}

export function openNewSessionMenu(start?: NewMenuStart): void {
  if (!openers.size) {
    pending = { start };
    return;
  }
  for (const f of [...openers]) f(start);
}
