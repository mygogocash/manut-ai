// The job's side-by-side view (item 102b; `docs/several-agents.md`, "2. Watching them side by side"): the lanes one Ask several
// message started, a column for each (three side by side where there is room, tabs where there is not), each with its agent's
// mark, model and branch, its state tag as the Lanes band reads it, the lane's own chat drawn compactly, the ask card while an ask
// waits, Open lane and Stop. Stop all asks once before it stops every lane. There is no box here that writes to every lane:
// "Ask them again" opens Ask several's panel with the same rows and message, unsent.
//
// The chat and the ask card are the lane's own (`Timeline`, `Cards`): an ask shown in a column is the very approval the lane's chat
// and Needs you show, settled once through `settleApproval`, so answering it in any one of the three places leaves the other two
// showing it decided and a second press there is refused by the runtime. Nothing here answers, allows, denies or dismisses an ask.
//
// `SideBySideView` takes everything it shows as props and uses no hooks, so a test can draw it and press its parts; the chat and the
// ask card arrive as nodes because they read the stores. `SideBySide` reads the stores and fills the view.
import "./jobview.css";
import { useMemo, useState, type ReactNode } from "react";
import { elapsed } from "../app/time";
import { t } from "../i18n";
import type { Bot } from "../lib/protocol";
import { modelName } from "../runs/format";
import { Timeline } from "../chat/parts/Timeline";
import { CardFallback } from "../chat/parts/fallbacks";
import { slots } from "../features";
import { useNow } from "../elsewhere/useNow";
import { laneTag, type LaneStatus } from "../code/lane";
import { openLane, useLaneRows, type LaneRow } from "../code/Lanes";
import { AgentMark } from "../sessions/AgentMark";
import { SessionFace } from "../sessions/SessionFace";
import { agentLabel, type AgentId, type SessionRec } from "../sessions/agents";
import { getSessions, useSessions } from "../sessions/sessions";
import { selectAsks, useStore } from "../state/store";
import { Icon } from "../ui/icons";
import type { AskPick } from "./ask";
import { Gathered, type GatheredInput } from "./GatheredBlock";
import { lastAnswer, tally, answerState } from "./gathered";

/** The tab that stands for the Gathered block where the columns are tabs. */
export const GATHERED_TAB = "gathered";

/** One column: a lane of the job as the view draws it. */
export interface JobColumn {
  /** The lane's session id. */
  id: string;
  agentId: AgentId;
  /** The agent's name, and the model it runs on as people say it ("" until the agent named one). */
  agent: string;
  model: string;
  /** The lane's own branch ("" for none). */
  branch: string;
  status: LaneStatus;
  /** The step a working lane is on and since when its turn runs (ms), as the Lanes band tags it. */
  step: string;
  since: number | null;
  testing: boolean;
  /** The lane's turn runs, so Stop has a turn to stop. */
  stoppable: boolean;
  /** The lane's chat, compact and read-only. */
  chat: ReactNode;
  /** The ask cards that wait in the lane, or none. */
  asks: ReactNode;
}

export interface SideBySideProps {
  /** The job's name: its message's first words. */
  title: string;
  columns: JobColumn[];
  /** The time now (ms), for the time a working lane's turn has run. */
  now: number;
  /** The column the tabs show where the columns do not fit side by side. */
  active: string;
  onActive: (id: string) => void;
  onBack: () => void;
  onOpenLane: (id: string) => void;
  onStop: (id: string) => void;
  /** Stop all is asking once (`confirm`), is confirmed, or is withdrawn. */
  confirm: boolean;
  onStopAll: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onAgain: () => void;
  /** The Gathered block (item 102c), drawn under the columns, and its tab's words ("Gathered 2/3"). Left out: no block. */
  gathered?: ReactNode;
  gatheredTab?: string;
}

/** A lane's state as a tag: Working with the step and its time, else the words the Lanes band uses. */
export function StateTag({ c, now }: { c: Pick<JobColumn, "id" | "status" | "step" | "since" | "testing">; now: number }) {
  const tag = laneTag(c.status);
  return (
    <span className={`tag ${tag.tone}`.trim()} data-testid={`jv-state-${c.id}`} data-status={c.status}>
      {c.status === "working" ? (
        <>
          {c.testing ? t("lane.testing") : c.step || t(tag.key)}
          {c.since !== null && <span className="when">{elapsed(now - c.since)}</span>}
        </>
      ) : (
        t(tag.key)
      )}
    </span>
  );
}

