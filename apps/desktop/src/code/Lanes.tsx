// Kit's lanes on the Code page (the design canvas's Code board and its StatesCode board): a band with one row for each coding
// session of the project that runs as a chat in the app. A row has the lane's title, who works on it, the branch Kit made for
// it, and its state as a tag, with a line under it for what the state means: what Kit asks, how many tests passed or which
// failed, that the turn was reverted. The state comes from lane.ts, which reads it from what the session's events showed.
// `LanesView` takes the rows and the time as props and reads only the row marks (sidebar/rows.ts, item 76: pinned on top, settled below,
// snoozed and archived put away behind one line), so a test can draw it; `useLaneRows` reads the stores.
//
// The canvas's New lane is the band's quiet link (item 68). It is not a second way to start a lane: it opens the + menu on its
// Chat with Kit choice, with the folder chip on this project, so which agent and which folder are chosen where they always
// were. The band shows with that link while the project has no lane, since a person with none has the most need of it.
// The canvas's Open pull request is Put up for review under the row (item 75, Review.tsx, filled in by `below`): the app pushes
// the lane's branch and opens its pull request only after one ask that names exactly what goes, settled once, because going live
// always asks; Tasks is still where pull requests are read. Revert this turn is not here: Rewind (the session's line under the
// box) is the way to take a turn back, and a lane is started from the Code page's + menu, Chat with Kit (item 66, docs/code-editor.md), which New lane opens. A lane that
// was rewound says Reverted, and offers Bring it back while the shell still keeps the files from before the rewind (until the
// next turn starts): its panel (BringBack.tsx) opens under the row, filled in by `below`.
import { dragRef } from "../chat/box/threadContext";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { elapsed, hhmm } from "../app/time";
import { t } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { agentLabel, folderName, type SessionRec } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import { getHost } from "../sessions/host";
import { workDir } from "./laneBranch";
import { openFolderInEditor, useEditorChoice } from "./editor";
import { getSessions, useSessions, type AgentLive } from "../sessions/sessions";
import { pickTitle } from "../sessions/titles";
import { askText, getStore, selectAsks, useStore } from "../state/store";
import { failedNames, laneLine, laneStatus, laneTag, testState, type LaneRecord, type LaneStatus } from "./lane";
import { isLaneChat, laneOf, useLanesVersion } from "./laneStore";
import type { Say } from "./command";
import { useLanePulls, usePullsVersion, type LanePull } from "../tasks/pulls";
import { asLanePull, chatPullOf, useChatPullsVersion } from "./chatPull";
import { MoreButton, settledWhy, useRowMenu } from "../sidebar/RowMenu";
import { MenuIcon } from "../ui/MenuIcon";
import { Icon } from "../ui/icons";
import "../jobs/ask.css";
import { AgentMark } from "../sessions/AgentMark";
import { arrange, sessionRowKey, settleDue, settleRows, untilWord, useRowMarks, type RowMark, type RowMarks, type RowPlace } from "../sidebar/rows";
import { useInbox } from "../sidebar/inbox";

/** A lane's row key for its marks. */
export const laneKey = (row: Pick<LaneRow, "id" | "rowKey">): string => row.rowKey ?? sessionRowKey({ id: row.id });

/** The branch a lane's row shows, and why: Kit's own for the lane (with the folder of its own it works in), the folder's
 *  branch now that it is not the lane's, or the folder's own for a lane that made none. */
export type LaneBranchTag =
  | { name: string; kind: "own"; base: string; dir?: string }
  | { name: string; kind: "moved"; base: string; lane: string }
  | { name: string; kind: "folder" };

