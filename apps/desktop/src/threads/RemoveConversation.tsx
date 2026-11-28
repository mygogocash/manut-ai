// Remove, on a conversation with Buddy (item 102l-6): the entry a conversation's row menu ends with (`removeEntry`), and the question it
// opens (`RemoveConversation`, drawn once over whatever is showing). A removal deletes the conversation and every message in it for
// good, so the entry only asks: the question names the conversation, says that, and offers Cancel (which holds the focus, as Forget's
// "Keep it" does) and the destructive button. The rules, and what each press sends, are removeAsk.ts's.
//
// It is a small modal like the update confirm (sidebar/UpdateConfirm.tsx): focus stays inside, Tab goes round, Escape cancels. Nothing
// moves: an ask appears and stays still (docs/motion.md).
import "./remove.css";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { getStore } from "../state/store";
import { MenuIcon } from "../ui/MenuIcon";
import { RemoveAsk, type ConversationRef, type RemoveState } from "./removeAsk";

/** The app's one question: its removal is the store's, which forgets the conversation's chat and row once the runtime has removed it. */
export const removeAsk = new RemoveAsk((bot, thread) => getStore().actions.removeThread(bot, thread));

/** Remove, as the last entry of a conversation's row menu, set apart by a line: for `useRowMenu`'s `extra`. It closes the menu and opens
 *  the question about `ref`, and sends nothing. */
export function removeEntry(ref: ConversationRef): (done: () => void) => ReactNode {
  return (done) => (
    <>
      <div className="row-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="row-mi danger"
        onClick={() => {
          done();
          removeAsk.ask(ref);
        }}
        data-testid="row-remove"
      >
        <MenuIcon name="trash" />
        {t("row.removeChat")}
      </button>
    </>
  );
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The question: the conversation's name, what a removal does, and the two presses. `error` is why the last press did not remove it. */
export function RemoveConversationView({ state, onCancel, onConfirm }: { state: RemoveState; onCancel: () => void; onConfirm: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const { asked, busy, error } = state;
  useEffect(() => {
    // the safe answer holds the focus, and the focus goes back to where it was (the row's "more" button) when the question closes
    const back = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onFocus = (e: FocusEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) box.current.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      const at = document.activeElement;
      const inside = !!at && box.current.contains(at);
      if (e.shiftKey && (at === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", onFocus);
    // capture: ahead of the app's own Esc and any popover under the veil
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus();
    };
  }, []);
  if (!asked) return null;
  return (
    <div className="rm-veil" data-testid="remove-veil" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={box} className="rm-dlg" role="alertdialog" aria-modal="true" aria-labelledby="rm-t" aria-describedby="rm-b" aria-busy={busy || undefined} data-testid="remove-conversation">
        <h2 id="rm-t" className="rm-t" data-testid="remove-title">
          {t("thread.chatRemoveTitle", { title: asked.title || t("thread.untitled") })}
        </h2>
        <p id="rm-b" className="rm-b" data-testid="remove-body">
          {t("thread.chatRemoveBody")}
        </p>
        {error && (
          <p className="rm-err" role="alert" data-testid="remove-error">
            {error}
          </p>
        )}
        <div className="rm-f">
          {/* aria-disabled, not disabled, while the removal is on its way, so the focus stays where the person put it */}
          <button type="button" className="rm-btn" aria-disabled={busy || undefined} onClick={onCancel} data-autofocus data-testid="remove-cancel">
            {t("thread.cancel")}
          </button>
          <button type="button" className="rm-btn danger" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={onConfirm} data-testid="remove-yes">
            {t("thread.chatRemoveYes")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The question, over whatever is showing, while it is open. */
export function RemoveConversation() {
  const state = useSyncExternalStore(removeAsk.subscribe, removeAsk.get, removeAsk.get);
  if (!state.asked) return null;
  return createPortal(<RemoveConversationView state={state} onCancel={() => removeAsk.cancel()} onConfirm={() => void removeAsk.confirm()} />, document.body);
}
