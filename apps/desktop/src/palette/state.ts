// Whether the command palette is open, and where the focus goes back to when it closes. Kept outside React so ⌘K (a
// window key handler), the menu's Search button and the overlay all see one answer.
import { useSyncExternalStore } from "react";

interface Focusable {
  focus(): void;
  isConnected?: boolean;
}

let open = false;
let from: Focusable | null = null;
const subs = new Set<() => void>();
const tell = () => {
  for (const f of [...subs]) f();
};

/** Give the focus back to `el` if it is still on the page. True when it was given. */
export function restoreFocus(el: Focusable | null): boolean {
  if (!el || el.isConnected === false) return false;
  el.focus();
  return true;
}

export const paletteOpen = () => open;

/** Open the palette, remembering what had the focus. `active` is that element (the page's active element by default). */
export function openPalette(active: Focusable | null = typeof document === "undefined" ? null : (document.activeElement as Focusable | null)): void {
  if (open) return;
  from = active;
  open = true;
  tell();
}

/** Close it and, unless told not to, give the focus back to where it was. */
export function closePalette(opts: { restore?: boolean } = {}): void {
  if (!open) return;
  open = false;
  const back = from;
  from = null;
  tell();
  if (opts.restore !== false) restoreFocus(back);
}

/** ⌘K: open when closed, close when open. */
export function togglePalette(): void {
  if (open) closePalette();
  else openPalette();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, paletteOpen, paletteOpen);
}
