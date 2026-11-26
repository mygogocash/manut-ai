// The menu of what a person can do to a row (item 76): Pin, Snooze, Done for now and Archive, in the one place a row keeps its
// choices, so no row grows a button for each. A chat (Recent, History) and a lane (the Code page's Lanes band) have all four; a
// terminal session has Pin and Done for now, since a terminal has no conversation to put away. The rules are in rows.ts.
//
// Snooze (item 94) offers an hour, tomorrow morning and next week, then "Until it finishes" for a row whose turn runs, and a time
// the person picks in a date and a time field, the design canvas's form parts (KitForms).
//
// It opens from a quiet "more" button on the row and from the right-click that a terminal's row already answers. The menu is
// placed at a point inside the window and is the same `row-menu` the sessions' own menu uses.
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { t, type Key } from "../i18n";
import { MenuIcon } from "../ui/MenuIcon";
import type { IconName } from "../ui/icons";
import { clearSelection } from "./selection";
import { actOnRows, dayField, pickedTime, SNOOZES, snoozeUntil, timeField, type RowAction, type RowMark } from "./rows";

export type RowKind = "chat" | "lane" | "terminal";

/** What a row's menu offers, in order, for a row of `kind` with `mark`. "snooze" opens the three plain choices. */
export type RowChoice = "pin" | "unpin" | "snooze" | "settle" | "wake" | "archive" | "restore";

