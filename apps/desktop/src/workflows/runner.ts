// Workflows at work (item 77b): the folder read, the runs started and walked step by step, their history kept, and the clock that
// starts a workflow at its time.
//
// A run is a lane. It starts the way a person's own lane starts (`startWorkflowLane` in sessions.ts: the same draft and first
// message, so it has a branch and a folder of its own and shows in the Lanes band), with step 1 as its first message. When that
// step's turn ends done, the next step goes, as the person's own next message would (`send`), to the end. It never answers an
// ask: an ask in any step is the person's, on its card and in Needs you as always, and the run waits there, because the turn has
// not ended. A turn that fails, one the person stops, the agent ending and the lane being closed each end the run. One run of a
// workflow at a time. While Settings › Workflows is off nothing runs, nothing is scheduled, and a run going when it is turned off
// finishes its turn and stops.
//
// Item 91: a run starts only from what the person allowed (allow.ts). Every way a run starts (the clock, Run now, the palette,
// which presses Run now) goes through `begin`, which reads the folder's file as it is now and starts nothing unless its exact
// text is the one the person allowed. The steps the run sends are the ones parsed from that same text. When it is not, the run
// is kept as skipped with why, and the card says it. The project is asked of the shell at Allow and again before every run
// (host.ts `project`): the top folder of a git repository, written as its real path, never the home folder, a disk's top or a
// folder that holds them or the app's own. The lane is started in that real path, and a run whose lane could not have a branch
// and folder of its own does not start (`startWorkflowLane` answers `no_lane`, having started no agent).
//
// Item 114: a run the clock starts makes its lane with nobody there, as the app's own doing. The shell then reads the project's
// own git config first, as the automatic pull does (src-tauri/src/lane.rs `make_with`, `unattended`), and makes nothing while it
// names a program git would run or another address to fetch from: the run is kept as skipped (`config`, the setting as its
// detail) and the card says it. Run now is the person's own press, and its lane is made as one they start from the chat box.
import { useSyncExternalStore } from "react";
import { chatAgents, offeredAgents, type AgentId } from "../sessions/agents";
import { getSessions, type SessionsStore } from "../sessions/sessions";
import type { ChatEvent } from "../sessions/host";
import { getStore, type Store } from "../state/store";
import { readFolder, type Workflow, type WorkflowFile } from "./file";
import { clockStep, TICK_MS } from "./schedule";
import { readAllowances, saveAllowances, standingOf, type Allowances } from "./allow";
import { detailOf, keepRuns, parseRuns, settleLeftovers, type BlockWhy, type EndWhy, type RunRec, type RunState } from "./history";
import { setWorkflowSettings, workflowSettings } from "./settings";
import { getWorkflowsHost, readProjectCheck, type FolderState, type ProjectCheck, type ProjectWhy, type WorkflowsHost } from "./host";

/** What a run needs of the sessions store: the very calls a person's own lane goes through. */
export type WorkflowSessions = Pick<SessionsStore, "getState" | "subscribe" | "loadAgents" | "startWorkflowLane" | "send" | "chatKey" | "onChatEvent">;

/** A run going now. `steps` are the workflow's as it started, so a file changed meanwhile does not change a run half done. */
export interface LiveRun {
  run: string;
  /** the lane's session, once made */
  session: string | null;
  /** the step being worked on, 0-based; -1 before the lane starts */
  step: number;
  steps: string[];
  /** stop when this step's turn ends: the person asked, or Workflows was turned off */
  stopAfter?: "person" | "off";
  /** its project is being checked or its lane made: a session that goes meanwhile is the start's to settle, not a closed lane */
  starting?: boolean;
}

export interface WorkflowsState {
  folder: { path: string; state: FolderState | "loading"; more: number };
  files: WorkflowFile[];
  /** every workflow's kept runs, newest first */
  runs: RunRec[];
  /** the run going now, by workflow file */
  live: Record<string, LiveRun>;
  /** what the person allowed, by workflow file (allow.ts) */
  allowed: Allowances;
  /** why the last run asked for did not start, by workflow file, whichever way it was asked for; cleared when one starts */
  refused: Record<string, RunRefusal>;
}

