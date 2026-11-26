// The command palette (item 77a): the box ⌘K opens. A text field over a short list of where to go, what to do and what was
// said before, in the look of the app's other popovers. `PaletteView` draws a given list so tests can draw any state;
// `Palette` keeps the typing and the cursor and acts. Picking a row closes the palette, gives the focus back to where it
// was, and then does the one thing the row says: open a page, or press what a button elsewhere presses.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import "./palette.css";
import { t, type Key } from "../i18n";
import { composing } from "../lib/ime";
import { getStore, selectSidebarBots, useStore } from "../state/store";
import { homeBot } from "../sidebar/menu";
import { peopleOffered } from "../pages/PeoplePane";
import { historyDays } from "../pages/HistoryPage";
import { useJobList } from "../pages/RecentWork";
import { openNewSessionMenu } from "../sessions/newMenu";
import { closePalette, usePaletteOpen } from "./state";
import { useLeaving } from "../ui/leave";
import { getWorkflows, useWorkflows } from "../workflows/runner";
import { standingOf } from "../workflows/allow";
import { useWorkflowSettings } from "../workflows/settings";
import { usePlaces } from "./places";
import { useEditorChoice } from "../code/editor";
import { getHost } from "../sessions/host";
import { keyResult } from "./filter";
import { buildGroups, flat, type Group } from "./groups";
import type { PaletteCtx, Row } from "./registry";
import { Icon } from "../ui/icons";

const LIST_ID = "palette-list";
const optionId = (i: number) => `palette-opt-${i}`;

export interface PaletteViewProps {
  query: string;
  onQuery: (q: string) => void;
  groups: Group[];
  cursor: number;
  onPick: (row: Row) => void;
  onHover: (i: number) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onBackdrop: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Closed and fading out (ui/leave.ts): drawn inert, so nothing in it takes a key or a press. */
  leaving?: boolean;
}

/** Whether a mouse move is the person's: the browser also sends a move, at the same place, when the list changes under a
 *  pointer that is resting, and that must not move the cursor while they type (Enter would then open another row). */
export function pointerMoved(last: { x: number; y: number } | null, x: number, y: number): boolean {
  return last !== null && (last.x !== x || last.y !== y);
}