export function rowChoices(kind: RowKind, mark: RowMark | undefined): RowChoice[] {
  if (mark?.archived !== undefined) return ["restore"];
  const away = mark?.snoozed !== undefined || mark?.untilDone !== undefined || mark?.settled === true;
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

/** Each choice's icon of the set (item 122: every menu led by an icon). */
export const CHOICE_ICON: Record<RowChoice, IconName> = {
  pin: "pin",
  unpin: "pin-off",
  snooze: "clock",
  settle: "check",
  wake: "rotate-ccw",
  archive: "archive",
  restore: "rotate-ccw",
};

/** The snooze step's icons: back, the three fixed times, until it finishes and a picked time. */
export const SNOOZE_ICON: Record<"back" | "hour" | "tomorrow" | "week" | "done" | "pick", IconName> = {
  back: "chevron-left",
  hour: "clock",
  tomorrow: "calendar",
  week: "calendar",
  done: "check",
  pick: "pencil",
};

const ACTION: Partial<Record<RowChoice, RowAction>> = {
  pin: { do: "pin" },
  unpin: { do: "unpin" },
  settle: { do: "settle" },
  wake: { do: "wake" },
  archive: { do: "archive" },
  restore: { do: "restore" },
};

/** The menu's size, to keep it inside the window: 168 wide, or the widest word (an editor's name) up to about 260, 34 per row
 *  (the canvas's menu row, item 122) plus its padding. */
const W = 260;
const height = (rows: number) => rows * 34 + 10;

/** Where a menu of `rows` rows opens for a pointer or a button at (`x`, `y`): inside the window. */
export function menuAt(x: number, y: number, rows = 5): { x: number; y: number } {
  return { x: Math.max(6, Math.min(x, window.innerWidth - W - 6)), y: Math.max(6, Math.min(y, window.innerHeight - height(rows) - 6)) };
}

/** Why a row settled by itself, in the words its quiet second line shows ("Done after 3 quiet days", "Done: its pull request
 *  merged"), or null for a row the person settled or one not settled (item 94). */
export function settledWhy(mark: RowMark | undefined): string | null {
  if (!mark?.settled || !mark.why) return null;
  if (mark.why === "merged") return t("row.why.merged");
  return mark.days === 1 ? t("row.why.quiet1") : t("row.why.quiet", { n: mark.days ?? 0 });
}

/** The snooze step's choices after the three fixed times: until the turn ends (only for a row whose turn runs) and a picked time. */
export function snoozeChoices(working: boolean): ("done" | "pick")[] {
  return working ? ["done", "pick"] : ["pick"];
}

/** The date and time a picked snooze starts at: the next whole hour from `now`, on this computer's clock. */
export function pickStart(now: number): { date: string; time: string } {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return { date: dayField(d), time: timeField(d) };
}

/** `onDismiss(back)`: the menu closes; `back` when it closed by a choice or Escape, so the focus goes back to the row (where ⌘Z undoes
 *  what was just done), and not when the person clicked somewhere else. `working`: the row's turn runs, so Snooze also offers
 *  "Until it finishes". `extra`: more rows after the choices, given a function that closes the menu. `keys`: several selected rows the menu acts on at once (item 94), which `name` then counts. */
export function RowMenu({ rowKey, kind, mark, name, at, onDismiss, extra, working = false, keys }: { rowKey: string; kind: RowKind; mark: RowMark | undefined; name: string; at: { x: number; y: number }; onDismiss: (back?: boolean) => void; extra?: ReactNode | ((done: () => void) => ReactNode); working?: boolean; keys?: readonly string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<"main" | "snooze" | "pick">("main");
  const [pick, setPick] = useState(() => pickStart(Date.now()));
  const [late, setLate] = useState(false);
  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onDismiss]);
  // the first item takes focus again when the menu changes step (the date field, when picking a time)
  useEffect(() => void ref.current?.querySelector<HTMLElement>(step === "pick" ? "input" : "button")?.focus(), [step]);
  const many = keys && keys.length > 1 ? keys : null;
  const done = (a: RowAction) => {
    actOnRows(many ?? [rowKey], a, name);
    // the rows acted on have moved: the selection has done its work
    if (many) clearSelection();
    onDismiss(true);
  };
  const choices: RowChoice[] = many ? ["pin", "snooze", "settle", "archive"] : rowChoices(kind, mark);
  return (
    <div
      ref={ref}
      className={`row-menu${step === "pick" ? " picking" : ""}`}
      style={{ left: at.x, top: at.y }}
      role="menu"
      aria-label={t("row.more", { name })}
      data-testid="row-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss(true);
          return;
        }
        // a date or time field moves its own value with the arrows
        if ((e.target as HTMLElement).tagName === "INPUT") return;
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const to = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 + btns.length : e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        btns[to % btns.length]?.focus();
      }}
    >
      {step === "pick" ? (
        <form
          className="row-pick"
          data-testid="row-pick"
          // the app says why a time is refused, in its own words, rather than the browser's bubble
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const at = pickedTime(pick.date, pick.time, Date.now());
            if (at === null) setLate(true);
            else done({ do: "snooze", until: at });
          }}
        >
          <label htmlFor="row-pick-date">{t("row.pick.date")}</label>
          <input id="row-pick-date" type="date" value={pick.date} min={dayField(new Date())} onChange={(e) => (setPick({ ...pick, date: e.target.value }), setLate(false))} data-testid="row-pick-date" />
          <label htmlFor="row-pick-time">{t("row.pick.time")}</label>
          <input id="row-pick-time" type="time" value={pick.time} onChange={(e) => (setPick({ ...pick, time: e.target.value }), setLate(false))} data-testid="row-pick-time" />
          {late && (
            <span className="row-pick-err" role="alert" data-testid="row-pick-late">
              {t("row.pick.late")}
            </span>
          )}
          <button type="submit" role="menuitem" className="row-mi" data-testid="row-pick-go">
            <MenuIcon name={CHOICE_ICON.snooze} />
            {t("row.snooze")}
          </button>
          <button type="button" role="menuitem" className="row-mi" onClick={() => setStep("snooze")} data-testid="row-pick-back">
            <MenuIcon name={SNOOZE_ICON.back} />
            {t("row.snooze.back")}
          </button>
        </form>
      ) : step === "snooze" ? (
        <>
          <button type="button" role="menuitem" className="row-mi" onClick={() => setStep("main")} data-testid="row-snooze-back">
            <MenuIcon name={SNOOZE_ICON.back} />
            {t("row.snooze.back")}
          </button>
          {SNOOZES.map((id) => (
            <button key={id} type="button" role="menuitem" className="row-mi" onClick={() => done({ do: "snooze", until: snoozeUntil(id, Date.now()) })} data-testid={`row-snooze-${id}`}>
              <MenuIcon name={SNOOZE_ICON[id]} />
              {t(`row.snooze.${id}` as Key)}
            </button>
          ))}
          {snoozeChoices(working && !many).map((c) =>
            c === "done" ? (
              <button key={c} type="button" role="menuitem" className="row-mi" title={t("row.snooze.doneTip")} onClick={() => done({ do: "snoozeTurn" })} data-testid="row-snooze-done">
                <MenuIcon name={SNOOZE_ICON.done} />
                {t("row.snooze.done")}
              </button>
            ) : (
              <button key={c} type="button" role="menuitem" className="row-mi" onClick={() => setStep("pick")} data-testid="row-snooze-pick">
                <MenuIcon name={SNOOZE_ICON.pick} />
                {t("row.snooze.pick")}
              </button>
            ),
          )}
        </>
      ) : (
        <>
          {choices.map((c) => (
            <button key={c} type="button" role="menuitem" className="row-mi" onClick={() => (c === "snooze" ? setStep("snooze") : done(ACTION[c]!))} data-testid={`row-${c}`}>
              <MenuIcon name={CHOICE_ICON[c]} />
              {t(LABEL[c])}
            </button>
          ))}
          {!many && (typeof extra === "function" ? extra(() => onDismiss(true)) : extra)}
        </>
      )}
    </div>
  );
}