export interface LaneRow {
  /** The session's id. */
  id: string;
  /** Its row's key for the marks (sidebar/rows.ts `sessionRowKey`): its own folder, else the session's link id, so a lane's pin or
   *  snooze lasts across a restart (item 94). None (a test's row): by its id. */
  rowKey?: string;
  /** The folder of its own the lane works in, where its main-moved note reads git; null: it works in the session's folder. */
  dir: string | null;
  /** The folder the lane works in (`workDir`): its own folder when it has one, else the session's. What Open in <editor> opens. */
  folder?: string;
  /** The lane's worktree, the folder the app made for it (lane.rs): what Put up for review names to the shell (Review.tsx). */
  worktree?: string;
  title: string;
  /** The agent's name, as the session's row names it. */
  agent: string;
  /** The agent's id, which its mark is drawn by (item 122). */
  agentId?: string;
  branch: LaneBranchTag | null;
  status: LaneStatus;
  line: Say | null;
  failed: { names: string[]; more: number };
  /** A turn runs: the step it names (the agent's own words, "" when it names none) and when it began (ms). */
  step: string;
  since: number | null;
  /** The turn is running the tests. */
  testing: boolean;
  /** The session's own words for how it ended in an error. */
  error: string;
  /** The open pull request made from the lane's branch, when the app has read one (tasks/pulls.ts); set by `useLaneRows`. */
  pull?: LanePull;
  /** The host said the pull request from the lane's own branch merged (tasks/pulls.ts `mergedFor`); set by `useLaneRows` (item 94). */
  merged?: boolean;
  /** When the last message either way was in its chat (ms), else when it started: what its quiet days count from (item 94). */
  lastAt?: number;
  /** The lane is Reverted by a rewind that put the files back, and the shell still keeps the files from before it: the row
   *  offers Bring it back. */
  canBringBack: boolean;
  /** The job (Ask several agents, item 102a) whose one message started the lane; the band groups a job's lanes under one row. */
  job?: string;
  /** When the lane was started (ms): the order of a job's lanes under its row. */
  startedAt?: number;
  /** A helper lane (item 102h): its lead's session, its number (Helper 1 is 1) and its lead's title. The band draws it indented under
   *  its lead's row while that row is listed. */
  helper?: { lead: string; n: number; leadTitle: string };
  /** The agent's id and the lane's title as a job's row names them are `agentId` and `title`. */
}

export interface LaneRowInput {
  rec: Pick<SessionRec, "id" | "agent" | "cwd" | "status"> & Partial<Pick<SessionRec, "title" | "modelTitle" | "agentTitle" | "promptTitle" | "error" | "lane" | "linkId" | "startedAt" | "job" | "helperOf">>;
  agent: string;
  /** A helper lane's lead's title, as its row names it (item 102h). */
  leadTitle?: string;
  live?: Pick<AgentLive, "branch">;
  lane: LaneRecord;
  /** The chat's running turn, if one runs. */
  turn: { status: string; startedAt: number } | null;
  /** The words of each ask that waits, oldest first. */
  asks: string[];
  /** The shell keeps the files as they were just before the session's last rewind (the turn book's `backs`). */
  canBringBack?: boolean;
  /** When the last message either way was in its chat (ms); none: it has none yet. */
  lastMessage?: number;
}

/** The branch a lane works on and the branch it was made from (`lane.base`), while its folder is on that branch: what the lane's
 *  main-moved note reads (MainMoved.tsx), in the lane's own folder. None for a lane with no branch of its own, and for one whose
 *  folder has left its branch, since the shell answers for the checked-out branch and has nothing to say about this lane's. */
export function laneBase(row: Pick<LaneRow, "branch">): { branch: string; base: string } | null {
  const b = row.branch;
  return b && b.kind === "own" ? { branch: b.name, base: b.base } : null;
}

