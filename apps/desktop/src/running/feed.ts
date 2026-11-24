// The page's one look at what keeps running: it asks the host every few seconds while somebody reads the list, keeps what
// the host said, and settles a Stop. It has no React and no clock of its own (`now`, the timers and whether the window
// shows are options), so a test moves time by hand. What a row shows of a command is model.ts's.
import { MockRunningHost, getRunningHost, type RunningHost } from "./host";
import { rowKey, type RunningRow } from "./model";

/** How often the host is asked while the list is read and the window shows. */
export const POLL_MS = 3_000;
/** A command still running this long after Stop did not end: the button comes back, with a note. */
export const STOP_WAIT_MS = 10_000;
/** After Stop the shell answers at once and the command ends within its few seconds of grace: look again at these times
 *  instead of waiting for the next poll, so the row goes as soon as the command does. */
const LOOKS_AFTER_STOP = [500, 1_500, 3_500];

export interface RunningState {
  /** False once the host said this computer cannot tell what runs: nothing is drawn and nothing is asked again. */
  supported: boolean;
  /** The host has answered at least once. */
  loaded: boolean;
  /** What the host last said, as it said it (ports and words are still the command's own, not yet hidden of any key). */
  rows: RunningRow[];
  /** When the page first saw each command whose start the system would not say (ms), by `rowKey`. */
  seen: Record<string, number>;
  /** Commands Stop was pressed on that still run, by `rowKey`, with when it was pressed. */
  stopping: Record<string, number>;
  /** Commands that would not stop: the shell refused, or they were still there after `STOP_WAIT_MS`. */
  failed: Record<string, true>;
}

export interface FeedOptions {
  every?: number;
  now?: () => number;
  /** Whether the window shows: nothing is asked while it does not. */
  visible?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const same = <T>(a: Record<string, T>, b: Record<string, T>): boolean => {
  const k = Object.keys(a);
  return k.length === Object.keys(b).length && k.every((x) => a[x] === b[x]);
};
const omit = <T>(o: Record<string, T>, k: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
const sameRows = (a: readonly RunningRow[], b: readonly RunningRow[]): boolean =>
  a.length === b.length &&
  a.every((r, i) => rowKey(r) === rowKey(b[i]) && r.folder === b[i].folder && r.ports.join() === b[i].ports.join() && r.argv.join("\0") === b[i].argv.join("\0"));

/** The state after the host listed `rows` at `at`: when a command was first seen, which Stops are done or did not work.
 *  The same state again when nothing a reader shows changed, so a poll that finds the same list wakes nobody. */
function apply(s: RunningState, rows: RunningRow[], at: number): RunningState {
  const keys = new Set(rows.map(rowKey));
  const seen: Record<string, number> = {};
  for (const r of rows) if (r.started === null) seen[rowKey(r)] = s.seen[rowKey(r)] ?? at;
  const stopping: Record<string, number> = {};
  const failed: Record<string, true> = {};
  for (const [k, since] of Object.entries(s.stopping)) {
    if (!keys.has(k)) continue; // it ended: the Stop is done
    if (at - since >= STOP_WAIT_MS) failed[k] = true;
    else stopping[k] = since;
  }
  // a note that a command would not stop stays for as long as the command does
  for (const k of Object.keys(s.failed)) if (keys.has(k) && stopping[k] === undefined) failed[k] = true;
  if (s.loaded && sameRows(s.rows, rows) && same(s.seen, seen) && same(s.stopping, stopping) && same(s.failed, failed)) return s;
  return { ...s, loaded: true, rows, seen, stopping, failed };
}

export function createRunningFeed(host: RunningHost, o: FeedOptions = {}) {
  const every = o.every ?? POLL_MS;
  const now = o.now ?? Date.now;
  const visible = o.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let state: RunningState = { supported: true, loaded: false, rows: [], seen: {}, stopping: {}, failed: {} };
  const subs = new Set<() => void>();
  const set = (next: RunningState) => {
    state = next;
    for (const fn of [...subs]) fn();
  };

  let readers = 0;
  let timer: unknown = null;
  /** Each start of the poll is a generation, so a look that is still under way when the poll stops and starts again
   *  does not leave a second poll behind. */
  let gen = 0;
  let inflight: Promise<void> | null = null;

  /** One look. Two asked at once are one. A look that fails changes nothing: the last list stands and the next poll asks again. */
  function refresh(): Promise<void> {
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const rows = await host.list();
        if (rows === null) {
          gen++;
          if (timer !== null) clearTimer(timer);
          timer = null;
          set({ ...state, supported: false, loaded: true });
          return;
        }
        const next = apply(state, rows, now());
        if (next !== state) set(next);
      } catch {
        /* the shell did not answer: the next poll asks again */
      }
    })().finally(() => {
      inflight = null;
    });
    inflight = p;
    return p;
  }

  async function poll(g: number): Promise<void> {
    timer = null;
    if (visible()) await refresh();
    if (g === gen && readers > 0 && state.supported) timer = setTimer(() => void poll(g), every);
  }

  function start(): () => void {
    readers++;
    if (readers === 1 && state.supported) void poll(++gen);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      readers--;
      if (readers === 0) {
        gen++;
        if (timer !== null) clearTimer(timer);
        timer = null;
      }
    };
  }

  /** Stop one command and what it started. Pressed again while it is stopping, nothing more is asked. */
  async function stop(row: RunningRow): Promise<void> {
    const key = rowKey(row);
    if (state.stopping[key] !== undefined) return;
    set({ ...state, stopping: { ...state.stopping, [key]: now() }, failed: omit(state.failed, key) });
    let answer;
    try {
      // which command it is, and nothing of its words
      answer = await host.stop({ kind: row.kind, session: row.session, pid: row.pid, started: row.started });
    } catch {
      set({ ...state, stopping: omit(state.stopping, key), failed: { ...state.failed, [key]: true } });
      return;
    }
    if (answer === "gone") void refresh();
    for (const ms of LOOKS_AFTER_STOP) setTimer(() => void (readers > 0 && refresh()), ms);
  }

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    start,
    refresh,
    stop,
  };
}

export type RunningFeed = ReturnType<typeof createRunningFeed>;

let singleton: RunningFeed | null = null;
/** The app's one feed. With the mock host, a test that changes what runs makes it look again at once. */
export function getRunningFeed(): RunningFeed {
  if (!singleton) {
    const host = getRunningHost();
    const feed = (singleton = createRunningFeed(host));
    if (host instanceof MockRunningHost) host.onChange = () => void feed.refresh();
  }
  return singleton;
}
