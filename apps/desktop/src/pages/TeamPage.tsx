// Team: the members in the order the sidebar listed them (selectSidebarBots: pinned first, then as they joined), each with
// face, name, what they do and status, opening their chat. The status is team.ts's, in the design canvas's words. The faces
// are the app's own avatars: the canvas's drawn faces (AUTHORING.md, Team faces) are not in the app yet.
//
// Each row has a More button and a menu, the home of the actions the sidebar's member rows had before the side menu: a new
// thread with the member, Pin to top, and, where the runtime can restart an agent, Restart. team.ts decides what a member's
// menu offers; the rows below carry what each entry does.
//
// Pause everyone is this page's too, as on the canvas's "Team: pause everyone" (PauseAll.dc.html): a button in the top bar,
// a question that names whom it stops, a banner while everyone is paused, each member's Paused tag, and a side panel for what
// was running and what still happens. Pausing is the runtime's to do (`team.pause`): the demo runtime stops its members,
// and the connected one answers "not yet", which the page shows in the runtime's own words instead of a question it could
// not act on. Pausing never unsends anything and never takes a page offline; the rules and words are pause.ts's.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePlace } from "../palette/places";
import "./mission.css";
import { t, type Key } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { helpedShop } from "../lib/shops";
import type { TeamState } from "../runtime/mission";
import { useNow } from "../elsewhere/useNow";
import { can } from "../runtime";
import type { JobRow } from "../runtime/mission";
import { getStore, selectAsks, selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { MenuIcon } from "../sidebar/menuIcons";
import { getRestarts, useRestart } from "../sidebar/restart";
import { AskLine } from "../sidebar/Needs";
import { RestartLine } from "../sidebar/RestartLine";
import { NewThreadIcon } from "../threads/NewThreadIcon";
import { Avatar } from "../ui";
import { LOADING, load, type Load } from "./load";
import { Empty, MenuPageFrame } from "./MenuPage";
import { OwnersOnly } from "./OwnersOnly";
import { goneOut, jobsLine, memberNames, pausedJobLine, PAUSE_START, pauseReduce, pauseStep, pauseWords, routinesLine, sinceText, type PauseUi } from "./pause";
import { useJobs } from "./RecentWork";
import { asksOf, memberActions, memberStatus, tryAction, type MemberAction, type MemberMenuItem, type MemberStatus } from "./team";
import { lineWords, teamLine, type TeamLine } from "./teamLine";

/** One member as its row shows it. */
export interface TeamRow {
  name: string;
  displayName: string;
  /** what the member does ("Sales chat"), as the runtime describes it */
  description: string;
  status: MemberStatus;
  open: () => void;
  /** pinned to the top of the list */
  pinned?: boolean;
  /** what the member's menu offers, in order; a row without one has no More button */
  menu?: MemberMenuItem[];
  /** what the member is doing, what waits for them or why they are not at work (teamLine.ts); none for a row that has nothing to add */
  line?: TeamLine | null;
  /** Look first, for a member whose ask waits: opens their chat on that ask */
  look?: () => void;
}

/** Each status's word and the canvas's tag for it: amber waits on you, blue works, red could not finish. */
const STATUS: Record<MemberStatus, { word: Key; tag: string }> = {
  paused: { word: "team.paused", tag: "tag" },
  needs: { word: "thread.st.needs", tag: "tag warn" },
  working: { word: "thread.st.running", tag: "tag run" },
  stuck: { word: "team.stuck", tag: "tag err" },
  offline: { word: "bot.offline", tag: "tag" },
  idle: { word: "thread.st.idle", tag: "tag" },
};

/** What the rows need from outside the store: whether the runtime can restart an agent, and how. */
export interface TeamRowOptions {
  /** the runtime's own `restart` capability when not given */
  canRestart?: boolean;
  /** restarts the agent that serves a member: the restart every other place that offers one uses when not given */
  restart?: (bot: string) => void;
  /** the runtime's jobs, which say what a working member runs and when an idle member's last job was; none when it has none to give */
  jobs?: readonly JobRow[];
  /** when Pause everyone began (seconds), while it holds */
  pausedSince?: number | null;
}

/** The rows for the listed members, each opening that member's chat, with the menu of what else can be done with them. */
export function teamRows(s: AppState & Actions, opts: TeamRowOptions = {}): TeamRow[] {
  const asks = selectAsks(s);
  const canRestart = opts.canRestart ?? can("restart");
  const restart = opts.restart ?? ((bot: string) => void getRestarts().press(bot));
  return selectSidebarBots(s).map((b) => {
    const pinned = s.ui.pinned.includes(b.name);
    const run: Record<MemberAction, () => void | Promise<unknown>> = {
      new: () => s.newThread(b.name),
      pin: () => s.pinBot(b.name, true),
      unpin: () => s.pinBot(b.name, false),
      restart: () => restart(b.name),
      start: () => restart(b.name),
    };
    const chat = s.chats[b.name];
    const mine = asksOf(asks, b.name);
    const status = memberStatus(b, chat, mine.length);
    const newest = [...mine].sort((x, y) => y.ts - x.ts)[0];
    return {
      name: b.name,
      displayName: b.display_name,
      description: b.description,
      status,
      open: () => void s.selectBot(b.name),
      line: teamLine({ status, turn: chat?.turn, asks: mine, jobs: (opts.jobs ?? []).filter((j) => j.bot === b.name), error: chat?.lastTurn?.error, pausedSince: opts.pausedSince ?? null }),
      ...(status === "needs" && newest ? { look: () => void s.jumpToAsk(newest.bot, newest.item.id) } : {}),
      ...(pinned ? { pinned } : {}),
      menu: memberActions({ pinned, offline: b.status === "offline", remote: !!b.host, canRestart }).map((action) => ({ action, run: run[action] })),
    };
  });
}

/** What Pause everyone needs of the page that draws it: the runtime's word on the team, what the page itself holds (the
 *  question, the banner, a request on its way) and what each button does. */
export interface TeamPauseProps {
  state: Load<TeamState>;
  ui: PauseUi;
  nowMs: number;
  nameOf: (bot: string) => string;
  /** the top bar's Pause everyone */
  onAsk: () => void;
  /** Keep working */
  onKeep: () => void;
  /** the question's Pause everyone */
  onPause: () => void;
  onResume: () => void;
  onOpenJob: (id: string) => void;
}

function PauseSide({ p, state }: { p: TeamPauseProps; state: TeamState | null }) {
  const words = pauseWords(state);
  if (state?.paused)
    return (
      <>
        <h2 className="h2">{t(words.was)}</h2>
        {state.running.length === 0 && <p className="hint">{t("pause.noneRunning")}</p>}
        {state.running.map((j) => (
          <div key={j.id} className="tr">
            <span className="grow">
              <button type="button" className="lk strong" onClick={() => p.onOpenJob(j.id)} data-testid={`pause-job-${j.id}`}>
                {j.title}
              </button>
              <span className="mut line">{pausedJobLine(j, p.nameOf, state.holds)}</span>
            </span>
          </div>
        ))}
        <h2 className="h2">{t("pause.still")}</h2>
        {words.still.map((k) => (
          <div key={k} className="tr">
            <span className="grow">{t(k)}</span>
          </div>
        ))}
      </>
    );
  return (
    <>
      <h2 className="h2">{t("pause.button")}</h2>
      <p className="hint">{t(words.hint)}</p>
      <div className="tr">
        <span className="grow">{t("pause.not1")}</span>
      </div>
      <div className="tr">
        <span className="grow">{t("pause.not2")}</span>
      </div>
    </>
  );
}

function PauseQuestion({ p, state }: { p: TeamPauseProps; state: TeamState }) {
  const gone = goneOut(state.running);
  const names = memberNames(state.members, p.nameOf);
  const words = pauseWords(state);
  return (
    <div className="dialog" role="dialog" aria-labelledby="pause-title" onKeyDown={(e) => e.key === "Escape" && p.onKeep()} data-testid="pause-dialog">
      <h3 id="pause-title">{t("pause.askTitle")}</h3>
      <p>
        {t(words.stops(state.members.length), { names })} {routinesLine(state.routines)}
      </p>
      <p>
        {jobsLine(state.running.length)} {t(words.stays)}
      </p>
      {gone.length > 0 && (
        <ul className="gone">
          {gone.map((g) => (
            <li key={g.id}>{t("pause.goneLine", { title: g.title, sent: g.sent, total: g.total })}</li>
          ))}
        </ul>
      )}
      <p className="mut small">{t(words.keeps)}</p>
      <div className="chips">
        <button type="button" className="btn danger solid" disabled={p.ui.busy} onClick={p.onPause} data-testid="pause-confirm">
          {t("pause.button")}
        </button>
        {/* The safe answer has the focus, so a stray Enter keeps the team working. */}
        <button type="button" className="btn" autoFocus onClick={p.onKeep} data-testid="pause-keep">
          {t("pause.keep")}
        </button>
      </div>
    </div>
  );
}

/** The three dots of the More button. */
function MoreGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

/** What a menu entry says, in the words the sidebar's member rows used. */
function itemLabel(action: MemberAction, name: string): string {
  switch (action) {
    case "new":
      return t("thread.new", { name });
    case "pin":
      return t("row.pin");
    case "unpin":
      return t("row.unpin");
    case "restart":
      return t("row.restart");
    case "start":
      return t("row.start");
  }
}

/** What a member is doing under their name, in the canvas's member states: the words (teamLine.ts) and, quietly beside them,
 *  how long the turn has run or how many more asks wait. An ask's command is set as code, as Needs you sets it. */
function TeamLineView({ name, line, nowMs }: { name: string; line: TeamLine; nowMs: number }) {
  const w = lineWords(line, nowMs);
  return (
    <span className="l2 doing" data-testid={`team-line-${name}`} data-kind={line.kind}>
      <span className="words">{line.kind === "asks" ? <AskLine text={w.words} /> : w.words}</span>
      {w.meta && <span className="when">{w.meta}</span>}
    </span>
  );
}

/** "Restarting" beside a member's status while the agent that serves them restarts (sidebar/restart.ts keeps that). */
function RestartWait({ name, start }: { name: string; start: boolean }) {
  const st = useRestart(name);
  if (st.step !== "restarting") return null;
  return (
    <span className="tag run" role="status" data-testid={`team-restarting-${name}`}>
      {t(start ? "rs.starting" : "rs.restarting")}
    </span>
  );
}

export function TeamView({
  members,
  pause,
  menu = null,
  onMenu,
  error,
  nowMs,
  helped = null,
  onNeeds,
}: {
  members: TeamRow[];
  pause?: TeamPauseProps;
  /** The shop shown, when the person only helps there: its team and Pause everyone are its owner's, so the page lists Buddy,
   *  who holds what waits for them, and says whose the rest is. Pause is never offered for it. */
  helped?: Pick<ShopRow, "name" | "owner"> | null;
  /** opens Needs you, from the words a helper's shop shows */
  onNeeds?: () => void;
  /** the time the lines are told against (ms); the clock when not given */
  nowMs?: number;
  /** the member whose menu is open */
  menu?: string | null;
  /** opens a member's menu, or closes the open one (null) */
  onMenu?: (name: string | null) => void;
  /** why the last action was not taken, in the runtime's own words */
  error?: string | null;
}) {
  const state = pause?.state.kind === "ready" ? pause.state.value : null;
  const paused = !!state?.paused;
  const loading = pause?.state.kind === "loading";
  // With no one but the lead to stop (or no team at all) there is nothing to pause, so the button is not offered.
  const offered = !!pause && members.length > 0 && !(state && state.members.length === 0);
  const acts =
    pause &&
    offered &&
    (paused ? (
      <button type="button" className="btn dark" disabled={pause.ui.busy} onClick={pause.onResume} data-testid="pause-resume">
        {t("pause.resume")}
      </button>
    ) : (
      <button type="button" className="btn danger" disabled={loading || pause.ui.busy} aria-busy={loading || undefined} onClick={pause.onAsk} data-testid="pause-open">
        {t("pause.button")}
      </button>
    ));
  const now = nowMs ?? pause?.nowMs ?? Date.now();
  const notice = error ? (
    <div className="banner err" role="alert" data-testid="team-action-error">
      {error}
    </div>
  ) : null;
  const list = members.length ? (
    <ul className="rows" data-arrive="team" data-arrive-rows=":scope > li" data-flip-list>
      {members.map((m) => {
        const st = STATUS[m.status];
        const open = menu === m.name && !!m.menu?.length;
        const restarts = !!m.menu?.some((a) => a.action === "restart" || a.action === "start");
        return (
          <li key={m.name} className="tli" data-flip={m.name} data-testid={`team-row-${m.name}`}>
            <div className="rowl trow">
              <button type="button" className="rowmain" onClick={m.open} data-testid={`team-${m.name}`}>
                <Avatar bot={m.name} size={40} live />
                <span className="grow">
                  <span className="l1">
                    {m.displayName}
                    {m.pinned && <span className="pinmark" role="img" aria-label={t("row.pinned")} title={t("row.pinned")} data-testid={`team-pinned-${m.name}`} />}
                    {m.description && <span className="role">{m.description}</span>}
                  </span>
                  {m.line && <TeamLineView name={m.name} line={m.line} nowMs={now} />}
                </span>
                {restarts && <RestartWait name={m.name} start={m.status === "offline"} />}
                <span className={st.tag}>{t(st.word)}</span>
              </button>
              {m.look && (
                <button type="button" className="lk look" onClick={m.look} data-testid={`team-look-${m.name}`}>
                  {t("home.look")}
                </button>
              )}
              {!!m.menu?.length && (
                <button
                  type="button"
                  className="ib more"
                  aria-label={t("row.more", { name: m.displayName })}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={() => onMenu?.(open ? null : m.name)}
                  data-testid={`team-more-${m.name}`}
                >
                  <MoreGlyph />
                </button>
              )}
            </div>
            {open && m.menu && (
              <div
                className="tmenu"
                role="menu"
                aria-label={t("row.actions", { name: m.displayName })}
                data-testid={`team-menu-${m.name}`}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    onMenu?.(null);
                    return;
                  }
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
                  const at = items.indexOf(document.activeElement as HTMLButtonElement);
                  items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
                }}
              >
                {m.menu.map((item) => (
                  <button
                    key={item.action}
                    type="button"
                    role="menuitem"
                    className="tmenu-i"
                    onClick={() => {
                      onMenu?.(null);
                      void item.run();
                    }}
                    data-testid={`team-menu-${item.action}-${m.name}`}
                  >
                    {item.action === "new" && <NewThreadIcon size={14} />}
                    <span className="tmenu-l">{itemLabel(item.action, m.displayName)}</span>
                  </button>
                ))}
              </div>
            )}
            {restarts && <RestartLine bot={{ name: m.name, display_name: m.displayName }} testId={`team-restart-line-${m.name}`} />}
          </li>
        );
      })}
    </ul>
  ) : helped ? null : (
    <Empty icon={<MenuIcon row="team" />} title={t("team.emptyTitle")} text={t("team.emptyText")} testId="team-empty" />
  );
  if (!pause || helped)
    return (
      <MenuPageFrame page="team" title={t("menu.team")}>
        <div className="pane">
          {notice}
          {list}
          {helped && <OwnersOnly shop={helped} screen="team" icon={<MenuIcon row="team" />} onNeeds={onNeeds} />}
        </div>
      </MenuPageFrame>
    );
  return (
    <MenuPageFrame page="team" title={t("menu.team")} acts={acts || undefined}>
      <div className="teamp">
        <div className="pane">
          {pause.ui.error && (
            <div className="banner err" role="alert" data-testid="pause-error">
              {pause.ui.error}
            </div>
          )}
          {state && !paused && pause.ui.ask && <PauseQuestion p={pause} state={state} />}
          {state && paused && (
            <div className="banner warn" role="status" data-testid="pause-banner">
              {t(pauseWords(state).banner, { since: sinceText(state.since ?? pause.nowMs / 1000, pause.nowMs) })}
            </div>
          )}
          {state && !paused && pause.ui.back && (
            <div className="banner ok" role="status" data-testid="pause-back">
              {t("pause.back")}
            </div>
          )}
          {notice}
          {list}
        </div>
        <aside className="side2" data-testid="pause-side">
          <PauseSide p={pause} state={state} />
        </aside>
      </div>
    </MenuPageFrame>
  );
}

