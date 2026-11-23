// History: every thread of the team, newest first, grouped by day (Today, Yesterday, then dates), each opening its
// thread, as the design canvas's History board lists them. The search box filters by title; history.ts holds the
// rules. The menu's Search button and ⌘K open this page with the box focused, through the store's `ui.findSeq`.
import { useEffect, useRef, useState, type RefObject } from "react";
import { hhmm } from "../app/time";
import { t, type Key } from "../i18n";
import { selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { rowStatus } from "../threads/ThreadTree";
import type { ThreadStatus } from "../threads/status";
import { MenuIcon, SearchGlyph } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";
import { byDay, fullDate, historyEntries, matchTitle } from "./history";

/** One thread as its row shows it. */
export interface HistoryRowView {
  key: string;
  bot: string;
  /** its title, or the untitled name a new thread shows */
  title: string;
  /** the member it belongs to */
  who: string;
  status: ThreadStatus;
  /** when it last did something ("09:20"); the day is in the band above it */
  time: string;
  open: () => void;
}

/** One day's band and its threads. */
export interface HistoryDayView {
  key: string;
  /** "Today", "Yesterday", or the date */
  label: string;
  /** the date written out beside Today and Yesterday; null when the label is the date */
  date: string | null;
  rows: HistoryRowView[];
}

/** The status words a row carries. An idle thread carries none: most threads are idle, and a word on every row would
 *  bury the ones that say something. */
const STATUS: Partial<Record<ThreadStatus, { word: Key; tag: string }>> = {
  running: { word: "thread.st.running", tag: "tag run" },
  needs_you: { word: "thread.st.needs", tag: "tag warn" },
  done: { word: "thread.st.done", tag: "tag ok" },
  failed: { word: "thread.st.failed", tag: "tag err" },
};

/** The days and rows for the threads in the store whose title holds `query`, each row opening its thread. */
export function historyDays(s: AppState & Actions, query: string, nowMs: number): HistoryDayView[] {
  const members = selectSidebarBots(s).map((b) => b.name);
  const names = new Map(s.bots.map((b) => [b.name, b.display_name]));
  const untitled = t("thread.untitled");
  return byDay(matchTitle(historyEntries(s.threads, members), query, untitled), nowMs).map((d) => ({
    key: String(d.day),
    label: d.when === "today" ? t("time.todayDay") : d.when === "yesterday" ? t("time.yesterday") : fullDate(d.day, nowMs),
    date: d.when === "earlier" ? null : fullDate(d.day, nowMs),
    rows: d.entries.map((e) => ({
      key: `${e.bot}:${e.row.thread}`,
      bot: e.bot,
      title: e.row.title || untitled,
      who: names.get(e.bot) ?? e.bot,
      status: rowStatus(s, e.bot, e.row),
      time: hhmm(new Date(e.ts * 1000)),
      open: () => void s.openThread(e.bot, e.row.thread),
    })),
  }));
}

export function HistoryView({
  days,
  query,
  hasThreads,
  onQuery,
  inputRef,
}: {
  days: HistoryDayView[];
  query: string;
  /** whether the team has any thread at all, so an empty list can say why it is empty */
  hasThreads: boolean;
  onQuery: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const find = (
    <div className="find" role="search">
      <SearchGlyph />
      <label className="vh" htmlFor="history-find">
        {t("history.find")}
      </label>
      <input
        ref={inputRef}
        id="history-find"
        type="search"
        placeholder={t("history.findPh")}
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          // Esc empties the box first, and an empty box leaves Esc to whatever else wants it.
          if (e.key !== "Escape" || !query) return;
          e.preventDefault();
          onQuery("");
        }}
        data-testid="history-find"
      />
    </div>
  );
  return (
    <MenuPageFrame page="history" title={t("menu.history")} acts={find}>
      <div className="pane">
        {days.length ? (
          days.map((d) => (
            <section key={d.key} className="day" aria-label={d.label}>
              <div className="band">
                <span>{d.label}</span>
                {d.date && <span>{d.date}</span>}
              </div>
              <ul className="rows">
                {d.rows.map((r) => {
                  const st = STATUS[r.status];
                  return (
                    <li key={r.key}>
                      <button type="button" className="rowl" onClick={r.open} data-testid="history-row">
                        <Avatar bot={r.bot} size={24} />
                        <span className="grow">{r.title}</span>
                        <span className="when">{r.who}</span>
                        {st && <span className={st.tag}>{t(st.word)}</span>}
                        <span className="when">{r.time}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ) : hasThreads ? (
          <p className="none" role="status" data-testid="history-none">
            {t("history.none", { q: query.trim() })}
          </p>
        ) : (
          <Empty icon={<MenuIcon row="history" />} title={t("history.emptyTitle")} text={t("history.emptyText")} testId="history-empty" />
        )}
      </div>
    </MenuPageFrame>
  );
}

/** The last Search press whose focus was given. A History page opened later from its menu row, with no new press,
 *  leaves the focus where it is. */
let focusedFind = 0;

export function HistoryPage() {
  const s = useStore();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLInputElement>(null);
  const find = s.ui.findSeq;
  useEffect(() => {
    if (find <= focusedFind) return;
    focusedFind = find;
    box.current?.focus();
    box.current?.select();
  }, [find]);
  const hasThreads = selectSidebarBots(s).some((b) => (s.threads[b.name]?.length ?? 0) > 0);
  return <HistoryView days={historyDays(s, query, Date.now())} query={query} hasThreads={hasThreads} onQuery={setQuery} inputRef={box} />;
}
