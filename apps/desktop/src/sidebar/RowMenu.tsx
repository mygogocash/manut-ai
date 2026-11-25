// The menu of what a person can do to a row (item 76): Pin, Snooze, Done for now and Archive, in the one place a row keeps its
// choices, so no row grows a button for each. A chat (Recent, History) and a lane (the Code page's Lanes band) have all four; a
// terminal session has Pin and Done for now, since a terminal has no conversation to put away. The rules are in rows.ts.
//
// It opens from a quiet "more" button on the row and from the right-click that a terminal's row already answers. The menu is
// placed at a point inside the window and is the same `row-menu` the sessions' own menu uses.
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { t, type Key } from "../i18n";
import { markRow, SNOOZES, snoozeUntil, type RowAction, type RowMark } from "./rows";

export type RowKind = "chat" | "lane" | "terminal";

/** What a row's menu offers, in order, for a row of `kind` with `mark`. "snooze" opens the three plain choices. */
export type RowChoice = "pin" | "unpin" | "snooze" | "settle" | "wake" | "archive" | "restore";

export function rowChoices(kind: RowKind, mark: RowMark | undefined): RowChoice[] {
  if (mark?.archived !== undefined) return ["restore"];
  const away = mark?.snoozed !== undefined || mark?.settled === true;
  return [mark?.pinned !== undefined ? "unpin" : "pin", ...(kind === "terminal" ? [] : (["snooze"] as const)), away ? "wake" : "settle", ...(kind === "terminal" ? [] : (["archive"] as const))];
}

const LABEL: Record<RowChoice, Key> = {
  pin: "row.pin",
  unpin: "row.unpin",
  snooze: "row.snooze",
  settle: "row.settle",
  wake: "row.wake",
  archive: "row.archive",
  restore: "row.restore",
};

const ACTION: Partial<Record<RowChoice, RowAction>> = {
  pin: { do: "pin" },
  unpin: { do: "unpin" },
  settle: { do: "settle" },
  wake: { do: "wake" },
  archive: { do: "archive" },
  restore: { do: "restore" },
};

/** The menu's size, to keep it inside the window: 168 wide, 26 per row plus its padding. */
const W = 168;
const height = (rows: number) => rows * 26 + 14;

/** Where a menu of `rows` rows opens for a pointer or a button at (`x`, `y`): inside the window. */
export function menuAt(x: number, y: number, rows = 5): { x: number; y: number } {
  return { x: Math.max(6, Math.min(x, window.innerWidth - W - 6)), y: Math.max(6, Math.min(y, window.innerHeight - height(rows) - 6)) };
}

export function RowMenu({ rowKey, kind, mark, name, at, onDismiss, extra }: { rowKey: string; kind: RowKind; mark: RowMark | undefined; name: string; at: { x: number; y: number }; onDismiss: () => void; extra?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [snoozing, setSnoozing] = useState(false);
  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onDismiss]);
  // the first item takes focus again when the menu changes step
  useEffect(() => void ref.current?.querySelector<HTMLButtonElement>("button")?.focus(), [snoozing]);
  const done = (a: RowAction) => {
    markRow(rowKey, a);
    onDismiss();
  };
  return (
    <div
      ref={ref}
      className="row-menu"
      style={{ left: at.x, top: at.y }}
      role="menu"
      aria-label={t("row.more", { name })}
      data-testid="row-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
          return;
        }
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 + btns.length : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        btns[to % btns.length]?.focus();
      }}
    >
      {snoozing ? (
        <>
          <button type="button" role="menuitem" className="row-mi" onClick={() => setSnoozing(false)} data-testid="row-snooze-back">
            {t("row.snooze.back")}
          </button>
          {SNOOZES.map((id) => (
            <button key={id} type="button" role="menuitem" className="row-mi" onClick={() => done({ do: "snooze", until: snoozeUntil(id, Date.now()) })} data-testid={`row-snooze-${id}`}>
              {t(`row.snooze.${id}` as Key)}
            </button>
          ))}
        </>
      ) : (
        <>
          {rowChoices(kind, mark).map((c) => (
            <button key={c} type="button" role="menuitem" className="row-mi" onClick={() => (c === "snooze" ? setSnoozing(true) : done(ACTION[c]!))} data-testid={`row-${c}`}>
              {t(LABEL[c])}
            </button>
          ))}
          {extra}
        </>
      )}
    </div>
  );
}

/** A row's menu state: `open(x, y)` shows it, `menu` is the element to draw inside the row, `onContextMenu` opens it at the pointer. */
export function useRowMenu(props: { rowKey: string; kind: RowKind; mark: RowMark | undefined; name: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAt(null), []);
  const open = (x: number, y: number) => setAt(menuAt(x, y, rowChoices(props.kind, props.mark).length));
  const menu = at ? <RowMenu {...props} at={at} onDismiss={close} /> : null;
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    open(e.clientX, e.clientY);
  };
  return { open, menu, onContextMenu, isOpen: at !== null };
}

/** The quiet "more" button a row ends with: shown on hover and focus by the row's own style, it opens the row's menu under it. */
export function MoreButton({ name, onOpen, className = "row-more" }: { name: string; onOpen: (x: number, y: number) => void; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      aria-label={t("row.more", { name })}
      title={t("row.more", { name })}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(r.left, r.bottom + 2);
      }}
      data-testid="row-more"
    >
      <span aria-hidden="true">⋯</span>
    </button>
  );
}