export function SideBySideView(p: SideBySideProps) {
  const running = p.columns.filter((c) => c.stoppable);
  return (
    <div className="jv" data-testid="jv" data-tab={p.active === GATHERED_TAB ? "gathered" : "lane"} style={{ "--jv-n": p.columns.length } as React.CSSProperties}>
      <div className="jv-bar">
        <button type="button" className="btn jv-back" onClick={p.onBack} data-testid="jv-back">
          <Icon name="chevron-left" size={14} />
          {t("jobview.back")}
        </button>
        <span className="jv-title" data-testid="jv-title">
          {t("several.jobRow", { n: p.columns.length, title: p.title })}
        </span>
        <span className="jv-bar-acts">
          {p.confirm ? (
            <span className="jv-confirm" role="alertdialog" aria-label={t("jobview.stopAllAsk", { n: running.length })} data-testid="jv-stopall-ask">
              <span>{t("jobview.stopAllAsk", { n: running.length })}</span>
              <button type="button" className="btn jv-keep" onClick={p.onCancel} data-testid="jv-stopall-keep">
                {t("jobview.keep")}
              </button>
              <button type="button" className="btn jv-stop" onClick={p.onConfirm} data-testid="jv-stopall-yes">
                {t("jobview.stopAll")}
              </button>
            </span>
          ) : (
            <>
              <button type="button" className="btn" onClick={p.onAgain} title={t("jobview.againTip")} data-testid="jv-again">
                {t("jobview.again")}
              </button>
              <button type="button" className="btn jv-stop" disabled={running.length === 0} onClick={p.onStopAll} title={running.length === 0 ? t("jobview.nothingRuns") : undefined} data-testid="jv-stopall">
                {t("jobview.stopAll")}
              </button>
            </>
          )}
        </span>
      </div>
      {/* where the columns do not fit side by side the tabs stand in: each says whose it is and its state, and a lane that asks shows it */}
      <div className="jv-tabs" role="tablist" aria-label={t("jobview.tabs")} data-testid="jv-tabs">
        {p.columns.map((c) => (
          <button key={c.id} type="button" role="tab" className="jv-tab" aria-selected={p.active === c.id} onClick={() => p.onActive(c.id)} data-testid={`jv-tab-${c.id}`}>
            <AgentMark agent={c.agentId} size={14} />
            <span className="jv-tab-n">{c.agent}</span>
            <StateTag c={c} now={p.now} />
          </button>
        ))}
        {p.gathered && (
          <button type="button" role="tab" className="jv-tab" aria-selected={p.active === GATHERED_TAB} onClick={() => p.onActive(GATHERED_TAB)} data-testid="jv-tab-gathered">
            <span className="jv-tab-n">{p.gatheredTab}</span>
          </button>
        )}
      </div>
      <div className="jv-cols" data-testid="jv-cols">
        {p.columns.map((c) => (
          <section key={c.id} className="jv-col" aria-label={t("jobview.chatLabel", { agent: c.agent })} data-testid={`jv-col-${c.id}`} data-active={p.active === c.id ? "true" : "false"} data-status={c.status}>
            <header className="jv-h">
              <span className="jv-who">
                <AgentMark agent={c.agentId} size={16} />
                <span className="jv-agent" data-testid={`jv-agent-${c.id}`}>
                  {c.agent}
                </span>
                <span className="mut jv-model" data-testid={`jv-model-${c.id}`}>
                  {c.model || t("several.own")}
                </span>
              </span>
              {c.branch && (
                <span className="mono mut jv-branch" title={c.branch} data-testid={`jv-branch-${c.id}`}>
                  {c.branch}
                </span>
              )}
              <StateTag c={c} now={p.now} />
            </header>
            <div className="jv-chat" data-testid={`jv-chat-${c.id}`}>
              {c.chat}
            </div>
            {c.asks && (
              <div className="jv-asks" data-testid={`jv-asks-${c.id}`}>
                {c.asks}
              </div>
            )}
            <footer className="jv-acts">
              <button type="button" className="btn" onClick={() => p.onOpenLane(c.id)} data-testid={`jv-open-${c.id}`}>
                {t("jobview.openLane")}
              </button>
              <button type="button" className="btn jv-stop" disabled={!c.stoppable} onClick={() => p.onStop(c.id)} title={c.stoppable ? undefined : t("jobview.nothingRuns")} data-testid={`jv-stop-${c.id}`}>
                {t("jobview.stop")}
              </button>
            </footer>
          </section>
        ))}
      </div>
      {p.gathered && (
        <div className="jv-gathered" data-testid="jv-gathered" data-active={p.active === GATHERED_TAB ? "true" : "false"}>
          {p.gathered}
        </div>
      )}
    </div>
  );
}

// ---- what reads the stores -----------------------------------------------------------------------------------------------

/** The lane's own chat, compact: the same `Timeline` as the lane's page, with no box under it, and its open ask cards left for the
 *  column to draw under it. */
function LaneChat({ rec, chatKey }: { rec: SessionRec; chatKey: string }) {
  const s = useStore();
  const ss = useSessions();
  const chat = s.chats[chatKey];
  const label = agentLabel(rec.agent, ss.agents);
  const bot: Bot = {
    name: chatKey,
    display_name: label,
    is_default: false,
    model: rec.model || label,
    provider: "",
    description: "",
    status: rec.status === "running" ? "online" : rec.status === "starting" ? "starting" : "offline",
    running: !!chat?.turn,
  };
  const face = useMemo(() => <SessionFace chatKey={chatKey} size={22} />, [chatKey]);
  return <Timeline bot={bot} face={face} connectionNotice={false} hideOpenAsks />;
}