export function TeamPage() {
  const s = useStore();
  const [state, setState] = useState<Load<TeamState>>(LOADING);
  const [ui, dispatch] = useReducer(pauseReduce, PAUSE_START);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A press anywhere but the open menu and its button closes it. The focus goes to the first entry as the menu opens and
  // back to its button when it closes, unless the person has already put it somewhere else.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (menu) document.querySelector<HTMLElement>(`[data-testid="team-menu-${menu}"] button`)?.focus();
    else if (opened.current && (!document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>(`[data-testid="team-more-${opened.current}"]`)?.focus();
    opened.current = menu;
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest(`[data-testid="team-menu-${menu}"], [data-testid="team-more-${menu}"]`)) setMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);
  // An action the runtime does not take (a new thread on the connected runtime, for now) says so in the runtime's words.
  const report = async (run: () => void | Promise<unknown>) => {
    setError(null);
    setError(await tryAction(getStore(), run));
  };
  // The runtime's jobs tell what a working member runs and when an idle member last finished one; the clock moves a running
  // turn's time on while a member works.
  const jobs = useJobs();
  const now = useNow(s.bots.some((b) => b.running || !!s.chats[b.name]?.turn), 5_000);
  const pausedSince = state.kind === "ready" && state.value.paused ? state.value.since : null;
  const members = teamRows(s, { jobs, pausedSince }).map((r) => ({ ...r, menu: r.menu?.map((item) => ({ ...item, run: () => report(item.run) })) }));
  // A shop the person only helps at: its team is its owner's, so it is never read here and never paused from here.
  const helped = helpedShop(s.shops);
  // The team's state is read when the page opens and again whenever a member is paused or resumed, from anywhere, and when
  // the switcher shows another shop.
  const held = s.bots.map((b) => (b.paused ? b.name : "")).join();
  useEffect(() => {
    if (helped) return;
    let live = true;
    void load(() => getStore().actions.teamState()).then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
    // `helped` is read by its id: a new object for the same shop reads nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, helped?.id]);

  // The command palette offers Pause everyone while this page offers it: the button's own question, nothing more.
  const offersPause = !helped && members.length > 0 && !(state.kind === "ready" && (state.value.paused || state.value.members.length === 0)) && state.kind !== "loading" && !ui.busy;
  const askPause = () => (state.kind === "unavailable" ? dispatch({ type: "failed", message: state.message }) : dispatch({ type: "ask" }));
  const askRef = useRef(askPause);
  askRef.current = askPause;
  const pausePlace = useMemo(() => (offersPause ? { ask: () => askRef.current() } : null), [offersPause]);
  usePlace("pause", pausePlace);

  const run = async (resuming: boolean) => {
    dispatch({ type: "begin" });
    const step = await pauseStep(() => (resuming ? s.teamResume() : s.teamPause()), resuming);
    if (step.state) setState({ kind: "ready", value: step.state });
    dispatch(step.action);
  };

  return (
    <TeamView
      members={members}
      nowMs={now}
      menu={menu}
      onMenu={setMenu}
      error={error}
      helped={helped}
      onNeeds={() => s.openPage("needs")}
      pause={{
        state,
        ui,
        nowMs: Date.now(),
        nameOf: (bot) => s.bots.find((b) => b.name === bot)?.display_name ?? bot,
        // A runtime that cannot say who is working cannot pause them either: its own "not yet" shows instead of a question.
        onAsk: askPause,
        onKeep: () => dispatch({ type: "keep" }),
        onPause: () => void run(false),
        onResume: () => void run(true),
        onOpenJob: (id) => s.openJob(id),
      }}
    />
  );
}
