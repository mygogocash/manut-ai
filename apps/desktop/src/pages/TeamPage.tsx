// Team: the members in the order the sidebar listed them (selectSidebarBots: pinned first, then as they joined), each with
// face, name, what they do and status, opening their chat. The status is team.ts's, in the design canvas's words. The faces
// are the app's own avatars: the canvas's drawn faces (AUTHORING.md, Team faces) are not in the app yet.
//
// Pause everyone is this page's too, as on the canvas's "Team: pause everyone" (PauseAll.dc.html): a button in the top bar,
// a question that names whom it stops, a banner while everyone is paused, each member's Paused tag, and a side panel for what
// was running and what still happens. Pausing is the runtime's to do (`team.pause`): the demo runtime stops its members,
// and the connected one answers "not yet", which the page shows in the runtime's own words instead of a question it could
// not act on. Pausing never unsends anything and never takes a page offline; the rules and words are pause.ts's.
import { useEffect, useReducer, useState } from "react";
import "./mission.css";
import { t, type Key } from "../i18n";
import type { TeamState } from "../runtime/mission";
import { getStore, selectAsks, selectSidebarBots, useStore, type Actions, type AppState } from "../state/store";
import { MenuIcon } from "../sidebar/menuIcons";
import { Avatar } from "../ui";
import { LOADING, load, type Load } from "./load";
import { Empty, MenuPageFrame } from "./MenuPage";
import { goneOut, jobsLine, memberNames, pausedJobLine, PAUSE_START, pauseReduce, pauseStep, routinesLine, sinceText, type PauseUi } from "./pause";
import { asksOf, memberStatus, type MemberStatus } from "./team";

/** One member as its row shows it. */
export interface TeamRow {
  name: string;
  displayName: string;
  /** what the member does ("Sales chat"), as the runtime describes it */
  description: string;
  status: MemberStatus;
  open: () => void;
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

/** The rows for the listed members, each opening that member's chat. */
export function teamRows(s: AppState & Actions): TeamRow[] {
  const asks = selectAsks(s);
  return selectSidebarBots(s).map((b) => ({
    name: b.name,
    displayName: b.display_name,
    description: b.description,
    status: memberStatus(b, s.chats[b.name], asksOf(asks, b.name).length),
    open: () => void s.selectBot(b.name),
  }));
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
  if (state?.paused)
    return (
      <>
        <h2 className="h2">{t("pause.was")}</h2>
        {state.running.length === 0 && <p className="hint">{t("pause.noneRunning")}</p>}
        {state.running.map((j) => (
          <div key={j.id} className="tr">
            <span className="grow">
              <button type="button" className="lk strong" onClick={() => p.onOpenJob(j.id)} data-testid={`pause-job-${j.id}`}>
                {j.title}
              </button>
              <span className="mut line">{pausedJobLine(j, p.nameOf)}</span>
            </span>
          </div>
        ))}
        <h2 className="h2">{t("pause.still")}</h2>
        {(["pause.still1", "pause.still2", "pause.still3", "pause.still4"] as const).map((k) => (
          <div key={k} className="tr">
            <span className="grow">{t(k)}</span>
          </div>
        ))}
      </>
    );
  return (
    <>
      <h2 className="h2">{t("pause.button")}</h2>
      <p className="hint">{t("pause.hint")}</p>
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
  return (
    <div className="dialog" role="dialog" aria-labelledby="pause-title" onKeyDown={(e) => e.key === "Escape" && p.onKeep()} data-testid="pause-dialog">
      <h3 id="pause-title">{t("pause.askTitle")}</h3>
      <p>
        {t(state.members.length === 1 ? "pause.stops1" : "pause.stops", { names })} {routinesLine(state.routines)}
      </p>
      <p>
        {jobsLine(state.running.length)} {t("pause.stays")}
      </p>
      {gone.length > 0 && (
        <ul className="gone">
          {gone.map((g) => (
            <li key={g.id}>{t("pause.goneLine", { title: g.title, sent: g.sent, total: g.total })}</li>
          ))}
        </ul>
      )}
      <p className="mut small">{t("pause.keeps")}</p>
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

export function TeamView({ members, pause }: { members: TeamRow[]; pause?: TeamPauseProps }) {
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
  const list = members.length ? (
    <ul className="rows">
      {members.map((m) => {
        const st = STATUS[m.status];
        return (
          <li key={m.name}>
            <button type="button" className="rowl" onClick={m.open} data-testid={`team-${m.name}`}>
              <Avatar bot={m.name} size={40} />
              <span className="grow">
                <span className="l1">{m.displayName}</span>
                {m.description && <span className="l2">{m.description}</span>}
              </span>
              <span className={st.tag}>{t(st.word)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  ) : (
    <Empty icon={<MenuIcon row="team" />} title={t("team.emptyTitle")} text={t("team.emptyText")} testId="team-empty" />
  );
  if (!pause)
    return (
      <MenuPageFrame page="team" title={t("menu.team")}>
        <div className="pane">{list}</div>
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
              {t("pause.banner", { since: sinceText(state.since ?? pause.nowMs / 1000, pause.nowMs) })}
            </div>
          )}
          {state && !paused && pause.ui.back && (
            <div className="banner ok" role="status" data-testid="pause-back">
              {t("pause.back")}
            </div>
          )}
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
  // The team's state is read when the page opens and again whenever a member is paused or resumed, from anywhere.
  const held = s.bots.map((b) => (b.paused ? b.name : "")).join();
  useEffect(() => {
    let live = true;
    void load(() => getStore().actions.teamState()).then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
  }, [held]);

  const run = async (resuming: boolean) => {
    dispatch({ type: "begin" });
    const step = await pauseStep(() => (resuming ? s.teamResume() : s.teamPause()), resuming);
    if (step.state) setState({ kind: "ready", value: step.state });
    dispatch(step.action);
  };

  return (
    <TeamView
      members={teamRows(s)}
      pause={{
        state,
        ui,
        nowMs: Date.now(),
        nameOf: (bot) => s.bots.find((b) => b.name === bot)?.display_name ?? bot,
        // A runtime that cannot say who is working cannot pause them either: its own "not yet" shows instead of a question.
        onAsk: () => (state.kind === "unavailable" ? dispatch({ type: "failed", message: state.message }) : dispatch({ type: "ask" })),
        onKeep: () => dispatch({ type: "keep" }),
        onPause: () => void run(false),
        onResume: () => void run(true),
        onOpenJob: (id) => s.openJob(id),
      }}
    />
  );
}
