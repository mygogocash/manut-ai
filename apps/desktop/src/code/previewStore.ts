// Each lane's preview while the app runs, by the lane's chat key (`agent:<id>`, laneStore.ts `isLaneChat`): what its folder holds
// (read when its Preview is looked at, and again right before each Start, since Kit may have changed it), the command chosen from
// that, and its run (previewRun.ts). Nothing is saved, and none of a preview's lines leave memory: the shell stops every preview
// when the page loads again or the app quits, and a lane's preview goes when its session closes (sessions.ts `close` calls
// `forgetPreview`). The run's words are LanePreview.tsx's.
import { useSyncExternalStore } from "react";
import type { Need } from "./preview";
import { getPreviewHost, type PreviewEvent, type PreviewHost } from "./previewHost";
import {
  exitRun,
  isLive,
  linesRun,
  NOT_STARTED,
  planOf,
  previewSecrets,
  refusedRun,
  startedRun,
  startingRun,
  stoppingRun,
  waitedRun,
  type PreviewPlan,
  type PreviewProject,
  type PreviewRun,
} from "./previewRun";

export interface PreviewRecord {
  /** The lane's own folder it reads and runs in. */
  dir: string;
  /** A read of the folder is under way. */
  reading: boolean;
  /** What the folder held when it was last read, and the command chosen from it. */
  project: PreviewProject | null;
  plan: PreviewPlan | null;
  /** Why the folder could not be read: the shell's word. */
  readWhy: string | null;
  run: PreviewRun;
  /** Open was pressed and the browser could not be reached. */
  openFailed: boolean;
  /** Which Start the run is: an answer or a line of an earlier one (a run whose session closed, or one replaced) is not this run's. */
  token: number;
}

const EMPTY: PreviewRecord = Object.freeze({ dir: "", reading: false, project: null, plan: null, readWhy: null, run: NOT_STARTED, openFailed: false, token: 0 }) as PreviewRecord;