/** The row of one lane. `time` writes a time of day. */
export function laneRowOf(i: LaneRowInput, time: (ms: number) => string = (ms) => hhmm(new Date(ms))): LaneRow {
  const { rec, lane, turn } = i;
  const own = rec.lane;
  // the branch of the folder the lane works in (its own), as last read
  const now = i.live?.branch ?? "";
  let branch: LaneBranchTag | null = null;
  if (own) branch = now && now !== own.name ? { name: now, kind: "moved", base: own.base, lane: own.name } : { name: own.name, kind: "own", base: own.base, ...(own.dir ? { dir: own.dir } : {}) };
  else if (now) branch = { name: now, kind: "folder" };

  const ended = rec.status === "failed" || (rec.status === "exited" && !!rec.error);
  const status = laneStatus({ ended, working: !!turn, asks: i.asks.length, reverted: lane.revertedAt !== undefined, test: testState(lane) });
  const error = rec.error ?? "";
  // when the turn was rewound, or its files brought back
  const at = lane.revertedAt ?? lane.backAt;
  return {
    id: rec.id,
    rowKey: sessionRowKey(rec),
    dir: own?.dir ?? null,
    folder: workDir(rec),
    ...(own?.worktree ? { worktree: own.worktree } : {}),
    title: pickTitle(rec, folderName(rec.cwd)).title,
    agent: i.agent,
    agentId: rec.agent,
    branch,
    status,
    // a lane works on a separate branch only while its folder is on it
    line: laneLine({ status, lane, branch: branch?.kind === "own", ask: i.asks[0], time: at === undefined ? undefined : time(at), error }),
    failed: status === "tests_failed" ? failedNames(lane) : { names: [], more: 0 },
    step: turn?.status ?? "",
    since: turn?.startedAt ?? null,
    testing: testState(lane) === "running",
    error,
    // only a rewind that put the files back has files to bring back: the agent's own rewind of the last message left them
    canBringBack: status === "reverted" && lane.revertedFiles === true && i.canBringBack === true,
    ...(rec.job ? { job: rec.job } : {}),
    ...(rec.helperOf ? { helper: { lead: rec.helperOf.lead, n: rec.helperOf.index + 1, leadTitle: i.leadTitle ?? "" } } : {}),
    ...(rec.startedAt !== undefined ? { startedAt: rec.startedAt } : {}),
    ...(rec.startedAt !== undefined || i.lastMessage !== undefined ? { lastAt: Math.max(rec.startedAt ?? 0, i.lastMessage ?? 0) } : {}),
  };
}

/** The lanes of the project at `root`: its coding sessions that run as a chat, newest first. */
export function useLaneRows(root: string): LaneRow[] {
  const ss = useSessions();
  const app = useStore();
  useLanesVersion();
  const sessions = getSessions();
  // the sessions whose last rewind's files the shell still keeps (the turn book): a lane offers Bring it back for those
  const book = sessions.turns;
  const { backs } = useSyncExternalStore(book.subscribe, book.getState, book.getState);
  const here = pathKey(root);
  const asks = selectAsks(app);
  const rows = ss.list.flatMap((rec) => {
    if (!root || rec.status === "draft" || pathKey(rec.cwd) !== here) return [];
    // a session in its own terminal has no chat to read a lane from, and a Hermes folder chat is not a coding agent's
    const key = sessions.chatKey(rec.id);
    if (!isLaneChat(key)) return [];
    const turn = app.chats[key]?.turn;
    // a helper lane names its lead (item 102h)
    const lead = rec.helperOf ? ss.list.find((x) => x.id === rec.helperOf!.lead) : undefined;
    return [
      laneRowOf({
        rec,
        agent: agentLabel(rec.agent, ss.agents),
        ...(lead ? { leadTitle: pickTitle(lead, folderName(lead.cwd)).title } : {}),
        live: ss.live[rec.id],
        lane: laneOf(key),
        turn: turn ? { status: turn.status, startedAt: turn.startedAt } : null,
        // the ask as plain words: its command sits between backticks for a place that draws markdown
        asks: asks.filter((a) => a.bot === key).map((a) => maskSecrets(askText(a.item)).replaceAll("`", "")),
        canBringBack: backs[rec.id] !== undefined,
        // seconds, as a message's time is kept
        lastMessage: (app.chats[key]?.messages ?? []).reduce((m, x) => Math.max(m, x.ts * 1000), 0) || undefined,
      }),
    ];
  });
  useChatPullsVersion();
  usePullsVersion();
  // each lane with a branch of its own gets the open pull request made from it, when the app has read one (tasks/pulls.ts)
  const pulls = useLanePulls(
    root,
    rows.flatMap((r) => (r.branch?.kind === "own" ? [r.branch.name] : [])),
  );
  return rows.map((r) => {
    const own = r.branch?.kind === "own" ? r.branch.name : null;
    // and any chat that opened a pull request itself shows it the same way (item 100, code/chatPull.ts)
    const pull = (own ? pulls.open.get(own) : undefined) ?? asLanePull(chatPullOf(sessions.chatKey(r.id))) ?? undefined;
    const merged = own !== null && pulls.merged.has(own);
    return pull || merged ? { ...r, ...(pull ? { pull } : {}), ...(merged ? { merged } : {}) } : r;
  });
}