/** The ask cards waiting in the lane: the card of the lane's own chat, never a copy, so they settle once. */
function LaneAsks({ chatKey }: { chatKey: string }) {
  const s = useStore();
  const Card = slots.cards ?? CardFallback;
  const asks = selectAsks(s).filter((a) => a.bot === chatKey);
  if (asks.length === 0) return null;
  return (
    <>
      {asks.map((a) => (
        <Card key={a.item.id} bot={chatKey} item={a.item} />
      ))}
    </>
  );
}

/** What Ask them again fills in: the rows the lanes were started with and the message the first of them was given. */
export interface Again {
  cwd: string;
  picks: AskPick[];
  text: string;
}

/** The job `job` side by side. `onAgain` leaves the view for Ask several's panel, filled in. */
export function SideBySide({ job, onBack, onAgain }: { job: string; onBack: () => void; onAgain: (a: Again) => void }) {
  const ss = useSessions();
  const app = useStore();
  const recs = ss.list.filter((r) => r.job === job && r.status !== "draft").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const root = recs[0]?.cwd ?? "";
  const rows = useLaneRows(root);
  const byId = new Map(rows.filter((r) => r.job === job).map((r) => [r.id, r] as const));
  const here = recs.filter((r) => byId.has(r.id));
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const active = picked && (picked === GATHERED_TAB || here.some((r) => r.id === picked)) ? picked : (here[0]?.id ?? "");
  const now = useNow(here.some((r) => byId.get(r.id)?.status === "working"), 1_000);
  const sessions = getSessions();
  const keyOf = (id: string) => sessions.chatKey(id) ?? "";
  const columns: JobColumn[] = here.map((rec) => {
    const row = byId.get(rec.id) as LaneRow;
    const key = keyOf(rec.id);
    return {
      id: rec.id,
      agentId: rec.agent,
      agent: row.agent,
      model: rec.model ? modelName(rec.model) : "",
      branch: row.branch?.name ?? "",
      status: row.status,
      step: row.step,
      since: row.since,
      testing: row.testing,
      stoppable: row.since !== null,
      chat: <LaneChat rec={rec} chatKey={key} />,
      asks: <LaneAsks chatKey={key} />,
    };
  });
  // a column's asks node is empty while nothing waits: leave the slot out then
  const waiting = (id: string) => selectAsks(app).some((a) => a.bot === keyOf(id));
  const shown = columns.map((c) => (waiting(c.id) ? c : { ...c, asks: null }));
  if (here.length === 0)
    return (
      <div className="jv jv-none" data-testid="jv-none">
        <p className="mut">{t("jobview.none")}</p>
        <button type="button" className="btn" onClick={onBack} data-testid="jv-back">
          {t("jobview.back")}
        </button>
      </div>
    );
  const first = recs.find((r) => app.chats[keyOf(r.id)]?.items.some((i) => i.kind === "user"));
  const text = first ? ((app.chats[keyOf(first.id)]?.items.find((i) => i.kind === "user") as { text?: string } | undefined)?.text ?? "") : "";
  // Answer: the lane's column comes forward (its tab where they are tabs), and its ask card is brought into view
  const answer = (id: string) => {
    setPicked(id);
    requestAnimationFrame(() => document.querySelector(`[data-testid="jv-col-${id}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  // the Gathered block reads each lane's last answer from its chat, and its files and tests as the lane's pane does
  const inputs: GatheredInput[] = here.map((rec) => {
    const row = byId.get(rec.id) as LaneRow;
    const key = keyOf(rec.id);
    return { id: rec.id, agentId: rec.agent, agent: row.agent, model: rec.model ? modelName(rec.model) : "", status: row.status, answer: lastAnswer(app.chats[key]?.messages), error: row.error, chatKey: key, dir: row.dir };
  });
  const count = tally(inputs.map((i) => answerState({ status: i.status, answer: i.answer })));
  return (
    <SideBySideView
      gathered={<Gathered inputs={inputs} onAnswer={answer} />}
      gatheredTab={t("gathered.tab", { n: count.answered, total: count.total })}
      title={byId.get(here[0].id)?.title ?? ""}
      columns={shown}
      now={now}
      active={active}
      onActive={setPicked}
      onBack={onBack}
      onOpenLane={openLane}
      onStop={(id) => void sessions.interrupt(id)}
      confirm={confirm}
      onStopAll={() => setConfirm(true)}
      onCancel={() => setConfirm(false)}
      onConfirm={() => {
        setConfirm(false);
        for (const c of shown) if (c.stoppable) void sessions.interrupt(c.id);
      }}
      onAgain={() => onAgain({ cwd: root, text, picks: here.map((r) => ({ agent: r.agent, model: r.modelWant || r.model || "", effort: r.effort || "" })) })}
    />
  );
}
