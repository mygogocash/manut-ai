// The Helpers card once a round runs (item 102h; `docs/several-agents.md`, "4. Helper lanes a lane asks for"): under the Start helpers
// card's settled line in the lead lane's chat, one row per helper lane in the form of the Subagents card (chat/activity/Subagents.tsx):
// the agent's mark, a link line that opens its chat ("→ Helper 1: Tests for the QR builder", the fork's `ThreadLinkLine`), its state,
// its current step and its time, "Waiting for you" in amber with Answer while its ask waits, and Stop on each row with Stop all in the
// head. Only the person presses them: nothing an agent writes reaches a Stop, and Answer only opens the helper's own chat at its ask,
// where its card is answered as any ask is.
//
// `HelperRunView` draws from props alone, so a test renders each state; `HelperRunCard` reads the sessions store (the runs, each
// helper's chat for its turn and asks) and presses through it.
import "../chat/activity/activity.css";
import "./helpers.css";
import { useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { elapsed } from "../app/time";
import { useClock } from "../app/clock";
import { revealHidden } from "../lib/secrets";
import { AgentMark } from "../sessions/AgentMark";
import type { AgentId } from "../sessions/agents";
import { getSessions } from "../sessions/sessions";
import { getStore, selectAsks, useStore } from "../state/store";
import { Spinner } from "../ui";
import type { HelperRun } from "./helperRuns";
import type { LandingView } from "./helperLanding";
import { getHost } from "../sessions/host";
import { endingOf, type Ending } from "./rules";

/** A row's state as the card says it. */
export type RowState = "waiting" | "starting" | "working" | "asking" | "idle" | "stopping" | "dropped" | Ending;

/** One row of the card, from props alone. */
export interface RunRow {
  readonly index: number;
  readonly title: string;
  readonly agent: string;
  readonly state: RowState;
  /** the step its turn names now, while it works */
  readonly step?: string;
  /** when its turn began (ms), while it works */
  readonly since?: number | null;
  /** the line under it: why it did not start, how it failed, that its process was closed */
  readonly line?: string;
  /** its chat can be opened */
  readonly canOpen: boolean;
  /** the person can stop it now */
  readonly canStop: boolean;
  /** where its work went (item 102i): landing, landed, kept as a patch, taken back */
  readonly landing?: LandingView | null;
}

/** A landing in the person's words (item 102i): what it did, the files it left conflicts in, a key found in what it wrote. */
export function landingWords(l: LandingView): string {
  const n = l.filesTotal || l.files.length;
  switch (l.state) {
    case "waiting":
      return t("helpers.land.waiting");
    case "landing":
      return t("helpers.land.landing");
    case "nothing":
      return t("helpers.land.nothing");
    case "takenBack":
      return t("helpers.land.takenBack");
    case "failed":
      return t("helpers.land.failed", { why: l.error });
    case "kept":
      return l.why === "would_not_apply" || !l.why ? t("helpers.land.keptApply") : t("helpers.land.keptOutside");
    case "landed": {
      const parts = [n === 1 ? t("helpers.land.landedOne") : t("helpers.land.landed", { n })];
      if (l.conflicts.length) parts.push(t("helpers.land.conflicts", { files: l.conflicts.slice(0, 3).join(", ") }));
      if (l.keys.length) parts.push(t("helpers.land.keys", { files: l.keys.slice(0, 3).join(", ") }));
      return parts.join(" ");
    }
  }
}

const STATE_KEY: Record<RowState, Key> = {
  waiting: "helpers.run.st.waiting",
  starting: "helpers.run.st.starting",
  working: "helpers.run.st.working",
  asking: "helpers.run.st.asking",
  idle: "helpers.run.st.idle",
  stopping: "helpers.run.st.stopping",
  dropped: "helpers.run.st.dropped",
  done: "helpers.run.st.done",
  budgetSpent: "helpers.run.st.budgetSpent",
  failed: "helpers.run.st.failed",
  couldNotRun: "helpers.run.st.couldNotRun",
  stoppedByPerson: "helpers.run.st.stoppedByPerson",
};

/** The Subagents card's tone for each state: ink while it works, amber while it waits on the person, green once it reported, red
 *  when it failed, muted otherwise. */
const TONE: Record<RowState, string> = {
  waiting: "queued",
  starting: "running",
  working: "running",
  asking: "waiting",
  idle: "queued",
  stopping: "queued",
  dropped: "stopped",
  done: "done",
  budgetSpent: "waiting",
  failed: "failed",
  couldNotRun: "failed",
  stoppedByPerson: "stopped",
};

const firstLine = (s: string) => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** The rows of a round from its runs and what each helper's chat shows now. `chat` answers for a helper's session: whether a turn
 *  runs (its step and start), and how many of its asks wait. */
export function runRows(runs: readonly HelperRun[], chat: (session: string) => { turn: { status: string; startedAt: number } | null; asks: number; starting: boolean }): RunRow[] {
  return runs.map((r): RunRow => {
    const base = { index: r.index, title: r.row.title, agent: r.row.agent, canOpen: !!r.session };
    if (r.state === "waiting") return { ...base, state: "waiting", canStop: true };
    if (r.state === "starting") return { ...base, state: r.stopping ? "stopping" : "starting", canStop: !r.stopping };
    if (r.state === "dropped") return { ...base, state: "dropped", canStop: false, line: t(r.dropped === "breaker" ? "helpers.run.dropped.breaker" : "helpers.run.dropped.person") };
    if (r.state === "notStarted") return { ...base, state: "couldNotRun", canStop: false, ...(r.why ? { line: r.why } : {}) };
    if (r.state === "back" && r.report) {
      const ending = endingOf(r.report);
      const line = ending === "failed" ? firstLine(r.report.words) : r.ended ? t("helpers.run.ended") : "";
      return { ...base, state: ending, canStop: false, ...(line ? { line } : {}) };
    }
    const c = r.session ? chat(r.session) : { turn: null, asks: 0, starting: true };
    if (r.stopping) return { ...base, state: "stopping", canStop: false };
    if (c.asks > 0) return { ...base, state: "asking", canStop: true, ...(c.turn ? { since: c.turn.startedAt } : {}) };
    if (c.turn) return { ...base, state: "working", canStop: true, step: c.turn.status, since: c.turn.startedAt };
    return { ...base, state: c.starting ? "starting" : "idle", canStop: true };
  });
}

export interface HelperRunViewProps {
  rows: readonly RunRow[];
  /** how many run at once on this Mac, once known */
  atOnce?: number | null;
  now: number;
  onOpen?: (index: number) => void;
  onAnswer?: (index: number) => void;
  onStop?: (index: number) => void;
  onStopAll?: () => void;
  /** Take back this landing (item 102i) */
  onTakeBack?: (index: number) => void;
  /** Show patch: the kept patch in Finder (item 102i) */
  onShowPatch?: (index: number) => void;
}

/** The card from props alone. */
export function HelperRunView({ rows, atOnce, now, onOpen, onAnswer, onStop, onStopAll, onTakeBack, onShowPatch }: HelperRunViewProps) {
  const running = rows.filter((r) => r.state === "starting" || r.state === "working" || r.state === "asking" || r.state === "idle" || r.state === "stopping").length;
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const back = rows.length - running - waiting;
  const asking = rows.some((r) => r.state === "asking");
  const live = running + waiting > 0;
  return (
    <div className="sa-card hr-card" role="group" aria-label={t("helpers.run.label")} data-testid="helper-run-card" data-live={live || undefined}>
      <div className="sa-head">
        {asking ? <span className="sa-ic waiting" aria-hidden="true" /> : live ? <Spinner size={10} label={t("ui.working")} /> : <span className="sa-ic" aria-hidden="true" />}
        <span className={`sa-sum${asking ? " waiting" : ""}`} data-testid="helper-run-summary">
          {t("helpers.run.summary", { running, waiting, back })}
          {atOnce ? <span className="hr-cap"> · {t("helpers.run.cap", { n: atOnce })}</span> : null}
        </span>
        {live && onStopAll && (
          <button type="button" className="sa-open hr-stop-all" onClick={onStopAll} title={t("helpers.run.stopAllTip")} data-testid="helper-run-stop-all">
            {t("helpers.run.stopAll")}
          </button>
        )}
      </div>
      <div className="sa-rows">
        {rows.map((r) => (
          <div key={r.index} className={`sa-row hr-row s-${r.state}`} data-testid="helper-run-row" data-state={r.state} data-index={r.index}>
            <span className="sa-mark" aria-hidden="true">
              <AgentMark agent={r.agent as AgentId} size={12} />
            </span>
            <span className="sa-main">
              <span className="hr-top">
                <button
                  type="button"
                  className="hr-link"
                  disabled={!r.canOpen}
                  onClick={() => onOpen?.(r.index)}
                  title={t("helpers.run.open", { n: r.index + 1 })}
                  data-testid="helper-run-link"
                >
                  <span className="hr-arrow" aria-hidden="true">
                    →
                  </span>
                  <span className="hr-title">{t("helpers.run.link", { n: r.index + 1, title: revealHidden(r.title) })}</span>
                </button>
                <span className={`sa-st ${TONE[r.state]}`} data-testid="helper-run-state">
                  {t(STATE_KEY[r.state])}
                </span>
                {r.since != null && (
                  <span className="sa-t" data-testid="helper-run-time">
                    {elapsed(Math.max(0, now - r.since))}
                  </span>
                )}
                {r.state === "asking" && onAnswer && (
                  <button type="button" className="hr-act hr-answer" onClick={() => onAnswer(r.index)} data-testid="helper-run-answer">
                    {t("helpers.run.answer")}
                  </button>
                )}
                {r.canStop && onStop && (
                  <button type="button" className="hr-act" onClick={() => onStop(r.index)} title={t("helpers.run.stopTip", { n: r.index + 1 })} data-testid="helper-run-stop">
                    {t("helpers.run.stop")}
                  </button>
                )}
              </span>
              {(r.state === "working" && r.step) || r.line ? (
                <span className="sa-line" title={r.line ?? r.step} data-testid="helper-run-line">
                  {r.state === "working" && r.step ? <code>{r.step}</code> : r.line}
                </span>
              ) : null}
              {r.landing && (
                <span className={`sa-line hr-land l-${r.landing.state}`} data-testid="helper-run-landing" data-landing={r.landing.state}>
                  {landingWords(r.landing)}
                  {r.landing.state === "landed" && onTakeBack && (
                    <button type="button" className="hr-act" onClick={() => onTakeBack(r.index)} title={t("helpers.land.takeBackTip")} data-testid="helper-run-take-back">
                      {t("helpers.land.takeBack")}
                    </button>
                  )}
                  {r.landing.state === "kept" && r.landing.patch && onShowPatch && (
                    <button type="button" className="hr-act" onClick={() => onShowPatch(r.index)} data-testid="helper-run-show-patch">
                      {t("helpers.land.showPatch")}
                    </button>
                  )}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const noRuns: readonly HelperRun[] = [];

/** The timeline's card for round `round`: the runs from the sessions store, each helper's chat read for its turn and its asks. */
export function HelperRunCard({ round }: { round: string }) {
  const ss = getSessions();
  const runs = useSyncExternalStore(ss.onHelperRuns, () => ss.helperRuns(round) ?? noRuns, () => noRuns);
  const landings = useSyncExternalStore(ss.subscribeLandings, ss.landingSnapshot, ss.landingSnapshot);
  const atOnce = useSyncExternalStore(ss.onHelperRuns, ss.helpersAtOnce, ss.helpersAtOnce);
  const app = useStore();
  const asks = selectAsks(app);
  const rows = runRows(runs, (session) => {
    const key = ss.chatKey(session);
    const turn = key ? app.chats[key]?.turn : undefined;
    const status = ss.getState().list.find((r) => r.id === session)?.status;
    return {
      turn: turn ? { status: turn.status, startedAt: turn.startedAt } : null,
      asks: key ? asks.filter((a) => a.bot === key).length : 0,
      starting: status === "starting" || status === "draft",
    };
  });
  const withLandings = rows.map((r) => ({ ...r, landing: landings.get(`${round}:${r.index}`) ?? null }));
  const live = rows.some((r) => r.since != null);
  const now = useClock(live);
  const session = (i: number) => runs.find((r) => r.index === i)?.session;
  return (
    <HelperRunView
      rows={withLandings}
      atOnce={atOnce}
      now={now}
      onOpen={(i) => {
        const id = session(i);
        if (id) getStore().actions.openSession(id);
      }}
      onAnswer={(i) => {
        const id = session(i);
        const key = id ? ss.chatKey(id) : null;
        const first = key ? selectAsks(getStore().getState()).find((a) => a.bot === key) : undefined;
        if (key && first) void getStore().actions.jumpToAsk(key, first.item.id);
        else if (id) getStore().actions.openSession(id);
      }}
      onStop={(i) => void ss.stopHelper(round, i)}
      onStopAll={() => void ss.stopHelpers(round)}
      onTakeBack={(i) => void ss.takeBackLanding(round, i)}
      onShowPatch={(i) => {
        const patch = landings.get(`${round}:${i}`)?.patch;
        // the shell shows folders, not files: the patch's own folder, ~/.manut/patches/<job>, which holds only this job's patches
        if (patch) void getHost().reveal(patch.slice(0, patch.lastIndexOf("/")) || patch).catch(() => undefined);
      }}
    />
  );
}