/** A lane settles by itself (item 94, sidebar/rows.ts `settleDue`) while the Code page lists it: when the host said its pull request
 *  merged, or after the quiet days Settings names. The one open in the main column, one whose turn runs and one that asks are left
 *  alone, and so is one the person marked. */
export function useLaneSettle(rows: readonly LaneRow[]): void {
  const inbox = useInbox();
  const marks = useRowMarks();
  const app = useStore();
  const open = app.ui.view === "session" ? app.ui.session : null;
  const due = settleDue(
    rows.map((r) => ({ key: laneKey(r), last: r.lastAt ?? null, needs: r.status === "needs_you", working: r.status === "working", merged: r.merged === true })),
    marks,
    Date.now(),
    { quietDays: inbox.quietDays, merged: inbox.merged },
    rows.find((r) => r.id === open) ? laneKey(rows.find((r) => r.id === open)!) : null,
  );
  const dueKey = due.map((d) => `${d.key}:${d.action.why}`).join("\n");
  useEffect(() => {
    if (due.length) settleRows(due);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueKey]);
}

/** Opens the session of a lane in the main column, as a notification would. */
export const openLane = (id: string): void => getStore().actions.openSession(id);

export interface LanesProps {
  rows: LaneRow[];
  /** The time now (ms), for the time a turn has run. */
  now: number;
  onOpen: (id: string) => void;
  /** The pull request on a lane's row was pressed: Tasks opens on it. Without it the chip is shown and does nothing. */
  onPull?: (pull: LanePull, id: string) => void;
  /** New lane: opens the + menu's Chat with Kit choice for this project. Without it the band has no link, and none draws no band. */
  onNew?: () => void;
  /** The lane whose Bring it back is open, and the link on its line that opens or closes it. */
  backOpen?: string | null;
  onBack?: (id: string) => void;
  /** What a row shows under its line: Bring it back's panel (the Code page fills it, since the panel reads the stores). */
  below?: (row: LaneRow) => ReactNode;
  /** What the person did to each row (sidebar/rows.ts), by the session's row key; none: every lane is where it was. */
  marks?: RowMarks;
  /** The line that opens the snoozed and archived lanes is open, and the link that opens or closes it. */
  away?: boolean;
  onAway?: () => void;
  /** The jobs whose lanes are shown under their row, and the press that opens or closes one. */
  jobOpen?: readonly string[];
  onJob?: (job: string) => void;
}

/** A job's lanes in the order they started, with the job's name: the first message's words, as each lane is titled. */
export interface JobGroup {
  job: string;
  title: string;
  lanes: LaneRow[];
}

/** The jobs among `rows` (item 102a): a job with two or more lanes shown is one group, placed where its first lane stands; `head`
 *  maps that first lane's id to the group and `skip` holds the ids of the other lanes, which are drawn under the group. A job with
 *  a single lane left (the person closed the others) is not grouped: its lane is an ordinary row. */
export function jobGroups(rows: readonly LaneRow[]): { head: Map<string, JobGroup>; skip: Set<string> } {
  const by = new Map<string, LaneRow[]>();
  for (const r of rows) if (r.job) by.set(r.job, [...(by.get(r.job) ?? []), r]);
  const head = new Map<string, JobGroup>();
  const skip = new Set<string>();
  for (const [job, lanes] of by) {
    if (lanes.length < 2) continue;
    const ordered = [...lanes].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    head.set(lanes[0].id, { job, title: ordered[0].title, lanes: ordered });
    for (const l of lanes.slice(1)) skip.add(l.id);
  }
  return { head, skip };
}

/** The helper lanes among `rows` whose lead is listed too (item 102h): `of` maps a lead's id to its helper lanes in their round order,
 *  and `under` holds the ids drawn under their lead rather than as rows of their own. */
