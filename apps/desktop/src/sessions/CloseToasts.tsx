// The app's undo toasts, bottom right, the newest on top, at most GRACE_SHOWN:
//  - a closed TERMINALS row (closeGrace.ts) says "<name> closed", counts its seconds down (one 1 s tick) and has Undo. ⌘Z (macOS) or
//    Ctrl+Shift+Z (elsewhere) undoes the newest while one shows; plain Ctrl+Z stays the terminal program's, and a text field keeps
//    its own undo.
//  - a row pinned, snoozed, settled or archived (item 94, sidebar/rows.ts) says what was done and has Undo for a few seconds, with no
//    countdown: it is a quiet note, not a deadline. The same key takes it back while the focus is in the side menu, on a row or on
//    the toast, so ⌘Z in a chat box or a terminal never moves a row.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { t, type Key } from "../i18n";
import { isMac } from "../app/shortcuts";
import { getSessions } from "./sessions";
import { GRACE_SHOWN, isUndoKey } from "./closeGrace";
import { undoRows, useRowUndo, type UndoKind } from "../sidebar/rows";

/** Focus in a text field of the app (not a terminal): ⌘Z / Ctrl+Shift+Z there is the field's own undo or redo. */
const inTextField = (el: Element | null): boolean =>
  !!el && (el.matches?.("input, [contenteditable], [contenteditable] *") || (el.tagName === "TEXTAREA" && !el.classList.contains("xterm-helper-textarea")));

/** Focus in the side menu, on a row that has marks, or on the toasts: where ⌘Z takes back a row's mark. */
export const inRows = (el: Element | null): boolean => !!el?.closest?.("nav.sb, [data-row-key], .ss-toasts");

const DONE: Record<UndoKind, Key> = { pin: "row.done.pin", snooze: "row.done.snooze", settle: "row.done.settle", archive: "row.done.archive" };

export function CloseToasts() {
  const s = getSessions();
  const list = useSyncExternalStore(s.onClosing, s.closing, s.closing);
  const rowUndo = useRowUndo();
  // one tick a second re-renders the countdown; the seconds are read from the clock at render
  const [, setTick] = useState(0);
  const any = list.length > 0;
  useEffect(() => {
    if (!any) return;
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(tick);
  }, [any]);
  const rows = rowUndo !== null;
  useEffect(() => {
    if (!any && !rows) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isUndoKey(e, isMac()) || inTextField(document.activeElement)) return;
      // a row's mark when the focus is among the rows; else the newest closed terminal
      if (!(rows && inRows(document.activeElement) && undoRows()) && !(any && getSessions().undoClose())) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [any, rows]);
  if ((!any && !rows) || typeof document === "undefined") return null;
  const now = Date.now();
  return createPortal(
    <div className="ss-toasts" role="status" aria-live="polite" data-testid="close-toasts">
      {rowUndo && (
        <div key={`row-${rowUndo.id}`} className="ss-toast" data-testid="row-undo-toast" data-kind={rowUndo.kind}>
          <span className="ss-toast-t" title={rowUndo.name}>
            {t(DONE[rowUndo.kind], { name: rowUndo.name })}
          </span>
          <button type="button" className="ss-toast-undo" onClick={() => undoRows()} data-testid="row-undo">
            {t("ss.undo")}
          </button>
        </div>
      )}
      {list.slice(0, GRACE_SHOWN - (rowUndo ? 1 : 0)).map((g) => {
        const left = Math.min(Math.ceil((g.until - g.closedAt) / 1000), Math.max(1, Math.ceil((g.until - now) / 1000)));
        return (
          <div key={g.id} className="ss-toast" data-testid={`close-toast-${g.id}`}>
            <span className="ss-toast-t" title={g.name}>
              {t("ss.closedToast", { name: g.name })}
            </span>
            <span className="ss-toast-s" data-testid="close-toast-left">
              {t("ss.closedLeft", { n: left })}
            </span>
            <button type="button" className="ss-toast-undo" onClick={() => getSessions().undoClose(g.id)} data-testid="close-toast-undo">
              {t("ss.undo")}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
