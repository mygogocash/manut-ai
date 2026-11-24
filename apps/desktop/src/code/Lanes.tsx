// Kit's lanes on the Code page (the design canvas's Code board and its StatesCode board): a band with one row for each coding
// session of the project that runs as a chat in the app. A row has the lane's title, who works on it, the branch Kit made for
// it, and its state as a tag, with a line under it for what the state means: what Kit asks, how many tests passed or which
// failed, that the turn was reverted. The state comes from lane.ts, which reads it from what the session's events showed.
// `LanesView` takes everything it shows as props and uses no hooks, so a test can draw it; `useLaneRows` reads the stores.
//
// The canvas's Open pull request, Revert this turn and New lane are not here. A lane cannot push or open a pull request from
// the app (going live always asks, and Tasks is where pull requests are), Rewind (the session's line under the box) is the way
// to take a turn back, and the Code page's + menu starts agents in their own terminal only (docs/code-editor.md). A lane that
// was rewound says Reverted, and offers Bring it back while the shell still keeps the files from before the rewind (until the
// next turn starts): its panel (BringBack.tsx) opens under the row, filled in by `below`.
import { useSyncExternalStore, type ReactNode } from "react";
import { elapsed, hhmm } from "../app/time";
import { t } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { agentLabel, folderName, type SessionRec } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import { getSessions, useSessions, type AgentLive } from "../sessions/sessions";
import { pickTitle } from "../sessions/titles";
import { askText, getStore, selectAsks, useStore } from "../state/store";
import { failedNames, laneLine, laneStatus, laneTag, testState, type LaneRecord, type LaneStatus } from "./lane";
import { laneOf, useLanesVersion } from "./laneStore";
import type { Say } from "./command";

/** The branch a lane's row shows, and why: Kit's own for the lane, one shared with a lane already working in the folder, the
 *  folder's branch now that it is not the lane's, or the folder's own for a lane that made none. */
export type LaneBranchTag =
  | { name: string; kind: "own" | "shared"; base: string }
  | { name: string; kind: "moved"; base: string; lane: string }
  | { name: string; kind: "folder" };

export interface LaneRow {
  /** The session's id. */
  id: string;
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

/** The row of one lane. `time` writes a time of day. */
export function laneRowOf(i: LaneRowInput, time: (ms: number) => string = (ms) => hhmm(new Date(ms))): LaneRow {
  const { rec, lane, turn } = i;
  const own = rec.lane;
  const now = i.live?.branch ?? "";
  let branch: LaneBranchTag | null = null;
  if (own) branch = now && now !== own.name ? { name: now, kind: "moved", base: own.base, lane: own.name } : { name: own.name, kind: own.shared ? "shared" : "own", base: own.base };
  else if (now) branch = { name: now, kind: "folder" };

  const ended = rec.status === "failed" || (rec.status === "exited" && !!rec.error);
  const status = laneStatus({ ended, working: !!turn, asks: i.asks.length, reverted: lane.revertedAt !== undefined, test: testState(lane) });
  const error = rec.error ?? "";
  // when the turn was rewound, or its files brought back
  const at = lane.revertedAt ?? lane.backAt;
  return {
    id: rec.id,
    title: pickTitle(rec, folderName(rec.cwd)).title,
    agent: i.agent,
    branch,
    status,
    // a lane works on a separate branch only while the folder is on it
    line: laneLine({ status, lane, branch: branch?.kind === "own" || branch?.kind === "shared", ask: i.asks[0], time: at === undefined ? undefined : time(at), error }),
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
  if (!root) return [];
  const here = pathKey(root);
  const asks = selectAsks(app);
  return ss.list.flatMap((rec) => {
    if (rec.status === "draft" || pathKey(rec.cwd) !== here) return [];
    // a session in its own terminal has no chat to read a lane from, and a Hermes folder chat is not a coding agent's
    const key = sessions.chatKey(rec.id);
    if (!key?.startsWith("agent:")) return [];
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
}

/** Opens the session of a lane in the main column, as a notification would. */
export const openLane = (id: string): void => getStore().actions.openSession(id);

export interface LanesProps {
  rows: LaneRow[];
  /** The time now (ms), for the time a turn has run. */
  now: number;
  onOpen: (id: string) => void;
  /** The lane whose Bring it back is open, and the link on its line that opens or closes it. */
  backOpen?: string | null;
  onBack?: (id: string) => void;
  /** What a row shows under its line: Bring it back's panel (the Code page fills it, since the panel reads the stores). */
  below?: (row: LaneRow) => ReactNode;
}

function branchTitle(b: LaneBranchTag): string {
  switch (b.kind) {
    case "own":
      return t("lane.madeFrom", { base: b.base });
    case "shared":
      return t("lane.shared");
    case "moved":
      return t("lane.moved", { branch: b.lane, now: b.name });
    case "folder":
      return t("lane.noBranch");
  }
}

function LaneItem({ row, now, onOpen, backOpen, onBack, below }: { row: LaneRow; now: number; onOpen: (id: string) => void } & Pick<LanesProps, "onBack" | "below"> & { backOpen: boolean }) {
  const tag = laneTag(row.status);
  const line = row.status === "failed" ? row.error : row.line ? t(row.line.key, row.line.vars) : "";
  return (
    <div className="lane" data-testid={`lane-${row.id}`} data-status={row.status}>
      <button type="button" className="rowl" onClick={() => onOpen(row.id)} title={t("lane.open")}>
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
    </div>
  );
}

export function LanesView({ rows, now, onOpen, backOpen = null, onBack, below }: LanesProps) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="band">
        <span>{t("lane.title")}</span>
      </div>
      <div className="lanes" data-testid="lanes">
        {rows.map((r) => (
          <LaneItem key={r.id} row={r} now={now} onOpen={onOpen} backOpen={backOpen === r.id} onBack={onBack} below={below} />
        ))}
      </div>
    </>
  );
}