export function helperGroups(rows: readonly LaneRow[]): { of: Map<string, LaneRow[]>; under: Set<string> } {
  const ids = new Set(rows.map((r) => r.id));
  const of = new Map<string, LaneRow[]>();
  const under = new Set<string>();
  for (const r of rows) {
    if (!r.helper || !ids.has(r.helper.lead) || r.helper.lead === r.id) continue;
    of.set(r.helper.lead, [...(of.get(r.helper.lead) ?? []), r]);
    under.add(r.id);
  }
  for (const list of of.values()) list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || (a.helper!.n - b.helper!.n));
  return { of, under };
}

function JobItem({ group, now, open, onToggle, lane }: { group: JobGroup; now: number; open: boolean; onToggle: () => void; lane: (r: LaneRow) => ReactNode }) {
  const needs = group.lanes.some((l) => l.status === "needs_you");
  return (
    <div className="lane lane-job" data-testid={`lane-job-${group.job}`} data-job={group.job} data-needs={needs ? "true" : undefined}>
      <button type="button" className="rowl job-head" aria-expanded={open} onClick={onToggle} title={t("several.jobTip")} data-testid="lane-job-open">
        <span className="job-chev" aria-hidden="true">
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="grow l1">{t("several.jobRow", { n: group.lanes.length, title: group.title })}</span>
        <span className="mut who job-who">
          {group.lanes.map((l) => {
            const tag = laneTag(l.status);
            return (
              <span key={l.id} className="job-one" data-testid={`lane-job-agent-${l.id}`} data-status={l.status}>
                {l.agentId && <AgentMark agent={l.agentId} size={16} />}
                <span className={`tag ${tag.tone}`.trim()}>
                  {l.status === "working" ? (
                    <>
                      {l.testing ? t("lane.testing") : l.step || t(tag.key)}
                      {l.since !== null && <span className="when">{elapsed(now - l.since)}</span>}
                    </>
                  ) : (
                    t(tag.key)
                  )}
                </span>
              </span>
            );
          })}
        </span>
      </button>
      {open && (
        <div className="job-lanes" data-testid="lane-job-lanes">
          {group.lanes.map((l) => lane(l))}
        </div>
      )}
    </div>
  );
}

function branchTitle(b: LaneBranchTag): string {
  switch (b.kind) {
    case "own":
      return b.dir ? t("lane.madeFromIn", { base: b.base, folder: b.dir }) : t("lane.madeFrom", { base: b.base });
    case "moved":
      return t("lane.moved", { branch: b.lane, now: b.name });
    case "folder":
      return t("lane.noBranch");
  }
}

