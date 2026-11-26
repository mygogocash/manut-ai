// "Add a note" by a selection (item 97). Text selected in one of this chat's answers, or in its lane's pane (the diff, the
// tests, a preview's text), brings a quiet button beside the end of the selection; the button, or ⌘⇧N (Ctrl+Shift+N
// elsewhere) from the keyboard, opens the kit's small popover with one field for the note. Add puts the selection and the note
// above the box as a chip (carry.ts); nothing is sent. The person's own messages, the box and any field are never a source.
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { isMac } from "../../app/shortcuts";
import { composing } from "../../lib/ime";
import { Popover } from "../../ui";
import { carry, noteChip, QUOTE_MAX, type Scope } from "./carry";
import "../cards/cards.css";
import "./carry.css";

/** Where text may be noted: an answer's text, or what a lane's pane marks as a source. */
export const NOTE_SOURCES = ".msg.a .b, [data-note-source]";

/** ⌘⇧N on a Mac, Ctrl+Shift+N elsewhere: by where the key stands, so a non-Latin layout has it too. */
export const isNoteKey = (e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean =>
  (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && e.shiftKey && !e.altKey && (e.code === "KeyN" || e.key.toLowerCase() === "n");

interface Picked {
  text: string;
  /** Where the selection ends on screen: the button and the popover sit just under it. */
  x: number;
  y: number;
}

/** The selection now, when it lies inside one source within `root`; null otherwise. */
export function pickedIn(root: HTMLElement | null, sel: Selection | null): Picked | null {
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!el || !root.contains(el) || !el.closest(NOTE_SOURCES)) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const rects = range.getClientRects();
  const end = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  return { text, x: end.right, y: end.bottom };
}

export function SelectionNote({ chatKey, scope, box, onDone }: { chatKey: string; scope: Scope; box: RefObject<HTMLElement | null>; onDone?: () => void }) {
  const [sel, setSel] = useState<Picked | null>(null);
  const [open, setOpen] = useState<Picked | null>(null);
  const [note, setNote] = useState("");
  const [full, setFull] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // the chat and, for a lane, the pane beside it: the selection must be in there
  const root = () => box.current?.closest<HTMLElement>(".ss-lane-body") ?? box.current?.closest<HTMLElement>(".pane") ?? null;
  const rootRef = useRef(root);
  rootRef.current = root;
  const openRef = useRef(open);
  openRef.current = open;
  const selRef = useRef(sel);
  selRef.current = sel;

  const start = (p: Picked) => {
    setOpen(p);
    setNote("");
    setFull(false);
  };

  useEffect(() => {
    const onSel = () => setSel(pickedIn(rootRef.current(), document.getSelection()));
    const onKey = (e: KeyboardEvent) => {
      if (composing(e) || !isNoteKey(e, isMac()) || openRef.current) return;
      const p = selRef.current ?? pickedIn(rootRef.current(), document.getSelection());
      if (!p) return;
      e.preventDefault();
      start(p);
    };
    document.addEventListener("selectionchange", onSel);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const close = (focusBox: boolean) => {
    setOpen(null);
    if (focusBox) onDone?.();
  };
  const add = () => {
    if (!open) return;
    const chip = noteChip(open.text, note, scope);
    if (!chip) return close(true);
    if (carry(chatKey, chip) === "notes") return setFull(true);
    document.getSelection()?.removeAllRanges();
    setSel(null);
    close(true);
  };

  const at = open ?? sel;
  if (!at) return null;
  // kept inside the window: the popover is 280px wide
  const left = Math.max(8, Math.min(at.x - 12, window.innerWidth - 296));
  const top = Math.min(at.y + 6, window.innerHeight - 48);
  return createPortal(
    <div className="sn-at" style={{ left, top }} data-testid="note-at">
      {!open && (
        <button
          ref={trigger}
          type="button"
          className="sn-add"
          title={t("carry.addTip", { key: isMac() ? "⌘⇧N" : "Ctrl+Shift+N" })}
          // pressing it must not drop the selection it is for
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => sel && start(sel)}
          data-testid="note-add"
        >
          {t("carry.add")}
        </button>
      )}
      <Popover open={!!open} onClose={(why) => close(why === "escape")} side="bottom" align="left" width={280} label={t("carry.add")} className="sn-pop">
        <form
          className="sn-form"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          data-testid="note-pop"
        >
          <input
            className="sn-field"
            autoFocus
            value={note}
            maxLength={500}
            placeholder={t("carry.notePlaceholder")}
            aria-label={t("carry.noteAria")}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Enter in a field whose words are still being composed (Japanese, Korean) finishes the word, not the note
              if (e.key === "Enter" && composing(e)) e.preventDefault();
              // Esc closes the note and nothing else (never a running answer's Stop, app/shortcuts.ts)
              if (e.key === "Escape" && !composing(e)) {
                e.preventDefault();
                close(true);
              }
            }}
            data-testid="note-field"
          />
          <p className="sn-line">{t("carry.what")}</p>
          {open && open.text.length > QUOTE_MAX && (
            <p className="sn-line" data-testid="note-long">
              {t("carry.long", { max: QUOTE_MAX.toLocaleString("en-US") })}
            </p>
          )}
          {full && (
            <p className="sn-line sn-full" role="alert" data-testid="note-full">
              {t("carry.full")}
            </p>
          )}
          <div className="sn-row">
            <button type="submit" className="card-btn" data-testid="note-save">
              {t("carry.save")}
            </button>
          </div>
        </form>
      </Popover>
    </div>,
    document.body,
  );
}
