// The selection of several rows (selection.ts, item 94) wired to one list: what a click and a key do on its rows, and which rows
// are selected. The list passes its rows' keys in the order it draws them.
import { useEffect, type KeyboardEvent, type MouseEvent } from "react";
import { isMac } from "../app/shortcuts";
import { actsOn, clearSelection, clickSelect, getSelection, setSelection, stepSelect, toggleKey, useSelection } from "./selection";

/** Escape clears a selection wherever the focus is, once nothing nearer took the key (an open menu closes first). */
export function useSelectionEscape(): void {
  const sel = useSelection();
  const any = sel.keys.length > 0;
  useEffect(() => {
    if (!any) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [any]);
}

export function useRowSelect(scope: string, order: readonly string[]) {
  const sel = useSelection();
  const mine = sel.scope === scope ? sel.keys : [];
  return {
    /** Whether row `key` is selected. */
    selected: (key: string | undefined): boolean => !!key && mine.includes(key),
    /** The rows the menu of row `key` acts on. */
    actsOn: (key: string): readonly string[] => actsOn(sel, scope, key),
    /** A click on row `key`: Shift or Cmd selects; a plain click clears the selection and opens it. */
    click: (e: MouseEvent, key: string | undefined, open: () => void): void => {
      const next = key ? clickSelect(getSelection(), scope, order, key, { toggle: toggleKey(e, isMac()), range: e.shiftKey }) : null;
      if (next) {
        e.preventDefault();
        setSelection(next);
        return;
      }
      if (getSelection().keys.length) clearSelection();
      open();
    },
    /** Shift with an up or down arrow on row `key` reaches the next row, and the focus goes there. */
    keyDown: (e: KeyboardEvent, key: string | undefined): void => {
      if (!key || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      const step = stepSelect(getSelection(), scope, order, key, e.key === "ArrowDown" ? 1 : -1);
      if (!step) return;
      e.preventDefault();
      setSelection(step.sel);
      const list = (e.currentTarget as HTMLElement).closest("[data-select-scope]");
      list?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(step.focus)}"] button`)?.focus();
    },
  };
}

export type RowSelect = ReturnType<typeof useRowSelect>;

/** A list with no selection (a view drawn by a test): a click opens its row, as before item 94. */
export const NO_SELECT: RowSelect = {
  selected: () => false,
  actsOn: (key) => [key],
  click: (_e, _key, open) => open(),
  keyDown: () => undefined,
};
