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
// The canvas's Open pull request and Revert this turn are not here. A lane cannot push or open a pull request from
// the app (going live always asks, and Tasks is where pull requests are), Rewind (the session's line under the box) is the way
// to take a turn back, and a lane is started from the Code page's + menu, Chat with Kit (item 66, docs/code-editor.md), which New lane opens. A lane that
// was rewound says Reverted, and offers Bring it back while the shell still keeps the files from before the rewind (until the
// next turn starts): its panel (BringBack.tsx) opens under the row, filled in by `below`.
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { elapsed, hhmm } from "../app/time";
import { t } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { agentLabel, folderName, type SessionRec } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import { getSessions, useSessions, type AgentLive } from "../sessions/sessions";
import { pickTitle } from "../sessions/titles";
import { askText, getStore, selectAsks, useStore } from "../state/store";
import { failedNames, laneLine, laneStatus, laneTag, testState, type LaneRecord, type LaneStatus } from "./lane";
import { isLaneChat, laneOf, useLanesVersion } from "./laneStore";
import type { Say } from "./command";
import { usePullRequests, type LanePull } from "../tasks/pulls";
import { MoreButton, useRowMenu } from "../sidebar/RowMenu";
import { arrange, sessionRowKey, type RowMark, type RowMarks, type RowPlace } from "../sidebar/rows";

/** The branch a lane's row shows, and why: Kit's own for the lane (with the folder of its own it works in), the folder's
 *  branch now that it is not the lane's, or the folder's own for a lane that made none. */
export type LaneBranchTag =
  | { name: string; kind: "own"; base: string; dir?: string }
  | { name: string; kind: "moved"; base: string; lane: string }
  | { name: string; kind: "folder" };

export interface LaneRow {
  /** The session's id. */
  id: string;
  /** The folder of its own the lane works in, where its main-moved note reads git; null: it works in the session's folder. */
  dir: string | null;
  title: string;
  /** The agent's name, as the session's row names it. */
  agent: string;
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
  /** The lane is Reverted by a rewind that put the files back, and the shell still keeps the files from before it: the row
   *  offers Bring it back. */
  canBringBack: boolean;
}

export interface LaneRowInput {
  rec: Pick<SessionRec, "id" | "agent" | "cwd" | "status"> & Partial<Pick<SessionRec, "title" | "agentTitle" | "promptTitle" | "error" | "lane">>;
  agent: string;
  live?: Pick<AgentLive, "branch">;
  lane: LaneRecord;
  /** The chat's running turn, if one runs. */
  turn: { status: string; startedAt: number } | null;
  /** The words of each ask that waits, oldest first. */
  asks: string[];
  /** The shell keeps the files as they were just before the session's last rewind (the turn book's `backs`). */
  canBringBack?: boolean;
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
    dir: own?.dir ?? null,
    title: pickTitle(rec, folderName(rec.cwd)).title,
    agent: i.agent,
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
    return [
      laneRowOf({
        rec,
        agent: agentLabel(rec.agent, ss.agents),
        live: ss.live[rec.id],
        lane: laneOf(key),
        turn: turn ? { status: turn.status, startedAt: turn.startedAt } : null,
        // the ask as plain words: its command sits between backticks for a place that draws markdown
        asks: asks.filter((a) => a.bot === key).map((a) => maskSecrets(askText(a.item)).replaceAll("`", "")),
        canBringBack: backs[rec.id] !== undefined,
      }),
    ];
  });
  // each lane with a branch of its own gets the open pull request made from it, when the app has read one (tasks/pulls.ts)
  const pulls = usePullRequests(
    root,
    rows.flatMap((r) => (r.branch?.kind === "own" ? [r.branch.name] : [])),
  );
  return rows.map((r) => {
    const pull = r.branch?.kind === "own" ? pulls.get(r.branch.name) : undefined;
    return pull ? { ...r, pull } : r;
  });
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
    <div className={`lane${place === "settled" ? " settled" : ""}`} data-testid={`lane-${row.id}`} data-status={row.status} data-place={place}>
      <button type="button" className="rowl" onClick={() => onOpen(row.id)} title={t("lane.open")}>
        {place === "pinned" && (
          <span className="lane-pin" role="img" aria-label={t("row.pinned")} title={t("row.pinned")} data-testid="lane-pin">
            ◆
          </span>
        )}
        <span className="grow l1">{row.title}</span>
        <span className="mut who">{t("lane.who", { agent: row.agent })}</span>
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
      {row.pull && (
        <p className="mut lline lpull" data-testid="lane-pull-line">
          <button type="button" className="lk" title={t("lane.prTip")} onClick={() => row.pull && onPull?.(row.pull, row.id)} data-testid="lane-pr" data-state={row.pull.state}>
            {t("lane.pr", { n: row.pull.number, state: t(row.pull.state === "draft" ? "tasks.st.draft" : "tasks.st.open") })}
          </button>
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
  const menu = useRowMenu({ rowKey: sessionRowKey(row.id), kind: "lane", mark, name: row.title });
  const here = useRef<HTMLSpanElement>(null);
  const open = menu.open;
  useEffect(() => {
    const lane = here.current?.parentElement;
    if (!lane) return;
    const on = (e: MouseEvent) => {
      e.preventDefault();
      open(e.clientX, e.clientY);
    };
    lane.addEventListener("contextmenu", on);
    return () => lane.removeEventListener("contextmenu", on);
  }, [open]);
  return (
    <span ref={here} className="lane-more-wrap">
      <MoreButton name={row.title} onOpen={menu.open} className="lane-more" />
      {menu.menu}
    </span>
  );
}

/** Words for where a put-away lane is: Snoozed until a time, or Archived. */
function awayWord(mark: RowMark | undefined, now: number): string {
  if (mark?.archived !== undefined) return t("row.archived");
  return mark?.snoozed !== undefined ? t("row.snoozed", { when: elapsedUntil(mark.snoozed, now) }) : "";
}

/** A time ahead as the day's time, with the day when it is not today ("09:00", "Thu 09:00"). */
function elapsedUntil(at: number, now: number): string {
  const d = new Date(at);
  const same = d.toDateString() === new Date(now).toDateString();
  return same ? hhmm(d) : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hhmm(d)}`;
}

export function LanesView({ rows, now, onOpen, onPull, onNew, backOpen = null, onBack, below, marks = {}, away = false, onAway }: LanesProps) {
  if (rows.length === 0 && !onNew) return null;
  // pinned on top, in the order pinned, then the rest, then the settled ones, small and quiet. Snoozed and archived lanes are put
  // away: a line under the list counts them and opens them. A lane that asks something is never put away (rows.ts `placeOf`).
  const places = arrange(
    rows.map((r) => ({ key: sessionRowKey(r.id), needs: r.status === "needs_you", r })),
    marks,
    now,
  );
  const shown: { r: LaneRow; place: RowPlace }[] = [
    ...places.pinned.map((x) => ({ r: x.r, place: "pinned" as const })),
    ...places.normal.map((x) => ({ r: x.r, place: "normal" as const })),
    ...places.settled.map((x) => ({ r: x.r, place: "settled" as const })),
  ];
  const hidden = [...places.snoozed, ...places.archived];
  const item = (r: LaneRow, place: RowPlace) => <LaneItem key={r.id} row={r} now={now} onOpen={onOpen} onPull={onPull} backOpen={backOpen === r.id} onBack={onBack} below={below} place={place} mark={marks[sessionRowKey(r.id)]} />;
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
          {shown.map(({ r, place }) => item(r, place))}
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