/** Why a run did not start. `off`, `running` and `unreadable` are Run now's own; the rest are kept in the history too. */
export type RunRefusal = "off" | "running" | "unreadable" | BlockWhy;

/** Why Allow did not record an allowance: the file is not the text the page showed, or its project is not one a run may start
 *  in. */
export type AllowRefusal = "changed" | ProjectWhy;

const RUNS_KEY = "manut.workflows.runs";
const CLOCK_KEY = "manut.workflows.clock";
const SEEN_KEY = "manut.workflows.seen";

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* no storage: the history holds for this run of the app */
  }
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface WorkflowDeps {
  sessions: () => WorkflowSessions;
  store: () => Pick<Store, "getState">;
  host?: WorkflowsHost;
  now?: () => number;
}

export function createWorkflows(deps: WorkflowDeps) {
  const now = deps.now ?? Date.now;
  const host = deps.host ?? getWorkflowsHost();
  /** When this run of the app began: a time due before it was missed while the app was not open. */
  const loadedAt = now();
  const listeners = new Set<() => void>();
  let state: WorkflowsState = {
    folder: { path: "", state: "loading", more: 0 },
    files: [],
    runs: settleLeftovers(parseRuns(read(RUNS_KEY)), loadedAt),
    live: {},
    allowed: readAllowances(),
    refused: {},
  };
  let seq = 0;
  const set = (patch: Partial<WorkflowsState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };

  // ---- history ------------------------------------------------------------------------------

  const saveRuns = (runs: readonly RunRec[]) => {
    const kept = keepRuns(runs, workflowSettings().skippedKept);
    write(RUNS_KEY, JSON.stringify(kept));
    set({ runs: kept });
  };
  const addRun = (r: RunRec) => saveRuns([r, ...state.runs]);
  const patchRun = (id: string, p: Partial<RunRec>) => saveRuns(state.runs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const newId = () => `w${(++seq).toString(36)}-${now().toString(36)}`;

  // ---- the folder ---------------------------------------------------------------------------

  /** When the app first saw each file: a schedule's times before then were never that workflow's. */
  const readSeen = (): Record<string, number> => {
    try {
      const v: unknown = JSON.parse(read(SEEN_KEY) ?? "{}");
      return v && typeof v === "object" ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  const noteSeen = (files: readonly WorkflowFile[]) => {
    const was = readSeen();
    const next: Record<string, number> = {};
    for (const f of files) next[f.file] = typeof was[f.file] === "number" ? was[f.file] : now();
    write(SEEN_KEY, JSON.stringify(next));
    return next;
  };

  /** Read the folder again. A file that cannot be read is listed with why, and nothing is written there. */
  const refresh = async () => {
    try {
      const f = await host.read();
      const files = readFolder(f.files);
      noteSeen(files);
      set({ folder: { path: f.path, state: f.state, more: f.more }, files, allowed: readAllowances() });
    } catch {
      set({ folder: { ...state.folder, state: "unreadable" } });
    }
  };

  const workflowOf = (file: string): Workflow | null => {
    const f = state.files.find((x) => x.file === file);
    return f && "workflow" in f ? f.workflow : null;
  };

  // ---- a run --------------------------------------------------------------------------------

  /** Run `runId` ended (once: a later end of the same run changes nothing). Skipped: it started nothing after all. */
  const endRun = (runId: string, end: Exclude<RunState, "running">, why?: EndWhy | BlockWhy, detail?: string) => {
    const hit = Object.entries(state.live).find(([, l]) => l.run === runId);
    if (!hit) return;
    const live = { ...state.live };
    delete live[hit[0]];
    set({ live });
    patchRun(runId, { state: end, ...(why ? { why } : {}), ...(detail ? { detail: detailOf(detail) } : {}), ...(end === "skipped" ? { reached: 0 } : {}), ended: now() });
  };

  /** The shell's word on `project` now; no answer, or one this page does not know, allows nothing. */
  const checkProject = async (project: string): Promise<ProjectCheck> => {
    try {
      return readProjectCheck(await host.project(project));
    } catch {
      return { why: "unchecked" };
    }
  };

  const setLive = (file: string, l: LiveRun) => set({ live: { ...state.live, [file]: l } });

  /** Says on `file`'s card why the last run asked for did not start (null: it started, so nothing is said). */
  const setRefused = (file: string, why: RunRefusal | null) => {
    if ((state.refused[file] ?? null) === why) return;
    const refused = { ...state.refused };
    if (why) refused[file] = why;
    else delete refused[file];
    set({ refused });
  };

  /** A run of `wf` that did not start, kept as skipped with why and said on its card. */
  const skip = (wf: Workflow, by: RunRec["by"], why: BlockWhy, due?: number): RunRefusal => {
    addRun({ id: newId(), file: wf.file, name: wf.name, by, at: due ?? now(), ...(due !== undefined ? { due } : {}), steps: wf.steps.length, reached: 0, state: "skipped", why });
    setRefused(wf.file, why);
    return why;
  };

  /** Start a run of `wf`: its lane, with step 1 as the first message. `wf` is the file as read just now. */
  const begin = async (wf: Workflow, by: RunRec["by"], due?: number): Promise<RunRefusal | null> => {
    if (!workflowSettings().on) return "off";
    if (state.live[wf.file]) {
      // one run of a workflow at a time: a time that comes while the last run still goes is skipped, and says so
      if (by === "schedule") addRun({ id: newId(), file: wf.file, name: wf.name, by, at: due ?? now(), ...(due !== undefined ? { due } : {}), steps: wf.steps.length, reached: 0, state: "skipped", why: "busy" });
      return "running";
    }
    // only the exact text the person allowed: the allowances are read again here, so a record that cannot be read allows nothing
    const allowances = readAllowances();
    const standing = standingOf(wf, allowances);
    if (standing !== "allowed") return skip(wf, by, standing, due);
    const allowedProject = allowances[wf.file].project;
    const id = newId();
    // the run holds its place before anything is awaited, so a second press or time meanwhile is "running", never a second run
    setLive(wf.file, { run: id, session: null, step: -1, steps: [...wf.steps], starting: true });
    // the project as the disk has it now: still a repository's own top folder, and the very folder allowed
    const project = await checkProject(wf.project);
    const block: BlockWhy | null = "why" in project ? project.why : project.real !== allowedProject ? "moved" : null;
    const free = () => {
      if (state.live[wf.file]?.run !== id) return;
      const live = { ...state.live };
      delete live[wf.file];
      set({ live });
    };
    // Workflows turned off while the shell looked: nothing starts
    if (!workflowSettings().on) {
      free();
      return "off";
    }
    if (block || !("real" in project) || state.live[wf.file]?.run !== id) {
      free();
      return skip(wf, by, block ?? "unchecked", due);
    }
    setRefused(wf.file, null);
    addRun({ id, file: wf.file, name: wf.name, by, at: now(), ...(due !== undefined ? { due } : {}), steps: wf.steps.length, reached: 0, state: "running" });
    const ss = deps.sessions();
    if (ss.getState().agents === null) await ss.loadAgents().catch(() => undefined);
    // the agent must be one a person could start a lane with now: installed, on in Settings › Providers, and a chat here
    if (!chatAgents(offeredAgents(ss.getState().agents ?? []), []).some((a) => a.id === wf.agent)) {
      endRun(id, "failed", "agent");
      return null;
    }
    const made = (sid: string) => {
      const l = state.live[wf.file];
      if (l?.run !== id) return;
      setLive(wf.file, { ...l, session: sid, step: 0 });
      patchRun(id, { session: sid, reached: 1 });
    };
    let refusal: RunRefusal | null = null;
    try {
      // in the folder the shell just checked, by its real path. Only a person's press is someone there (item 114): any other
      // way a run starts (the clock, and whatever starts one later) makes its lane as the app's own doing, so the shell reads
      // the repository's own config first and makes nothing while it names a program or another address
      const unattended = by !== "person";
      const started = await ss.startWorkflowLane({ agent: wf.agent as AgentId, cwd: project.real, workflow: wf.name, first: wf.steps[0], unattended, made });
      if (started === "no_lane") {
        endRun(id, "skipped", "no_lane");
        setRefused(wf.file, "no_lane");
        refusal = "no_lane";
      } else if (typeof started === "object") {
        endRun(id, "skipped", "config", started.setting);
        setRefused(wf.file, "config");
        refusal = "config";
      } else if (started !== "started") endRun(id, "failed", "start");
    } catch (e) {
      endRun(id, "failed", "start", errText(e));
    }
    const l = state.live[wf.file];
    if (l?.run === id && l.starting) setLive(wf.file, { ...l, starting: false });
    check();
    return refusal;
  };

  /** A turn of a run's lane ended, or its agent did. */
  const onEvent = (sid: string, ev: ChatEvent) => {
    const hit = Object.entries(state.live).find(([, l]) => l.session === sid);
    if (!hit) return;
    const [file, l] = hit;
    const error = typeof ev.error === "string" && ev.error ? ev.error : undefined;
    if (ev.event === "exit") return endRun(l.run, "failed", "ended", error);
    if (ev.event !== "turn.end") return;
    // a turn the agent began on its own while the step waited behind it is not the step's: the step goes when it ends
    const key = deps.sessions().chatKey(sid);
    if (key && deps.store().getState().chats[key]?.queue?.length) return;
    if (ev.outcome === "error") return endRun(l.run, "failed", "turn", error);
    if (ev.outcome === "interrupted") return endRun(l.run, "stopped", "interrupted");
    if (ev.outcome !== "done") return endRun(l.run, "failed", "ended", error);
    if (l.stopAfter) return endRun(l.run, "stopped", l.stopAfter);
    if (!workflowSettings().on) return endRun(l.run, "stopped", "off");
    const next = l.step + 1;
    if (next >= l.steps.length) return endRun(l.run, "done");
    setLive(file, { ...l, step: next });
    patchRun(l.run, { reached: next + 1 });
    void deps
      .sessions()
      .send(sid, l.steps[next])
      .then(
        (ok) => !ok && endRun(l.run, "failed", "send"),
        (e) => endRun(l.run, "failed", "send", errText(e)),
      );
  };

  /** A run's lane closed, failed to start or ended, or the person turned it into its agent's terminal (which stops the chat's
   *  turn, so no step would ever end): its run ends with it. */
  const check = () => {
    const list = deps.sessions().getState().list;
    for (const l of Object.values(state.live)) {
      if (!l.session || l.starting) continue;
      const r = list.find((x) => x.id === l.session);
      if (!r) endRun(l.run, "stopped", "closed_lane");
      else if (r.status === "failed") endRun(l.run, "failed", "start", r.error);
      else if (r.status === "exited") endRun(l.run, "failed", "ended", r.error);
      else if (r.view === "terminal") endRun(l.run, "stopped", "interrupted");
    }
  };

  // ---- the clock ----------------------------------------------------------------------------

  const readClock = (): number | null => {
    const n = Number(read(CLOCK_KEY));
    return read(CLOCK_KEY) !== null && Number.isFinite(n) ? n : null;
  };

  /** One look at the clock: the folder read again, what fell due run, what was missed kept as skipped. */
  const tick = async () => {
    if (!workflowSettings().on) return;
    await refresh();
    const t = now();
    const last = readClock();
    write(CLOCK_KEY, String(t));
    const seen = readSeen();
    const list = state.files.flatMap((f) => ("workflow" in f && f.workflow.schedule ? [{ workflow: f.workflow, seenAt: seen[f.file] ?? t }] : []));
    const out = clockStep({ last, loadedAt, now: t, list });
    for (const s of out.skip) {
      const wf = workflowOf(s.file);
      if (wf) addRun({ id: newId(), file: s.file, name: wf.name, by: "schedule", at: s.due, due: s.due, steps: wf.steps.length, reached: 0, state: "skipped", why: s.why });
    }
    for (const r of out.run) {
      const wf = workflowOf(r.file);
      if (wf) await begin(wf, "schedule", r.due);
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const offs: (() => void)[] = [];

  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh,
    tick,
    /** Run now: the page's button and the palette's "Run workflow" press this. The file is read again first, so what runs is what is
     *  in the folder now, and only while that is what the person allowed. Why it did not start is said on the card. */
    async runNow(file: string): Promise<RunRefusal | null> {
      const why = await (async (): Promise<RunRefusal | null> => {
        if (!workflowSettings().on) return "off";
        await refresh();
        const wf = workflowOf(file);
        if (!wf) return "unreadable";
        return begin(wf, "person");
      })();
      setRefused(file, why);
      return why;
    },
    /** "Allow this workflow to run", pressed on the card that shows every step of the text whose digest is `digest`. What is
     *  allowed is that text: when the folder now holds anything else for `file` (read since the page drew it), nothing is
     *  recorded and the page shows the file as it is now. */
    async allow(file: string, digest: string): Promise<AllowRefusal | null> {
      const wf = workflowOf(file);
      if (!wf || wf.digest !== digest) return "changed";
      const project = await checkProject(wf.project);
      // the folder may have been read again while the shell looked: still the text the page showed
      if (workflowOf(file)?.digest !== digest) return "changed";
      if ("why" in project) {
        setRefused(file, project.why);
        return project.why;
      }
      saveAllowances({ ...readAllowances(), [file]: { digest, project: project.real, at: now() } });
      // read back, so the page never shows an allowance the storage did not keep
      set({ allowed: readAllowances() });
      if (standingOf(wf, state.allowed) === "allowed") setRefused(file, null);
      return null;
    },
    /** "Stop allowing": the file is not allowed again until the person allows it again. A run going finishes as it would. */
    disallow(file: string) {
      const next = { ...readAllowances() };
      delete next[file];
      saveAllowances(next);
      set({ allowed: readAllowances() });
    },
    /** The run sends no further step: it stops when the step it is on ends. */
    stopAfterStep(file: string) {
      const l = state.live[file];
      if (l) setLive(file, { ...l, stopAfter: "person" });
    },
    /** Settings › Workflows' switch. On: the clock starts from now, so nothing missed while off is run or listed. Off: each run going
     *  finishes its turn and stops. */
    setOn(on: boolean) {
      setWorkflowSettings({ on });
      if (on) {
        write(CLOCK_KEY, String(now()));
        void refresh();
      } else {
        for (const [file, l] of Object.entries(state.live)) setLive(file, { ...l, stopAfter: l.stopAfter ?? "off" });
      }
    },
    /** Settings › Workflows' "Skipped runs kept": the history is bounded again at once. */
    setSkippedKept(n: number) {
      setWorkflowSettings({ skippedKept: n });
      saveRuns(state.runs);
    },
    /** Begin: read the folder, hear the lanes and look at the clock every TICK_MS while the app is open. */
    start() {
      if (timer) return;
      saveRuns(state.runs);
      const ss = deps.sessions();
      offs.push(ss.onChatEvent(onEvent), ss.subscribe(check));
      timer = setInterval(() => void tick(), TICK_MS);
      void refresh().then(tick);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const off of offs.splice(0)) off();
    },
  };
}

export type WorkflowsStore = ReturnType<typeof createWorkflows>;

let singleton: WorkflowsStore | null = null;
/** The app's one workflows store, on the app's sessions and store. */
export function getWorkflows(): WorkflowsStore {
  return (singleton ??= createWorkflows({ sessions: getSessions, store: getStore }));
}

/** Called once as the app opens (App.tsx): the clock runs from then until the app closes. */
export function startWorkflows(): void {
  if (typeof window !== "undefined") getWorkflows().start();
}

export function useWorkflows(): WorkflowsState {
  const s = getWorkflows();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}