/** The clock the wait for an address runs on (a test moves it by hand). */
export interface PreviewClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}
const realClock: PreviewClock = { now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

const records = new Map<string, PreviewRecord>();
const waits = new Map<string, unknown>();
const listeners = new Set<() => void>();
let version = 0;
let tokens = 0;
let clock = realClock;
let hostOverride: PreviewHost | null = null;
const host = (): PreviewHost => hostOverride ?? getPreviewHost();

const changed = () => {
  version++;
  listeners.forEach((l) => l());
};
const patch = (key: string, next: Partial<PreviewRecord>) => {
  records.set(key, { ...(records.get(key) ?? EMPTY), ...next });
  changed();
};
const runOf = (key: string): PreviewRun => records.get(key)?.run ?? NOT_STARTED;
const current = (key: string, token: number) => records.get(key)?.token === token;
const word = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

function clearWait(key: string) {
  const t = waits.get(key);
  if (t !== undefined) clock.clearTimer(t);
  waits.delete(key);
}

/** The lane's run is now `run`; the wait for its address goes once it is over. */
function setRun(key: string, run: PreviewRun) {
  const r = records.get(key);
  if (!r || r.run === run) return;
  patch(key, { run });
  if (!isLive(run)) clearWait(key);
}

/** Read what the lane's own folder `dir` holds and choose the command from it. The project, or null when it could not be read
 *  (the record then says why) or the lane was forgotten meanwhile. */
export async function readPreview(key: string, dir: string): Promise<PreviewProject | null> {
  const before = records.get(key);
  patch(key, { dir, reading: true, ...(before && before.dir !== dir ? { project: null, plan: null, readWhy: null } : {}) });
  try {
    const project = await host().read(dir);
    if (records.get(key)?.dir !== dir) return null;
    patch(key, { reading: false, project, plan: planOf(project), readWhy: null });
    return project;
  } catch (e) {
    if (records.get(key)?.dir !== dir) return null;
    patch(key, { reading: false, project: null, plan: null, readWhy: word(e) });
    return null;
  }
}

/** Start the lane's preview in its own folder `dir`, at most one per lane: the folder is read again first and the command chosen
 *  from what it holds now (the shell runs it only while package.json is still that text), and it runs with `needs`, the secrets
 *  Kit's changes read, and the secrets the folder's `.env.example` names, each on its sample (`previewSecrets`). */
export async function startPreview(key: string, dir: string, needs: readonly Need[]): Promise<void> {
  if (isLive(runOf(key))) return;
  const project = await readPreview(key, dir);
  const plan = records.get(key)?.plan;
  if (!project || !plan || "none" in plan || project.packageJson === null || isLive(runOf(key))) return;
  const token = ++tokens;
  const since = clock.now();
  const wait = host().startWait;
  patch(key, { run: startingRun(plan.label, since), token, openFailed: false });
  clearWait(key);
  waits.set(
    key,
    clock.setTimer(() => {
      if (current(key, token)) setRun(key, waitedRun(runOf(key), clock.now(), wait));
    }, wait),
  );
  // The owner can add no secret yet (there is no vault): every secret runs on its sample.
  const env = previewSecrets(needs, project.envExample, {});
  const onEvent = (ev: PreviewEvent) => {
    if (!current(key, token)) return;
    const run = runOf(key);
    setRun(key, ev.event === "lines" ? linesRun(run, ev.lines) : exitRun(run, ev.code, ev.stopped));
  };
  try {
    const id = await host().start(dir, plan.argv, project.packageJson, env, onEvent);
    if (!current(key, token)) {
      // its session closed, or the lane was forgotten, while the shell started it: it stops at once, so nothing runs unseen
      void host().stop(id).catch(() => undefined);
      return;
    }
    const before = runOf(key);
    setRun(key, waitedRun(startedRun(before, id), clock.now(), wait));
    // Stop was pressed before the shell answered: it stops now
    if (before.phase === "stopping") void stopById(key, id, before);
  } catch (e) {
    if (!current(key, token)) return;
    const why = word(e);
    setRun(key, refusedRun(runOf(key), why));
    // Kit changed package.json between the read and the start: the view shows the command chosen from what is there now
    if (why === "changed") void readPreview(key, dir);
  }
}

/** The shell stops run `id`. `gone`: it had ended, and its end is said here in case the shell's own word never comes. When the
 *  shell does not answer, the run goes back to how it was, so Stop can be pressed again. */
async function stopById(key: string, id: number, was: PreviewRun) {
  const token = records.get(key)?.token;
  try {
    const answer = await host().stop(id);
    if (answer === "gone" && records.get(key)?.token === token) setRun(key, exitRun(runOf(key), null, true));
  } catch {
    if (records.get(key)?.token === token && runOf(key).phase === "stopping") setRun(key, { ...runOf(key), phase: was.phase === "stopping" ? "starting" : was.phase });
  }
}

/** Stop the lane's preview. Its end then says it was stopped. */
export async function stopPreview(key: string): Promise<void> {
  const run = runOf(key);
  if (!isLive(run) || run.phase === "stopping") return;
  setRun(key, stoppingRun(run));
  if (run.id !== null) await stopById(key, run.id, run);
}

/** Open the address the lane's preview printed in the person's browser: that address and only that. */
export async function openPreview(key: string): Promise<void> {
  const run = runOf(key);
  if (run.phase !== "running" || !run.url) return;
  try {
    await host().open(run.url);
    patch(key, { openFailed: false });
  } catch {
    patch(key, { openFailed: true });
  }
}

/** The lane's session closed: its preview stops, and what was kept of it goes. */
export function forgetPreview(key: string): void {
  const r = records.get(key);
  if (!r) return;
  clearWait(key);
  records.delete(key);
  changed();
  if (r.run.id !== null && isLive(r.run)) void host().stop(r.run.id).catch(() => undefined);
}

/** The lane whose preview the shell knows as `id`, by its chat key: what keeps running names a preview's lane by it. */
export function chatOfPreview(id: number): string | null {
  for (const [key, r] of records) if (r.run.id === id) return key;
  return null;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The lane's preview, drawn again as it changes. */
export function usePreviewRecord(key: string): PreviewRecord {
  return useSyncExternalStore(
    subscribe,
    () => records.get(key) ?? EMPTY,
    () => records.get(key) ?? EMPTY,
  );
}

/** Changes whenever any lane's preview does (what keeps running names a preview's lane by it). */
export function usePreviewsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** The lane's preview as it is now (tests, and what keeps running). */
export const previewRecord = (key: string): PreviewRecord => records.get(key) ?? EMPTY;

/** Tests: a host and a clock of their own, and nothing kept. */
export function setPreviewTestHooks(o: { host?: PreviewHost | null; clock?: PreviewClock | null }): void {
  if (o.host !== undefined) hostOverride = o.host;
  if (o.clock !== undefined) clock = o.clock ?? realClock;
}
export function resetPreviewRuns(): void {
  for (const k of [...waits.keys()]) clearWait(k);
  records.clear();
  changed();
}
