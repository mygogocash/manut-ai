// Several rows at once (item 94): Shift-click selects every row from the last one picked to this one, Cmd-click (Ctrl-click
// elsewhere) adds or removes one row, Shift with the up or down arrow does the same from the keyboard, and Escape clears. A plain
// click opens its row as always and clears the selection. The row menu of a selected row then does Pin, Snooze, Done for now or
// Archive to all of them, and Undo takes the whole action back (rows.ts `actOnRows`).
//
// One selection at a time, in one list (`scope`: the side menu's Recent, History's days): picking in another list starts again
// there. It lives in memory only: a selection is of the moment. The rules are here, apart from the markup, so they can be tested
// without a page.
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";

export interface Selection {
  scope: string;
  keys: readonly string[];
  /** The row the next Shift-click or Shift-arrow counts from. */
  anchor: string | null;
}

export const NONE: Selection = Object.freeze({ scope: "", keys: Object.freeze([]) as readonly string[], anchor: null });

/** The rows of `order` from `a` to `b`, both included, in the list's order. */
function span(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [b];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** What a click on row `key` of list `scope` (rows in `order`) does to `sel`, or null for a plain click, which opens the row (the
 *  caller then clears the selection). `toggle`: Cmd-click (Ctrl-click elsewhere). `range`: Shift-click. */
export function clickSelect(sel: Selection, scope: string, order: readonly string[], key: string, mods: { toggle: boolean; range: boolean }): Selection | null {
  if (!mods.toggle && !mods.range) return null;
  const mine = sel.scope === scope ? sel : NONE;
  if (mods.range) {
    const from = mine.anchor && order.includes(mine.anchor) ? mine.anchor : key;
    const keys = span(order, from, key);
    // Cmd-Shift-click adds the span to what is selected; Shift-click alone makes it the selection
    return { scope, keys: mods.toggle ? [...new Set([...mine.keys, ...keys])] : keys, anchor: from };
  }
  const keys = mine.keys.includes(key) ? mine.keys.filter((k) => k !== key) : [...mine.keys, key];
  return { scope, keys, anchor: key };
}

/** Shift with an arrow on row `from`: the selection reaches the next row up or down (`dir`), counted from the anchor, and that row
 *  is the one to focus. Null at either end of the list. */
export function stepSelect(sel: Selection, scope: string, order: readonly string[], from: string, dir: 1 | -1): { sel: Selection; focus: string } | null {
  const i = order.indexOf(from);
  const to = order[i + dir];
  if (i < 0 || to === undefined) return null;
  const mine = sel.scope === scope && sel.keys.length ? sel : NONE;
  const anchor = mine.anchor && order.includes(mine.anchor) ? mine.anchor : from;
  return { sel: { scope, keys: span(order, anchor, to), anchor }, focus: to };
}

/** The rows the menu of row `key` acts on: the whole selection when the row is in one of two or more, else the row alone. */
export function actsOn(sel: Selection, scope: string, key: string): readonly string[] {
  return sel.scope === scope && sel.keys.length > 1 && sel.keys.includes(key) ? sel.keys : [key];
}

// ---- the store ----------------------------------------------------------------------------------------------------

let current: Selection = NONE;
const listeners = changes();

export const getSelection = (): Selection => current;
export function setSelection(next: Selection): void {
  const n = next.keys.length ? next : NONE;
  if (n === current) return;
  current = n;
  listeners.emit();
}
export const clearSelection = (): void => setSelection(NONE);

const subscribe = (l: () => void) => {
  return listeners.subscribe(l);
};
export const useSelection = (): Selection => useSyncExternalStore(subscribe, getSelection, getSelection);

/** Whether the platform's "add one" click is Cmd (macOS) or Ctrl. */
export const toggleKey = (e: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean => (mac ? e.metaKey : e.ctrlKey);