/** A row's menu state: `open(x, y)` shows it, `menu` is the element to draw inside the row, `onContextMenu` opens it at the pointer. */
export function useRowMenu(props: { rowKey: string; kind: RowKind; mark: RowMark | undefined; name: string; working?: boolean; keys?: readonly string[]; extra?: ReactNode | ((done: () => void) => ReactNode) }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // what had the focus when the menu opened (its "more" button), or the row a right-click opened it on: where the focus goes back
  const opener = useRef<HTMLElement | null>(null);
  const close = useCallback((back?: boolean) => {
    setAt(null);
    const el = opener.current;
    opener.current = null;
    if (!back || !el?.isConnected) return;
    // a row moves as it is pinned or settled, but it is the same element: focusing it keeps ⌘Z on it
    (el.matches("button, [tabindex]") ? el : el.querySelector<HTMLElement>("button"))?.focus();
  }, []);
  const open = (x: number, y: number, from?: HTMLElement | null) => {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    opener.current = from ?? (active instanceof HTMLElement && active !== document.body ? active : null);
    // the snooze step is the longest: Back, three times, until it finishes and a picked time
    setAt(menuAt(x, y, Math.max(rowChoices(props.kind, props.mark).length + (props.extra ? 1 : 0), 6)));
  };
  const menu = at ? <RowMenu {...props} at={at} onDismiss={close} /> : null;
  const onContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    open(e.clientX, e.clientY, e.currentTarget);
  };
  return { open, menu, onContextMenu, isOpen: at !== null };
}

/** The quiet "more" button a row ends with: shown on hover and focus by the row's own style, it opens the row's menu under it. */
export function MoreButton({ name, onOpen, className = "row-more" }: { name: string; onOpen: (x: number, y: number, from?: HTMLElement) => void; className?: string }) {
  return (
    <button
      type="button"
      className={className}
      aria-label={t("row.more", { name })}
      title={t("row.more", { name })}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        // the button itself is where the focus goes back (a click does not focus a button in WebKit)
        onOpen(r.left, r.bottom + 2, e.currentTarget);
      }}
      data-testid="row-more"
    >
      <span aria-hidden="true">⋯</span>
    </button>
  );
}
