// The Gathered block of the job's side-by-side view (item 102c; `docs/several-agents.md`, "3. The gathered answers"): under the
// columns (a tab of its own where they are tabs), "Gathered: 2 of 3 answered" and, for each lane, its last answer whole once it has
// answered, the files its folder changed and the state of its tests where the lane already knows them (what the lane's pane shows;
// nothing is computed here). A lane that waits on an ask is shown as waiting, not answered, with Answer, which brings its column
// forward. A lane that failed shows its own words.
//
// Compare in a chat opens item 97's Bring context list to pick the chat, and puts one chip of each answered lane in that chat's
// box, built by item 97's own code with no model, unsent. Nothing here sends: it calls `bringContext` and no send. No model writes a
// summary and the app picks no best answer; keeping one is the person's own step.
//
// `GatheredView` and `LaneDetail` take everything as props and use no hooks, so a test can draw them and press their buttons;
// `Gathered` reads the stores, and `LaneFiles` is the lane's own files and tests read through the hooks the lane's pane uses.
import "./gathered.css";
import { useCallback, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { AgentMark } from "../sessions/AgentMark";
import type { AgentId } from "../sessions/agents";
import { getHost } from "../sessions/host";
import { getSessions, useSessions } from "../sessions/sessions";
import { getStore, useStore } from "../state/store";
import { changeMark, filesShown } from "../code/laneFolder";
import { diffsOf, newestFirst } from "../code/changes";
import { laneOf, useLanesVersion } from "../code/laneStore";
import { laneTests, type LaneTests } from "../code/lane";
import { useLaneFolder } from "../code/useLaneFolder";
import { openLane } from "../code/Lanes";
import { BringPicker, bringRows } from "../chat/box/Bring";
import { appReader } from "../chat/box/contextReader";
import { carry, type Carried } from "../chat/box/carry";
import { bringContext, refKey, type ContextReader, type ThreadRef } from "../chat/box/threadContext";
import { answerState, comparable, tally, type AnswerState } from "./gathered";

/** The files a lane changed as the block lists them: the name and its counts. */
export interface GatheredFile {
  path: string;
  added: number;
  removed: number;
}

/** The most files a card lists; the rest are counted. */
export const FILES_LISTED = 8;

/** One lane as the block draws it. */
export interface GatheredLane {
  id: string;
  agentId: AgentId;
  agent: string;
  model: string;
  state: AnswerState;
  /** Its last answer, whole. Drawn only once the state is "answered". */
  answer: string;
  /** The words a failed lane ended with ("" when it gave none). */
  error: string;
  /** Its files and tests, drawn under the answer. */
  detail: ReactNode;
}

/** What Compare in a chat last did, as the block says it. */
export interface CompareNote {
  /** The line: what went into the box, or why a chat's context was refused. */
  lines: string[];
  /** Opens the chat whose box was filled, when it can be opened from here. */
  open?: () => void;
}

export interface GatheredProps {
  lanes: GatheredLane[];
  /** Answer: bring the column of this lane forward. */
  onAnswer: (id: string) => void;
  /** Compare in a chat: the picker is showing (`picker` draws it), pressed, or closed. */
  onCompare: () => void;
  picker: ReactNode;
  note: CompareNote | null;
}

const WHY: Record<Exclude<AnswerState, "answered">, "gathered.none" | "gathered.working" | "gathered.waiting" | "gathered.failed"> = {
  none: "gathered.none",
  working: "gathered.working",
  waiting: "gathered.waiting",
  failed: "gathered.failed",
};

/** The files and the tests of one lane, as its pane keeps them. */
export function LaneDetail({ id, files, more, tests }: { id: string; files: GatheredFile[]; more: number; tests: LaneTests }) {
  const listed = files.slice(0, FILES_LISTED);
  const rest = files.length - listed.length + more;
  const last = tests.last;
  return (
    <>
      <div className="gt-files" data-testid={`gt-files-${id}`}>
        <div className="gt-k">{files.length + more > 0 ? t("gathered.files", { n: files.length + more }) : t("gathered.noFiles")}</div>
        {listed.length > 0 && (
          <ul className="gt-list mono">
            {listed.map((f) => (
              <li key={f.path} title={f.path}>
                <span className="gt-path">{f.path}</span>
                <span className="gt-add">{`+${f.added}`}</span>
                <span className="gt-del">{`-${f.removed}`}</span>
              </li>
            ))}
            {rest > 0 && <li className="mut">{t("gathered.filesMore", { n: rest })}</li>}
          </ul>
        )}
      </div>
      <div className="gt-tests" data-testid={`gt-tests-${id}`}>
        <div className="gt-k">{t("gathered.tests")}</div>
        {last ? (
          <>
            <div className={`gt-result ${last.tone}`.trim()} data-testid={`gt-result-${id}`} data-tone={last.tone}>
              {t(last.say.key, last.say.vars)}
            </div>
            {last.names.length > 0 && (
              <ul className="gt-list mono">
                {last.names.map((n) => (
                  <li key={n}>{n}</li>
                ))}
                {last.more > 0 && <li className="mut">{t("lane.moreNames", { n: last.more })}</li>}
              </ul>
            )}
            {tests.stale && <div className="mut gt-stale">{t("lane.pane.tests.stale")}</div>}
          </>
        ) : tests.running.length > 0 ? (
          <div className="mut">{t("lane.pane.tests.running")}</div>
        ) : (
          <div className="mut">{t("gathered.noTests")}</div>
        )}
      </div>
    </>
  );
}

export function GatheredView({ lanes, onAnswer, onCompare, picker, note }: GatheredProps) {
  const tl = tally(lanes.map((l) => l.state));
  const ids = comparable(lanes);
  const firstWaiting = lanes.find((l) => l.state === "waiting");
  return (
    <div className="gt" data-testid="gt">
      <div className="gt-head">
        <span className="gt-count" data-testid="gt-count" data-over={tl.over ? "true" : "false"}>
          {t("gathered.count", { n: tl.answered, total: tl.total })}
        </span>
        {firstWaiting && (
          <span className="gt-wait" data-testid="gt-wait">
            {t("gathered.waitingCount", { n: tl.waiting })}
            <button type="button" className="btn gt-answer-btn" onClick={() => onAnswer(firstWaiting.id)} data-testid="gt-answer">
              {t("gathered.answer")}
            </button>
          </span>
        )}
        <span className="gt-compare-wrap">
          <button type="button" className="btn" disabled={ids.length === 0} onClick={onCompare} title={ids.length === 0 ? t("gathered.compareNeed") : t("gathered.compareTip")} data-testid="gt-compare">
            {t("gathered.compare")}
          </button>
          {picker}
        </span>
      </div>
      {note && (
        <div className="gt-note" role="status" data-testid="gt-note">
          {note.lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
          {note.open && (
            <button type="button" className="btn" onClick={note.open} data-testid="gt-open">
              {t("gathered.open")}
            </button>
          )}
        </div>
      )}
      <div className="gt-body" data-testid="gt-body" style={{ "--gt-n": lanes.length } as React.CSSProperties}>
        {lanes.map((l) => (
          <section key={l.id} className="gt-lane" aria-label={t("gathered.laneLabel", { agent: l.agent })} data-testid={`gt-lane-${l.id}`} data-state={l.state}>
            <header className="gt-h">
              <AgentMark agent={l.agentId} size={16} />
              <span className="gt-agent">{l.agent}</span>
              <span className="mut gt-model">{l.model || t("several.own")}</span>
            </header>
            {l.state === "answered" ? (
              <>
                {/* the answer whole, in a box that scrolls: keyboard users can reach it to scroll */}
                <div className="gt-answer" tabIndex={0} role="region" aria-label={t("gathered.laneLabel", { agent: l.agent })} data-testid={`gt-answer-${l.id}`}>
                  {l.answer}
                </div>
                {l.detail}
              </>
            ) : (
              <p className={`gt-why ${l.state === "failed" ? "err" : "mut"}`} data-testid={`gt-why-${l.id}`}>
                {l.state === "failed" && l.error ? l.error : t(WHY[l.state])}
                {l.state === "waiting" && (
                  <button type="button" className="btn gt-answer-btn" onClick={() => onAnswer(l.id)} data-testid={`gt-answer-${l.id}-btn`}>
                    {t("gathered.answer")}
                  </button>
                )}
              </p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

// ---- what reads the stores -----------------------------------------------------------------------------------------------

/** One lane's files and tests, read as the lane's pane reads them: the folder where the shell can read it, else what the chat's
 *  events said changed; the tests as the lane's record keeps them. */
export function LaneFiles({ id, chatKey, dir }: { id: string; chatKey: string; dir: string | null }) {
  useLanesVersion();
  const chat = useStore().chats[chatKey];
  const folder = useLaneFolder(dir, changeMark(chat));
  const files = filesShown(folder, newestFirst(diffsOf(chat)));
  return <LaneDetail id={id} files={files.map((f) => ({ path: f.path, added: f.added, removed: f.removed }))} more={folder?.moreFiles ?? 0} tests={laneTests(laneOf(chatKey))} />;
}

/** What the block reads of each lane, handed in by the view (it already holds the lanes' rows). `ref` is the lane's session. */
export type GatheredInput = Omit<GatheredLane, "state" | "detail"> & { status: Parameters<typeof answerState>[0]["status"]; chatKey: string; dir: string | null };

/** The block for the lanes of a job. `onAnswer` brings a lane's column forward. */
export function Gathered({ inputs, onAnswer }: { inputs: GatheredInput[]; onAnswer: (id: string) => void }) {
  const store = useStore();
  useSessions();
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<CompareNote | null>(null);
  const lanes: GatheredLane[] = inputs.map((i) => ({
    id: i.id,
    agentId: i.agentId,
    agent: i.agent,
    model: i.model,
    state: answerState({ status: i.status, answer: i.answer }),
    answer: i.answer,
    error: i.error,
    detail: <LaneFiles id={i.id} chatKey={i.chatKey} dir={i.dir} />,
  }));
  const rows = useCallback(
    (query: string) => {
      const ss = getSessions();
      return bringRows(store, { list: ss.getState().list, agents: ss.getState().agents, chatKey: ss.chatKey }, query, "");
    },
    [store],
  );
  const bring = async (target: ThreadRef) => {
    setPicking(false);
    setNote(await compareInto(target, comparable(lanes)));
  };
  const picker = picking ? <BringPicker rows={rows} onPick={(r) => void bring(r)} onClose={() => setPicking(false)} /> : null;
  return <GatheredView lanes={lanes} onAnswer={onAnswer} onCompare={() => (setNote(null), setPicking(true))} picker={picker} note={note} />;
}

/** Opens a chat the person picked, as the rows of History and the Lanes band open one. */
const openChat = (target: ThreadRef): void => (target.kind === "session" ? openLane(target.id) : void getStore().actions.openThread(target.bot, target.thread));

/** The answered lanes' context, one chip each, into the box of the chat `target`: item 97's own path (`bringContext`), which reads
 *  each lane only and sends nothing. A lane that is the target itself is left out (a chat does not carry itself). Says what went
 *  in and what was refused, in the words item 97 uses. */
export async function compareInto(
  target: ThreadRef,
  laneIds: readonly string[],
  /** What reads the chats (the app's own by default) and where a chip goes (the box's own store), handed in so a test can stand in. */
  reader: ContextReader = appReader({ store: getStore(), sessions: getSessions(), host: getHost() }),
  put: (key: string, chip: Carried) => "notes" | "threads" | "same" | null = carry,
  open: (target: ThreadRef) => void = openChat,
): Promise<CompareNote> {
  const key = reader.chatKey(target);
  const title = reader.title(target);
  if (!key) return { lines: [t("gathered.gone", { title })] };
  const to = { key, scope: reader.scope(key) };
  const lines: string[] = [];
  let added = 0;
  for (const id of laneIds) {
    const ref: ThreadRef = { kind: "session", id };
    if (refKey(ref) === refKey(target)) continue;
    const line = await bringContext(ref, to, reader, put);
    if (line === null) added += 1;
    else if (!lines.includes(line)) lines.push(line);
  }
  const head = added > 0 ? [t("gathered.put", { n: added, title })] : [];
  return { lines: [...head, ...lines], open: added > 0 ? () => open(target) : undefined };
}
