// History: every thread of the team and every job the runtime lists, newest first, grouped by day (Today, Yesterday, then
// dates), each opening its thread or its page, as the design canvas's History board lists them. Each row says which kind it
// is (Chat, Team or Code) and the chips above filter by kind. The search box finds an entry by its title, the last thing said
// in it and who it is with; history.ts holds the rules. The command palette's last row ("Search History for ...") opens this page
// with the box focused and the words in it, through the store's `ui.findSeq` and `ui.findQuery`.
// Item 101e: the Claude Code and Codex conversations of the folders brought over (src/importPast) are Code rows among them, each
// continuing as the + menu's past conversations do, and Bring over… in the top bar opens the offer again.
import { useEffect, useRef, useState, type RefObject } from "react";
import { hhmm } from "../app/time";
import { t, type Key } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { helpedShop } from "../lib/shops";
import type { JobRow } from "../runtime/mission";
import { selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { homeBot } from "../sidebar/menu";
import { rowStatus } from "../threads/ThreadTree";
import type { ThreadStatus } from "../threads/status";
import { MenuIcon, SearchGlyph } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";
import { OwnersOnly } from "./OwnersOnly";
import { byDay, dayBand, historyEntries, jobLane, lanesPresent, matchWords, threadLane, type HistoryLane, type LaneWho } from "./history";
import { kitOf } from "./home";
import { stageTag } from "./job";
import { useShowOlder, type OlderView } from "./older";
import { useJobList } from "./RecentWork";
import { ShowOlder } from "./ShowOlder";
import { MoreButton, settledWhy, useRowMenu } from "../sidebar/RowMenu";
import { NO_SELECT, useRowSelect, useSelectionEscape, type RowSelect } from "../sidebar/useRowSelect";
import { placeOf, threadRowKey, untilWord, useRowMarks, type RowMark, type RowMarks, type RowPlace } from "../sidebar/rows";
import { dragRef } from "../chat/box/threadContext";
import { removeEntry } from "../threads/RemoveConversation";
import type { ConversationRef } from "../threads/removeAsk";
import { canRemove } from "../threads/types";
import type { PastChat } from "../sessions/host";
import { AgentMark } from "../sessions/AgentMark";
import { folderName } from "../sessions/agents";
import { getSessions } from "../sessions/sessions";
import { PROVIDER_NAME } from "../sidebar/usageFormat";
import { HISTORY_PER_AGENT, useBroughtOver } from "../importPast/broughtOver";
import { canImport } from "../importPast/ImportPast";
import { openImport } from "../importPast/offer";

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
  /** A chat's key for its menu and its marks (sidebar/rows.ts); a job has none. */
  rowKey?: string;
  /** What the person did to the chat (pinned, snoozed, done for now) and where it stands now: shown as a quiet tag. */
  mark?: RowMark;
  place?: RowPlace;
  /** A conversation with Buddy (item 102l-6): its menu ends with Remove, which asks first. None for any other row. */
  remove?: ConversationRef;
  /** "job": a job of the team (its page opens), not a thread. Its tag is its stage's, not a thread's status. "past": a Claude
   *  Code or Codex conversation of a folder brought over (item 101e), which continues as a session when opened. */
  kind?: "job" | "past";
  /** A past conversation's agent, drawn by its mark in place of a member's face. */
  agent?: PastChat["agent"];
  /** A past conversation's folder, by its name. */
  folder?: string;
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

/** The threads that are not also one of the runtime's jobs. The connected runtime lists each of a shop's tasks both as
 *  Buddy's thread and as a job, by the same id; it is one piece of work, so History lists it once, as the job, which says
 *  whose work it is and where it stands. Practice's threads and jobs never share an id. */
const threadsNotJobs = (s: AppState, members: string[], jobs: readonly JobRow[]) => {
  const ids = new Set(jobs.map((j) => j.id));
  return historyEntries(s.threads, members).filter((e) => !ids.has(e.row.thread));
};

/** The kinds that have an entry, threads and jobs together: what the chips offer, however the list is filtered or searched. */
export function historyLanes(s: AppState & Actions, jobs: readonly JobRow[] = [], past: readonly PastChat[] = []): HistoryLane[] {
  const who = laneWho(s);
  const members = selectSidebarBots(s).map((b) => b.name);
  return lanesPresent([
    ...threadsNotJobs(s, members, jobs).map((e) => threadLane(e.bot, who)),
    ...jobs.map((j) => jobLane(j.bot, who)),
    ...past.map(() => "code" as const),
  ]);
}

/** A past conversation's agent by its product name (kept in English, as everywhere). */
const agentName = (a: PastChat["agent"]) => PROVIDER_NAME[a] ?? a;

/** The days and rows for the threads in the store and the runtime's jobs that `query` finds (history.ts `matchWords`) and
 *  that are of the kind pressed (`lane`; all of them for "all"), each opening its thread or its page; threads and jobs are
 *  one list, newest first, as the canvas's History lists them. */
export function historyDays(
  s: AppState & Actions,
  query: string,
  nowMs: number,
  jobs: readonly JobRow[] = [],
  lane: HistoryLane | "all" = "all",
  marks: RowMarks = {},
  past: readonly PastChat[] = [],
  openPast: (c: PastChat) => void = (c) => void getSessions().continuePast(c),
): HistoryDayView[] {
  const members = selectSidebarBots(s).map((b) => b.name);
  const names = new Map(s.bots.map((b) => [b.name, b.display_name]));
  const untitled = t("thread.untitled");
  const who = laneWho(s);
  const nameOf = (bot: string) => names.get(bot) ?? bot;
  const threads = threadsNotJobs(s, members, jobs)
    .filter((e) => matchWords({ title: e.row.title, preview: e.row.preview, who: nameOf(e.bot) }, query, untitled))
    .map((e) => ({ e, status: rowStatus(s, e.bot, e.row) }))
    // an archived chat leaves the list and is found in the Archive under it (historyArchive)
    .filter((x) => placeOf(marks[threadRowKey(x.e.bot, x.e.row.thread)], x.status === "needs_you", nowMs, x.status === "running") !== "archived")
    .map(({ e, status }) => ({
      ts: e.ts,
      row: {
        key: `${e.bot}:${e.row.thread}`,
        rowKey: threadRowKey(e.bot, e.row.thread),
        mark: marks[threadRowKey(e.bot, e.row.thread)],
        place: placeOf(marks[threadRowKey(e.bot, e.row.thread)], status === "needs_you", nowMs, status === "running"),
        bot: e.bot,
        title: e.row.title || untitled,
        who: nameOf(e.bot),
        status,
        time: hhmm(new Date(e.ts * 1000)),
        open: () => void s.openThread(e.bot, e.row.thread),
        lane: threadLane(e.bot, who),
        ...(canRemove(e.row) ? { remove: { bot: e.bot, thread: e.row.thread, title: e.row.title || untitled } } : {}),
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
  // a past conversation is code work; it is found by its title, its agent and its folder's name
  const brought = past
    .filter((c) => matchWords({ title: c.title, who: `${agentName(c.agent)} ${folderName(c.cwd)}` }, query, untitled))
    .map((c) => ({
      ts: c.at,
      row: {
        key: `past:${c.agent}:${c.id}`,
        bot: "",
        title: c.title || untitled,
        who: agentName(c.agent),
        status: "idle" as const,
        time: hhmm(new Date(c.at * 1000)),
        open: () => openPast(c),
        lane: "code" as const,
        kind: "past" as const,
        agent: c.agent,
        folder: folderName(c.cwd),
      } satisfies HistoryRowView,
    }))
    .filter((x) => lane === "all" || x.row.lane === lane);
  // The sort is stable, so a thread and a job of the same moment keep the threads first.
  return byDay([...threads, ...work, ...brought].sort((a, b) => b.ts - a.ts), nowMs).map((d) => {
    const band = dayBand(d, nowMs);
    return { key: String(d.day), label: band.label, date: band.date, rows: d.entries.map((x) => x.row) };
  });
}

/** The chats the person archived, newest first, as History's Archive lists them (item 76): the one place an archived chat is found, and
 *  from which it is brought back. A chat's archive stays whatever happens in it; the ask of an archived chat is still in Needs you. */
export function historyArchive(s: AppState & Actions, marks: RowMarks): HistoryRowView[] {
  const members = selectSidebarBots(s).map((b) => b.name);
  const names = new Map(s.bots.map((b) => [b.name, b.display_name]));
  const untitled = t("thread.untitled");
  const who = laneWho(s);
  return historyEntries(s.threads, members)
    .filter((e) => marks[threadRowKey(e.bot, e.row.thread)]?.archived !== undefined)
    .map((e) => ({
      key: `${e.bot}:${e.row.thread}`,
      rowKey: threadRowKey(e.bot, e.row.thread),
      mark: marks[threadRowKey(e.bot, e.row.thread)],
      place: "archived" as const,
      bot: e.bot,
      title: e.row.title || untitled,
      who: names.get(e.bot) ?? e.bot,
      status: rowStatus(s, e.bot, e.row),
      time: hhmm(new Date(e.ts * 1000)),
      open: () => void s.openThread(e.bot, e.row.thread),
      lane: threadLane(e.bot, who),
      ...(canRemove(e.row) ? { remove: { bot: e.bot, thread: e.row.thread, title: e.row.title || untitled } } : {}),
    }));
}

/** The words of a chat's mark on its row: Pinned, Snoozed until a time, Done for now; nothing for a plain row. */
function markWord(r: HistoryRowView, nowMs: number): { text: string; tip?: string } | null {
  if (r.place === "pinned") return { text: t("row.pinned") };
  if (r.place === "snoozed" && r.mark?.snoozed !== undefined) return { text: t("row.snoozed", { when: untilWord(r.mark.snoozed, nowMs) }), tip: t("row.snoozedTip") };
  if (r.place === "snoozed" && r.mark?.untilDone !== undefined) return { text: t("row.snoozedDone"), tip: t("row.snooze.doneTip") };
  if (r.place === "settled") return { text: settledWhy(r.mark) ?? t("row.settled") };
  return null;
}

/** A chat's menu on its History row: the same Pin, Snooze, Done for now and Archive (or Bring back) as everywhere, and for a
 *  conversation with Buddy a last entry, Remove, which asks first. It keeps state, so it is its own element and `HistoryView` stays a
 *  function of its props. */
export function HistoryMore({ row, keys = [] }: { row: HistoryRowView; keys?: readonly string[] }) {
  const marks = useRowMarks();
  // the rows selected with it (item 94), when it is one of two or more: the menu acts on all of them
  const many = keys.length > 1;
  const menu = useRowMenu({ rowKey: row.rowKey ?? "", kind: "chat", mark: marks[row.rowKey ?? ""], name: many ? t("row.count", { n: keys.length }) : row.title, working: row.status === "running", keys, extra: row.remove ? removeEntry(row.remove) : undefined });
  return (
    <>
      <MoreButton name={row.title} onOpen={menu.open} className="hist-more" />
      {menu.menu}
    </>
  );
}

/** The Archive: the chats put away, under the days, opened by its heading. Each has its menu, whose one choice brings it back. */
export function HistoryArchive({ rows }: { rows: HistoryRowView[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <section className="day archive" aria-label={t("history.archive")} data-testid="history-archive">
      <div className="band">
        <button type="button" className="lk" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="history-archive-toggle">
          {t("history.archiveN", { n: rows.length })}
        </button>
      </div>
      {open && (
        <ul className="rows">
          {rows.map((r) => (
            <li key={r.key} className="hist-li" data-row-key={r.rowKey}>
              <button type="button" className="rowl" onClick={r.open} data-testid="history-archive-row">
                <Avatar bot={r.bot} size={24} />
                <span className="grow">{r.title}</span>
                <span className="when">{r.who}</span>
                <span className="when">{r.time}</span>
              </button>
              <HistoryMore row={r} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
  older,
  archive,
  nowMs = Date.now(),
  helped = null,
  onNeeds,
  select = NO_SELECT,
  onImport,
  pastMore = false,
}: {
  /** Bring over… (item 101e): opens the offer of Claude Code and Codex work; not drawn without it */
  onImport?: () => void;
  /** History lists fewer past conversations of an agent than the folders brought over hold: a line under the list says so */
  pastMore?: boolean;
  /** The shop shown, when the person only helps there: its past work and its activity log are its owner's, so the page says
   *  whose they are in place of the list, the search and the log's button. */
  helped?: Pick<ShopRow, "name" | "owner"> | null;
  /** opens Needs you, from the words a helper's shop shows */
  onNeeds?: () => void;
  /** Several chats selected at once (item 94, sidebar/useRowSelect.ts); none: a click opens its row. */
  select?: RowSelect;
  days: HistoryDayView[];
  /** The chats the person archived (`historyArchive`): drawn as the Archive under the days, with a way to bring each back. */
  archive?: HistoryRowView[];
  /** The time now, for a snooze's end. */
  nowMs?: number;
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
  /** the runtime has older work than the list holds, or Show older has shown all of it (older.ts): the line and the button under the list */
  older?: OlderView;
}) {
  if (helped)
    return (
      <MenuPageFrame page="history" title={t("menu.history")}>
        <div className="pane">
          <OwnersOnly shop={helped} screen="history" icon={<MenuIcon row="history" />} onNeeds={onNeeds} />
        </div>
      </MenuPageFrame>
    );
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
      {onImport && (
        <button type="button" className="btn" onClick={onImport} title={t("imp.openTip")} data-testid="history-import">
          {t("imp.open")}
        </button>
      )}
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
      <div className="pane" data-arrive="history" data-arrive-rows=".hist-li" data-flip-list data-flip-scope={`${query}|${lane}`} data-select-scope="history">
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
                    <li key={r.key} className="hist-li" data-flip={r.key} data-place={r.place} data-row-key={r.rowKey} data-sel={select.selected(r.rowKey) || undefined}>
                      <button
                        type="button"
                        className="rowl"
                        onClick={(e) => select.click(e, r.rowKey, r.open)}
                        onKeyDown={(e) => select.keyDown(e, r.rowKey)}
                        // a chat's row dragged onto an open chat's box brings its context (item 97); a job has no chat to bring
                        {...(r.rowKey && !r.kind ? dragRef({ kind: "thread", bot: r.bot, thread: r.key.slice(r.bot.length + 1) }) : {})}
                        data-testid="history-row"
                        data-kind={r.kind}
                      >
                        {r.lane && (
                          <span className="tag kind" data-testid="history-kind">
                            {t(LANE_WORD[r.lane])}
                          </span>
                        )}
                        {r.kind === "past" && r.agent ? (
                          <span className="hist-agent" aria-hidden="true">
                            <AgentMark agent={r.agent} size={18} />
                          </span>
                        ) : (
                          <Avatar bot={r.bot} size={24} />
                        )}
                        <span className="grow">{r.title}</span>
                        {r.kind === "job" && <span className="tag">{t("history.kind.job")}</span>}
                        {r.kind === "past" && r.folder && (
                          <span className="tag" data-testid="history-folder">
                            {r.folder}
                          </span>
                        )}
                        <span className="when">{r.who}</span>
                        {st && <span className={st.tag}>{t(st.word)}</span>}
                        {(() => {
                          const m = markWord(r, nowMs);
                          return m && (
                            <span className="tag" title={m.tip} data-testid="history-mark">
                              {m.text}
                            </span>
                          );
                        })()}
                        <span className="when">{r.time}</span>
                        {select.selected(r.rowKey) && <span className="vh">, {t("row.selected")}</span>}
                      </button>
                      {r.rowKey && <HistoryMore row={r} keys={select.actsOn(r.rowKey)} />}
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
        {pastMore && (
          <p className="none" data-testid="history-past-more">
            {t("history.pastMore", { n: HISTORY_PER_AGENT })}
          </p>
        )}
        {archive && archive.length > 0 && <HistoryArchive rows={archive} />}
        {older && <ShowOlder view={older} />}
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
  const findQuery = s.ui.findQuery;
  useEffect(() => {
    // a new search from the palette is a new `find`; its words alone changing brings nothing here
    if (find <= focusedFind) return;
    focusedFind = find;
    // the palette's "Search History for ..." brings its words
    setQuery(findQuery);
    box.current?.focus();
    box.current?.select();
  }, [find, findQuery]);
  const { jobs, older, reload } = useJobList();
  const more = useShowOlder(reload);
  // the conversations of the folders brought over from Claude Code and Codex (item 101e)
  const past = useBroughtOver();
  const hasThreads = jobs.length > 0 || past.chats.length > 0 || selectSidebarBots(s).some((b) => (s.threads[b.name]?.length ?? 0) > 0);
  // A kind that has no entry any more (its last one went) gives way to All, rather than leaving an empty list under a chip
  // that is gone.
  const [picked, setPicked] = useState<HistoryLane | "all">("all");
  const marks = useRowMarks();
  const lanes = historyLanes(s, jobs, past.chats);
  const lane = picked !== "all" && !lanes.includes(picked) ? "all" : picked;
  const days = historyDays(s, query, Date.now(), jobs, lane, marks, past.chats);
  // the chats of the days, in the order drawn, are one list to select several in (item 94); a job has no marks
  const select = useRowSelect("history", days.flatMap((d) => d.rows.flatMap((r) => (r.rowKey ? [r.rowKey] : []))));
  useSelectionEscape();
  return (
    <HistoryView
      select={select}
      days={days}
      archive={historyArchive(s, marks)}
      query={query}
      hasThreads={hasThreads}
      onQuery={setQuery}
      inputRef={box}
      onActivity={() => s.openActivity()}
      lanes={lanes}
      lane={lane}
      onLane={setPicked}
      older={older ? { state: older, ui: more.ui, onShow: more.show } : undefined}
      helped={helpedShop(s.shops)}
      onNeeds={() => s.openPage("needs")}
      onImport={canImport() ? () => openImport() : undefined}
      pastMore={past.more}
    />
  );
}
