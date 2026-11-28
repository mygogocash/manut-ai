// Whether the key sheet (item 167d) is open, and where the focus goes back to when it closes. Kept outside React so its key
// (a window key handler), the palette's row and Settings' button all see one answer, as the palette's own state is
// (palette/state.ts, whose way of giving the focus back this uses).
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";
import { restoreFocus } from "../palette/state";

interface Focusable {
  focus(): void;
  isConnected?: boolean;
}

let open = false;
let from: Focusable | null = null;
const listeners = changes();

export const keySheetOpen = () => open;

/** Open the sheet, remembering what had the focus. `active` is that element (the page's active element by default). */
export function openKeySheet(active: Focusable | null = typeof document === "undefined" ? null : (document.activeElement as Focusable | null)): void {
  if (open) return;
  from = active;
  open = true;
  listeners.emitSnapshot();
}

/** Close it and, unless told not to, give the focus back to where it was. */
export function closeKeySheet(opts: { restore?: boolean } = {}): void {
  if (!open) return;
  open = false;
  const back = from;
  from = null;
  listeners.emitSnapshot();
  if (opts.restore !== false) restoreFocus(back);
}

/** The sheet's key: open when closed, close when open. */
export function toggleKeySheet(): void {
  if (open) closeKeySheet();
  else openKeySheet();
}

export function useKeySheetOpen(): boolean {
  return useSyncExternalStore(listeners.subscribe, keySheetOpen, keySheetOpen);
}