function LaneItem({ row, now, onOpen, onPull, backOpen, onBack, below, place, mark }: { row: LaneRow; now: number; onOpen: (id: string) => void; onPull?: LanesProps["onPull"]; place: RowPlace; mark: RowMark | undefined } & Pick<LanesProps, "onBack" | "below"> & { backOpen: boolean }) {
  const tag = laneTag(row.status);
  const line = row.status === "failed" ? row.error : row.line ? t(row.line.key, row.line.vars) : "";
  return (
    <div
      className={`lane${place === "settled" ? " settled" : ""}${row.helper ? " lane-helper" : ""}`}
      data-testid={`lane-${row.id}`}
      data-row-key={laneKey(row)}
      data-status={row.status}
      data-place={place}
      {...(row.helper ? { "data-helper-of": row.helper.lead } : {})}
    >
      {/* dragged onto an open chat's box, the lane brings its context (item 97) */}
      <button type="button" className="rowl" onClick={() => onOpen(row.id)} title={t("lane.open")} {...dragRef({ kind: "session", id: row.id })}>
        {place === "pinned" && (
          <span className="lane-pin" role="img" aria-label={t("row.pinned")} title={t("row.pinned")} data-testid="lane-pin">
            ◆
          </span>
        )}
        <span className="grow l1">{row.title}</span>
        <span className="mut who">
          {row.agentId && <AgentMark agent={row.agentId} size={16} />}
          {t("lane.who", { agent: row.agent })}
        </span>
        {row.branch && (
          <span className="tag mono" title={branchTitle(row.branch)} data-testid="lane-branch" data-kind={row.branch.kind}>
            {row.branch.name}
          </span>
        )}
        <span className={`tag ${tag.tone}`.trim()} data-testid="lane-state">
          {row.status === "working" ? (
            <>
              {row.testing ? t("lane.testing") : row.step || t(tag.key)}
              {row.since !== null && <span className="when">{elapsed(now - row.since)}</span>}
            </>
          ) : (
            t(tag.key)
          )}
        </span>
      </button>
      {row.helper && (
        <p className="mut lline lane-helper-of" data-testid="lane-helper-of">
          {t("helpers.run.laneOf", { n: row.helper.n, lead: row.helper.leadTitle })}
        </p>
      )}
      {row.pull && (
        <p className="mut lline lpull" data-testid="lane-pull-line">
          <button type="button" className="lk" title={t("lane.prTip")} onClick={() => row.pull && onPull?.(row.pull, row.id)} data-testid="lane-pr" data-state={row.pull.state}>
            {t("lane.pr", { n: row.pull.number, state: t(row.pull.state === "draft" ? "tasks.st.draft" : "tasks.st.open") })}
          </button>
        </p>
      )}
      {place === "settled" && settledWhy(mark) && (
        <p className="mut lline" data-testid="lane-why">
          {settledWhy(mark)}
        </p>
      )}
      {line && (
        <p className="mut lline" data-testid="lane-line">
          {line}
          {row.status === "needs_you" && (
            <>
              {" "}
              <button type="button" className="lk" onClick={() => onOpen(row.id)}>
                {t("lane.answer")}
              </button>
            </>
          )}
          {row.canBringBack && (
            <>
              {" "}
              <button type="button" className="lk" aria-expanded={backOpen} onClick={() => onBack?.(row.id)} data-testid="lane-back">
                {t("lane.back")}
              </button>
            </>
          )}
        </p>
      )}
      {row.failed.names.length > 0 && (
        <ul className="lnames mono" data-testid="lane-failed">
          {row.failed.names.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {row.failed.more > 0 && <li className="mut">{t("lane.moreNames", { n: row.failed.more })}</li>}
        </ul>
      )}
      {below?.(row)}
      <LaneMore row={row} mark={mark} />
    </div>
  );
}

/** A lane's menu (Pin, Snooze, Done for now, Archive): the one part of a row that keeps state, so the rest of the view stays a
 *  function of its props. It draws the quiet "more" button, and a right-click anywhere on the row opens the menu too. */
export function LaneMore({ row, mark }: { row: LaneRow; mark: RowMark | undefined }) {
  // Open in <editor>, for the lane's own folder (never the developer's), only while an editor is installed here (code/editor.ts)
  const editor = useEditorChoice(getHost());
  const [why, setWhy] = useState("");
  const folder = row.folder ?? row.dir;
  const menu = useRowMenu({
    rowKey: laneKey(row),
    kind: "lane",
    mark,
    name: row.title,
    working: row.status === "working",
    extra:
      editor && folder
        ? (done) => (
            <button
              type="button"
              role="menuitem"
              className="row-mi"
              onClick={() => {
                done();
                setWhy("");
                void openFolderInEditor(getHost(), folder).catch((e: unknown) => setWhy(e instanceof Error ? e.message : ""));
              }}
              data-testid="lane-open-editor"
            >
              <MenuIcon mark={{ id: editor.id, title: editor.label }} />
              {t("editor.open", { name: editor.label })}
            </button>
          )
        : undefined,
  });
  const here = useRef<HTMLSpanElement>(null);
  const open = menu.open;
  useEffect(() => {
    const lane = here.current?.parentElement;
    if (!lane) return;
    const on = (e: MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY, lane);
    };
    lane.addEventListener("contextmenu", on);
    return () => lane.removeEventListener("contextmenu", on);
  }, [open]);
  return (
    <span ref={here} className="lane-more-wrap">
      <MoreButton name={row.title} onOpen={menu.open} className="lane-more" />
      {menu.menu}
      {why && (
        <span className="lane-editor-why" role="alert" data-testid="lane-editor-why">
          {why}
        </span>
      )}
    </span>
  );
}

