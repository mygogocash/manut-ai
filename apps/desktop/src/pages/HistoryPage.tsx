// History: every thread of the team, newest first, grouped by day (Today, Yesterday, then dates), each opening its
// thread, as the design canvas's History board lists them. The search box filters by title; history.ts holds the
// rules. The menu's Search button and ⌘K open this page with the box focused, through the store's `ui.findSeq`.
import { useEffect, useRef, useState, type RefObject } from "react";
import { hhmm } from "../app/time";
import { t, type Key } from "../i18n";
import type { JobRow } from "../runtime/mission";
import { selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { rowStatus } from "../threads/ThreadTree";
import type { ThreadStatus } from "../threads/status";
import { MenuIcon, SearchGlyph } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";
import { byDay, dayBand, historyEntries, matchTitle } from "./history";
import { stageTag } from "./job";
import { useJobs } from "./RecentWork";

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
  /** "job": a job of the team (its page opens), not a thread. Its tag is its stage's, not a thread's status. */
  kind?: "job";
  tag?: { word: Key; cls: string };
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

/** The days and rows for the threads in the store whose title holds `query`, each opening its thread, and for the runtime's
 *  jobs whose title holds it, each opening its page; threads and jobs are one list, newest first, as the canvas's History
 *  lists them. */
export function historyDays(s: AppState & Actions, query: string, nowMs: number, jobs: readonly JobRow[] = []): HistoryDayView[] {
  const members = selectSidebarBots(s).map((b) => b.name);
  const names = new Map(s.bots.map((b) => [b.name, b.display_name]));
  const untitled = t("thread.untitled");
  const q = query.trim().toLowerCase();
  const threads = matchTitle(historyEntries(s.threads, members), query, untitled).map((e) => ({
    ts: e.ts,
    row: {
      key: `${e.bot}:${e.row.thread}`,
      bot: e.bot,
      title: e.row.title || untitled,
      who: names.get(e.bot) ?? e.bot,
      status: rowStatus(s, e.bot, e.row),
      time: hhmm(new Date(e.ts * 1000)),
      open: () => void s.openThread(e.bot, e.row.thread),
    } satisfies HistoryRowView,
  }));
  const work = jobs
    .filter((j) => !q || j.title.toLowerCase().includes(q))
    .map((j) => ({
      ts: j.at,
      row: {
        key: `job:${j.id}`,
        bot: j.bot,
        title: j.title,
        who: names.get(j.bot) ?? j.bot,
        status: "idle" as const,
        time: hhmm(new Date(j.at * 1000)),
        open: () => s.openJob(j.id),
        kind: "job" as const,
        tag: stageTag(j.stage),
      } satisfies HistoryRowView,
    }));
  // The sort is stable, so a thread and a job of the same moment keep the threads first.
  return byDay([...threads, ...work].sort((a, b) => b.ts - a.ts), nowMs).map((d) => {
    const band = dayBand(d, nowMs);
    return { key: String(d.day), label: band.label, date: band.date, rows: d.entries.map((x) => x.row) };
  });
}

export function HistoryView({
  days,
  query,
  hasThreads,
  onQuery,
  inputRef,
  onActivity,
}: {
  days: HistoryDayView[];
  query: string;
  /** whether the team has any thread or job at all, so an empty list can say why it is empty */
  hasThreads: boolean;
  onQuery: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** opens the activity log, History's second view; the button is not drawn without it */
  onActivity?: () => void;
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
  const acts = (
    <>
      {onActivity && (
        <button type="button" className="btn" onClick={onActivity} data-testid="history-activity">
          {t("act.title")}
        </button>
      )}
      {find}
    </>
  );
  return (
    <MenuPageFrame page="history" title={t("menu.history")} acts={acts}>
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
                  const st = r.tag ? { word: r.tag.word, tag: r.tag.cls } : STATUS[r.status];
                  return (
                    <li key={r.key}>
                      <button type="button" className="rowl" onClick={r.open} data-testid="history-row">
                        <Avatar bot={r.bot} size={24} />
                        <span className="grow">{r.title}</span>
                        {r.kind === "job" && <span className="tag">{t("history.kind.job")}</span>}
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
  const jobs = useJobs();
  const hasThreads = jobs.length > 0 || selectSidebarBots(s).some((b) => (s.threads[b.name]?.length ?? 0) > 0);
  return <HistoryView days={historyDays(s, query, Date.now(), jobs)} query={query} hasThreads={hasThreads} onQuery={setQuery} inputRef={box} onActivity={() => s.openActivity()} />;
}
