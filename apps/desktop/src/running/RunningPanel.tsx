// What keeps running, on the Code page (the canvas's StatesCodeDev board, "Watching it run", "Something that keeps
// running"): each command that this app's terminals and chats started and that is still running, with how long it has
// run, the port it listens on and Stop. The shell reads them from the system (src-tauri/src/running.rs), the feed
// (feed.ts) asks for them while this is on the page, and model.ts says what a row shows. `RunningPanelView` takes what it
// shows as props and uses no hooks, so a test can draw it; `RunningPanel` reads the feed and the sessions.
import "./running.css";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { folderName, termFallbackName } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import { getSessions, useSessions, type SessionsState } from "../sessions/sessions";
import { pickTitle } from "../sessions/titles";
import { getStore } from "../state/store";
import { POLL_MS, getRunningFeed, type RunningFeed, type RunningState } from "./feed";
import { commandLabel, inProject, listed, portsText, ranFor, rowKey, runFor, type RunningRow } from "./model";

/** One row, with its words made: what the view draws. */
export interface RunningItem {
  key: string;
  row: RunningRow;
  /** The command, any key in it hidden. */
  label: string;
  /** How long it has run ("42m"). */
  ran: string;
  /** "port 3000", or nothing when it listens on none. */
  ports: string;
  /** The terminal it runs in, when the page has a row for it, and what opens that row. */
  lane: string | null;
  open: (() => void) | null;
  /** The folder's name, when the list reaches more than one project: the rows then say whose they are. */
  project: string | null;
  /** Stop was pressed and the command is still there. */
  stopping: boolean;
  /** It would not stop. */
  failed: boolean;
}

export interface ItemContext {
  now: number;
  /** One project's rows (a folder); every project's when none is given. */
  project?: string;
  /** The terminal row of a command's session, with what opens it: only a terminal has one on this page. */
  lane: (row: RunningRow) => { name: string; open: () => void } | null;
}

/** The rows to draw, in order, with their words made at `c.now` (they follow the language as the page draws again). */
export function runningItems(s: Pick<RunningState, "rows" | "seen" | "stopping" | "failed">, c: ItemContext): RunningItem[] {
  const seen = new Map(Object.entries(s.seen));
  const rows = listed(inProject(s.rows, c.project), c.now, seen);
  const several = new Set(rows.map((r) => pathKey(r.folder))).size > 1;
  return rows.map((row) => {
    const key = rowKey(row);
    const lane = c.lane(row);
    return {
      key,
      row,
      label: commandLabel(row.argv),
      ran: runFor(ranFor(row, c.now, seen) ?? 0),
      ports: portsText(row.ports),
      lane: lane?.name ?? null,
      open: lane?.open ?? null,
      project: several ? folderName(row.folder) : null,
      stopping: s.stopping[key] !== undefined,
      failed: s.failed[key] === true,
    };
  });
}

export function RunningPanelView({ items, onStop }: { items: RunningItem[]; onStop: (row: RunningRow) => void }) {
  return (
    <section className="runp" aria-labelledby="run-title" data-testid="running-panel">
      <div className="band">
        <span id="run-title">{t("run.title")}</span>
      </div>
      {items.length === 0 ? (
        <p className="mut" data-testid="running-none">
          {t("run.none")}
        </p>
      ) : (
        <ul className="rows">
          {items.map((it) => {
            const label = it.label || t("run.unnamed");
            const meta = [it.ran, it.ports].filter(Boolean).join(" · ");
            return (
              <li key={it.key} className="rowl" data-testid="running-row">
                <span className="tag run">{t("run.tag")}</span>
                <span className="grow">
                  <span className="l1 mono" title={label} data-testid="running-command">
                    {label}
                  </span>
                  <span className="l2" data-testid="running-meta">
                    {meta}
                    {it.lane && (
                      <>
                        {" · "}
                        <button type="button" className="lk" onClick={() => it.open?.()} data-testid="running-lane">
                          {it.lane}
                        </button>
                      </>
                    )}
                    {it.project && ` · ${it.project}`}
                  </span>
                  {it.failed && (
                    <span className="l2 err" role="status" data-testid="running-failed">
                      {t("run.stopFailed")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn"
                  aria-label={t("run.stopAria", { command: label })}
                  aria-busy={it.stopping}
                  aria-disabled={it.stopping || undefined}
                  onClick={() => {
                    if (!it.stopping) onStop(it.row);
                  }}
                  data-testid="running-stop"
                >
                  {it.stopping ? t("run.stopping") : t("run.stop")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Asks the shell while the panel is on the page, and hands back what it said. */
function useFeed(feed: RunningFeed): RunningState {
  useEffect(() => feed.start(), [feed]);
  return useSyncExternalStore(feed.subscribe, feed.getState, feed.getState);
}

/** The terminal row whose pty the shell named, with what opens it. A chat has no row on this page. */
function laneOf(ss: SessionsState, r: RunningRow): { name: string; open: () => void } | null {
  if (r.kind !== "pty") return null;
  const sessions = getSessions();
  const rec = ss.list.find((x) => sessions.ptyOf(x.id) === r.session);
  return rec ? { name: pickTitle(rec, termFallbackName(rec, ss.agents)).title, open: () => getStore().actions.openSession(rec.id) } : null;
}

/** What keeps running, for every project at once (or for `project`, a folder): nothing is drawn where the shell cannot
 *  say what runs (Windows), nor before it has first said. */
export function RunningPanel({ project }: { project?: string }) {
  const feed = getRunningFeed();
  const s = useFeed(feed);
  const ss = useSessions();
  // the ages move between looks
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);
  if (!s.supported || !s.loaded) return null;
  const items = runningItems(s, { now: Date.now(), project, lane: (r) => laneOf(ss, r) });
  return <RunningPanelView items={items} onStop={(r) => void feed.stop(r)} />;
}