export function PaletteView(p: PaletteViewProps) {
  let at = -1;
  const total = flat(p.groups).length;
  // where the pointer was at its last move over the list (none yet: the first move only notes it)
  const pointer = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className="pal-back"
      onMouseDown={(e) => e.target === e.currentTarget && p.onBackdrop()}
      data-testid="palette-backdrop"
      {...(p.leaving ? { "data-leaving": "", inert: true, "aria-hidden": true } : {})}
    >
      <div className="pal" role="dialog" aria-modal="true" aria-label={t("pal.title")} onKeyDown={p.onKeyDown} data-testid="palette">
        {/* The canvas's Search board: the magnifier, the field, and Esc to say how it closes. */}
        <div className="pal-s">
        <Icon name="search" />
        <input
          ref={p.inputRef}
          className="pal-in"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-activedescendant={total ? optionId(p.cursor) : undefined}
          aria-label={t("pal.title")}
          placeholder={t("pal.ph")}
          value={p.query}
          onChange={(e) => p.onQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          data-testid="palette-input"
        />
        <span className="pal-kbd" aria-hidden="true">
          Esc
        </span>
        </div>
        <ul className="pal-list" id={LIST_ID} role="listbox" aria-label={t("pal.title")} data-testid="palette-list">
          {p.groups.map((g) => (
            <li key={g.key} role="presentation" className="pal-g" data-testid={`palette-group-${g.key}`}>
              {g.heading && <div className="pal-h">{t(g.heading as Key)}</div>}
              <ul role="presentation">
                {g.rows.map((r) => {
                  at += 1;
                  const i = at;
                  return (
                    <li
                      key={r.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === p.cursor}
                      className={`pal-row${i === p.cursor ? " on" : ""}`}
                      // the mouse never takes the focus off the field
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={(e) => {
                        const moved = pointerMoved(pointer.current, e.clientX, e.clientY);
                        pointer.current = { x: e.clientX, y: e.clientY };
                        if (moved && i !== p.cursor) p.onHover(i);
                      }}
                      onClick={() => p.onPick(r)}
                      data-testid="palette-row"
                      data-row={r.id}
                    >
                      <Icon name={r.icon ?? g.icon} />
                      <span className="pal-n">{r.label}</span>
                      {r.hint && <span className="pal-sub">{r.hint}</span>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {total === 0 && (
            <li role="presentation" className="pal-none" data-testid="palette-none">
              {t("pal.none")}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function OpenPalette({ leaving }: { leaving: boolean }) {
  const s = useStore();
  const places = usePlaces();
  const editor = useEditorChoice(getHost());
  const { jobs } = useJobList();
  const wf = useWorkflows();
  const wfOn = useWorkflowSettings().on;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const groups = useMemo(() => {
    const listed = selectSidebarBots(s);
    const lead = homeBot(s.bots, listed.map((b) => b.name));
    const leadBot = s.bots.find((b) => b.name === lead);
    const ctx: PaletteCtx = {
      lang: s.ui.lang,
      bots: listed.map((b) => ({ name: b.name, displayName: b.display_name })),
      // a new thread needs a member the runtime can reach that does not run on another computer, as the Team page's menu does
      buddy: leadBot && leadBot.status !== "offline" && !leadBot.host ? { name: leadBot.name, displayName: leadBot.display_name } : null,
      people: peopleOffered(),
      places,
      editor,
      openPage: (page) => s.openPage(page),
      openHistory: (q) => s.openPage("history", { find: true, query: q }),
      openSettings: (page) => s.openSettings(page),
      newThread: (bot) => void s.newThread(bot),
      setLanguage: (lang) => s.setLanguage(lang),
      // the + menu lives on the Code page: away from it that page opens first, as ⌘N does
      openNewSessionMenu: () => {
        if (getStore().getState().ui.view !== "code") s.openPage("code");
        openNewSessionMenu();
      },
      // what Settings › Workflows offers Run now for: none while Workflows is off, a file that is no workflow, one the person has
      // not allowed as it is now (item 91), or a run going
      workflows: wfOn ? wf.files.flatMap((f) => ("workflow" in f && !wf.live[f.file] && standingOf(f.workflow, wf.allowed) === "allowed" ? [{ file: f.file, name: f.workflow.name }] : [])) : [],
      // the Run now on its page: the page opens, so the run is seen starting where its button is
      runWorkflow: (file) => {
        s.openSettings("workflows");
        void getWorkflows().runNow(file);
      },
    };
    // what History's own search finds for the same words: the same rows, so nothing is lost
    const chats: Row[] = query.trim()
      ? historyDays(s, query, Date.now(), jobs).flatMap((d) => d.rows).map((r) => ({ id: `chat:${r.key}`, label: r.title, hint: r.who, run: r.open }))
      : [];
    return buildGroups(ctx, query, chats);
    // the store's state is the whole of what these rows read
  }, [s, places, editor, jobs, query, wf, wfOn]);
  const rows = flat(groups);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));

  const pick = (row: Row | undefined) => {
    if (!row) return;
    // the focus goes back first, so what the row opens may take it
    closePalette();
    row.run();
  };
  // the row under the cursor stays in view while the arrows move
  useEffect(() => {
    document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  return (
    <PaletteView
      query={query}
      onQuery={(q) => {
        setQuery(q);
        setCursor(0);
      }}
      groups={groups}
      cursor={at}
      onPick={pick}
      onHover={setCursor}
      onBackdrop={() => closePalette()}
      inputRef={input}
      leaving={leaving}
      onKeyDown={(e) => {
        if (e.key === "Tab") {
          // the palette is a modal: the focus stays in its field
          e.preventDefault();
          return;
        }
        // an input method's own keys (its candidate list, its Enter) are not the palette's
        if (composing(e)) return;
        const r = keyResult(e.key, { cursor: at, count: rows.length, composing: false });
        if (r.do === "none" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        e.stopPropagation();
        if (r.do === "close") closePalette();
        else if (r.do === "pick") pick(rows[at]);
        else setCursor(r.cursor);
      }}
    />
  );
}

/** Mounted once by the app: draws nothing until ⌘K or the menu's Search opens it. Once closed it fades out where it
 *  stands, faster than it came (ui/leave.ts); opened again meanwhile, it starts afresh. */
export function Palette() {
  const { drawn, leaving, opened } = useLeaving(usePaletteOpen());
  return drawn ? <OpenPalette key={opened} leaving={leaving} /> : null;
}
