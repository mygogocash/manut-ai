// History: every thread of the team and every job the runtime lists, newest first, grouped by day (Today, Yesterday, then
// dates), each opening its thread or its page, as the design canvas's History board lists them. Each row says which kind it
// is (Chat, Team or Code) and the chips above filter by kind. The search box finds an entry by its title, the last thing said
// in it and who it is with; history.ts holds the rules. The menu's Search button and ⌘K open this page with the box focused,
// through the store's `ui.findSeq`.
import { useEffect, useRef, useState, type RefObject } from "react";
import { hhmm } from "../app/time";
import { t, type Key } from "../i18n";
import type { JobRow } from "../runtime/mission";
import { selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { homeBot } from "../sidebar/menu";
import { rowStatus } from "../threads/ThreadTree";
import type { ThreadStatus } from "../threads/status";
import { MenuIcon, SearchGlyph } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";
import { byDay, dayBand, historyEntries, jobLane, lanesPresent, matchWords, threadLane, type HistoryLane, type LaneWho } from "./history";
import { kitOf } from "./home";
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
  /** which of History's kinds it is; a row with none draws no kind tag */
  lane?: HistoryLane;
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

/** The words a kind goes by, on its chip and its tag: Chat is Home's word for a conversation, Team and Code are the menu's. */
const LANE_WORD: Record<HistoryLane, Key> = { chat: "home.mode.chat", team: "menu.team", code: "menu.code" };

/** The lead and the engineer the kinds are told apart by, as the store's team has them (Home's own rules). */
function laneWho(s: AppState): LaneWho {
  const members = selectSidebarBots(s).map((b) => b.name);
  return { home: homeBot(s.bots, members), kit: kitOf(members) };
}

/** The kinds that have an entry, threads and jobs together: what the chips offer, however the list is filtered or searched. */
export function historyLanes(s: AppState & Actions, jobs: readonly JobRow[] = []): HistoryLane[] {
  const who = laneWho(s);
  const members = selectSidebarBots(s).map((b) => b.name);
  return lanesPresent([...historyEntries(s.threads, members).map((e) => threadLane(e.bot, who)), ...jobs.map((j) => jobLane(j.bot, who))]);
}

/** The days and rows for the threads in the store and the runtime's jobs that `query` finds (history.ts `matchWords`) and
 *  that are of the kind pressed (`lane`; all of them for "all"), each opening its thread or its page; threads and jobs are
 *  one list, newest first, as the canvas's History lists them. */
export function historyDays(s: AppState & Actions, query: string, nowMs: number, jobs: readonly JobRow[] = [], lane: HistoryLane | "all" = "all"): HistoryDayView[] {
  const members = selectSidebarBots(s).map((b) => b.name);
  const names = new Map(s.bots.map((b) => [b.name, b.display_name]));
  const untitled = t("thread.untitled");
  const who = laneWho(s);
  const nameOf = (bot: string) => names.get(bot) ?? bot;
  const threads = historyEntries(s.threads, members)
    .filter((e) => matchWords({ title: e.row.title, preview: e.row.preview, who: nameOf(e.bot) }, query, untitled))
    .map((e) => ({
      ts: e.ts,
      row: {
        key: `${e.bot}:${e.row.thread}`,
        bot: e.bot,
        title: e.row.title || untitled,
        who: nameOf(e.bot),
        status: rowStatus(s, e.bot, e.row),
        time: hhmm(new Date(e.ts * 1000)),
        open: () => void s.openThread(e.bot, e.row.thread),
        lane: threadLane(e.bot, who),
      } satisfies HistoryRowView,
    }))
    .filter((x) => lane === "all" || x.row.lane === lane);
  const work = jobs
    .filter((j) => matchWords({ title: j.title, who: nameOf(j.bot) }, query, untitled))
    .map((j) => ({
      ts: j.at,
      row: {
        key: `job:${j.id}`,
        bot: j.bot,
        title: j.title,
        who: nameOf(j.bot),
        status: "idle" as const,
        time: hhmm(new Date(j.at * 1000)),
        open: () => s.openJob(j.id),
        lane: jobLane(j.bot, who),
        kind: "job" as const,
        tag: stageTag(j.stage),
      } satisfies HistoryRowView,
    }))
    .filter((x) => lane === "all" || x.row.lane === lane);
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
  lanes,
  lane = "all",
  onLane,
}: {
  days: HistoryDayView[];
  query: string;
  /** whether the team has any thread or job at all, so an empty list can say why it is empty */
  hasThreads: boolean;
  onQuery: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** opens the activity log, History's second view; the button is not drawn without it */
  onActivity?: () => void;
  /** the kinds there are entries of; the chips are drawn only for two or more, and not without `onLane` */
  lanes?: readonly HistoryLane[];
  /** the kind pressed, or "all" */
  lane?: HistoryLane | "all";
  onLane?: (lane: HistoryLane | "all") => void;
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
  // The canvas's chips: All and each kind there are entries of. One kind has nothing to filter.
  const chips =
    lanes && lanes.length > 1 && onLane ? (
      <div className="chipset" role="group" aria-label={t("history.show")}>
        {(["all", ...lanes] as const).map((l) => (
          <button key={l} type="button" className="fchip" aria-pressed={lane === l} onClick={() => onLane(l)} data-testid={`history-lane-${l}`}>
            {l === "all" ? t("history.lane.all") : t(LANE_WORD[l])}
          </button>
        ))}
      </div>
    ) : undefined;
  return (
    <MenuPageFrame page="history" title={t("menu.history")} middle={chips} acts={acts}>
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
                        {r.lane && (
                          <span className="tag kind" data-testid="history-kind">
                            {t(LANE_WORD[r.lane])}
                          </span>
                        )}
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
  // A kind that has no entry any more (its last one went) gives way to All, rather than leaving an empty list under a chip
  // that is gone.
  const [picked, setPicked] = useState<HistoryLane | "all">("all");
  const lanes = historyLanes(s, jobs);
  const lane = picked !== "all" && !lanes.includes(picked) ? "all" : picked;
  return (
    <HistoryView
      days={historyDays(s, query, Date.now(), jobs, lane)}
      query={query}
      hasThreads={hasThreads}
      onQuery={setQuery}
      inputRef={box}
      onActivity={() => s.openActivity()}
      lanes={lanes}
      lane={lane}
      onLane={setPicked}
    />
  );
}