/** Words for where a put-away lane is: Snoozed until a time, or Archived. */
function awayWord(mark: RowMark | undefined, now: number): string {
  if (mark?.archived !== undefined) return t("row.archived");
  if (mark?.untilDone !== undefined) return t("row.snoozedDone");
  return mark?.snoozed !== undefined ? t("row.snoozed", { when: untilWord(mark.snoozed, now) }) : "";
}


export function LanesView({ rows, now, onOpen, onPull, onNew, backOpen = null, onBack, below, marks = {}, away = false, onAway, jobOpen = [], onJob }: LanesProps) {
  if (rows.length === 0 && !onNew) return null;
  // pinned on top, in the order pinned, then the rest, then the settled ones, small and quiet. Snoozed and archived lanes are put
  // away: a line under the list counts them and opens them. A lane that asks something is never put away (rows.ts `placeOf`).
  const places = arrange(
    rows.map((r) => ({ key: laneKey(r), needs: r.status === "needs_you", working: r.status === "working", r })),
    marks,
    now,
  );
  const shown: { r: LaneRow; place: RowPlace }[] = [
    ...places.pinned.map((x) => ({ r: x.r, place: "pinned" as const })),
    ...places.normal.map((x) => ({ r: x.r, place: "normal" as const })),
    ...places.settled.map((x) => ({ r: x.r, place: "settled" as const })),
  ];
  const hidden = [...places.snoozed, ...places.archived];
  // the lanes one Ask several message started (item 102a) are one row, whose lanes open under it; a job with one lane left shows as it is
  const jobs = jobGroups(shown.map((x) => x.r));
  // a helper lane is drawn indented under its lead's row while that row is listed here (item 102h); one whose lead is not is a row
  const helpers = helperGroups(shown.map((x) => x.r));
  const isShown = (id: string) => !jobs.skip.has(id) && !helpers.under.has(id);
  const one = (r: LaneRow, place: RowPlace) => <LaneItem key={r.id} row={r} now={now} onOpen={onOpen} onPull={onPull} backOpen={backOpen === r.id} onBack={onBack} below={below} place={place} mark={marks[laneKey(r)]} />;
  const item = (r: LaneRow, place: RowPlace) => {
    const mine = helpers.of.get(r.id);
    if (!mine) return one(r, place);
    return (
      <div key={r.id} className="lane-with-helpers" data-testid={`lane-with-helpers-${r.id}`}>
        {one(r, place)}
        <div className="lane-helpers" data-testid={`lane-helpers-${r.id}`}>
          {mine.map((h) => one(h, shown.find((x) => x.r.id === h.id)?.place ?? place))}
        </div>
      </div>
    );
  };
  return (
    <>
      <div className="band" data-testid="lanes-band">
        <span>{t("lane.title")}</span>
        {onNew && (
          <button type="button" className="lk" onClick={onNew} title={t("lane.newTip")} data-testid="lane-new">
            {t("lane.new")}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="lanes" data-testid="lanes">
          {shown.map(({ r, place }) => {
            const group = jobs.head.get(r.id);
            if (group) return <JobItem key={`job-${group.job}`} group={group} now={now} open={jobOpen.includes(group.job)} onToggle={() => onJob?.(group.job)} lane={(l) => item(l, shown.find((x) => x.r.id === l.id)?.place ?? place)} />;
            return isShown(r.id) ? item(r, place) : null;
          })}
          {hidden.length > 0 && (
            <>
              <button type="button" className="lk lane-away" aria-expanded={away} onClick={onAway} data-testid="lane-away">
                {t("lane.away", { n: hidden.length })}
              </button>
              {away &&
                hidden.map((x) => (
                  <div key={x.r.id} className="lane-away-row" data-testid={`lane-away-${x.r.id}`}>
                    <span className="mut lane-away-word">{awayWord(marks[x.key], now)}</span>
                    {item(x.r, marks[x.key]?.archived !== undefined ? "archived" : "snoozed")}
                  </div>
                ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
