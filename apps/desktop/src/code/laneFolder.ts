// What the lane's own folder says changed (the shell's `lane_diff`, src-tauri/src/lane_diff.rs), for the Diff beside the lane. The
// folder is the truth: it is there after a restart, it holds a subagent's edits, and a file the agent rewound is simply not in it.
// The chat's own events (changes.ts) are kept as two things only: the hint that something changed (`changeMark`, which says when
// to read again) and the fallback where the shell cannot read at all (a plain browser, a stand-in host).
//
// Nothing here runs git or touches a file. A read is the shell's answer turned into the files the diff view draws, and `folderReader`
// is the rule for when to ask again: at most once a gap, never on a timer, never two at once.
import type { DiffFile } from "../lib/protocol";
import type { Chat } from "../state/store";
import { diffOf } from "./moved";

/** The lines of one file's diff drawn at most; the rest is counted (`more`). The shell already stops a file at 256 KiB. */
export const FOLDER_LINES = 400;

/** What the shell read of the folder, as the page draws it: the files, the file that changed last first, and how many more
 *  there were than the shell lists. */
export interface LaneFolder {
  files: DiffFile[];
  moreFiles: number;
}

/** The part of the sessions host this reads (`SessionHost.laneDiff`), so a test can stand in for it. null: this host cannot read a
 *  folder (a plain browser). A folder the app did not make, or one git cannot read, rejects. */
export interface ReadsLaneFolder {
  laneDiff(worktree: string): Promise<LaneFolder | null>;
}

const text = (x: unknown): string => (typeof x === "string" ? x : "");
const NOTES = new Set(["binary", "too_large", "left_out"]);

/** The shell's answer as a `LaneFolder`, or null when it is not one (an older shell answers with nothing). A file with no path is
 *  dropped; a state the page does not know reads as changed; the shell's own text is never trusted to be a diff, so the lines are
 *  read the way the main-moved diffs are (moved.ts `diffOf`). */
export function readLaneFolder(raw: unknown): LaneFolder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.files)) return null;
  const files: DiffFile[] = [];
  for (const x of r.files) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const path = text(o.path);
    if (!path) continue;
    const state = text(o.state);
    const from = text(o.from);
    const note = text(o.note);
    const read = diffOf(path, text(o.diff), FOLDER_LINES);
    const f: DiffFile = { path, kind: state === "new" ? "add" : state === "deleted" ? "delete" : "update", lines: read.lines, added: read.added, removed: read.removed };
    if (read.more) f.more = read.more;
    if (state === "renamed" && from) f.from = from;
    if (NOTES.has(note)) f.note = note as DiffFile["note"];
    files.push(f);
  }
  const more = typeof r.more_files === "number" && r.more_files > 0 ? Math.floor(r.more_files) : 0;
  return { files, moreFiles: more };
}

/** The files the pane draws: the folder's when the shell read it, else what the chat's events said. */
export const filesShown = (folder: LaneFolder | null, fromEvents: DiffFile[]): DiffFile[] => (folder ? folder.files : fromEvents);

/** A short text that changes whenever the chat's events say a file may have changed: a step began or ended or got its change,
 *  a subagent took a step or ended, or the turn ended. It says nothing about what changed (the folder says that), only that it is
 *  time to read it again. Two readings of the same chat give the same text. */
export function changeMark(chat: Pick<Chat, "items" | "turn"> | undefined): string {
  const out: string[] = [chat?.turn ? "run" : "idle"];
  for (const item of chat?.items ?? []) {
    if (item.kind !== "activity") continue;
    const turn = item.turn;
    out.push(`${turn.steps.length}.${turn.endedAt ? 1 : 0}.${turn.steps.filter((s) => s.diff?.length).length}`);
    for (const fan of turn.fanouts ?? []) for (const sub of fan.subs) out.push(`${sub.id}.${sub.state}.${sub.steps?.length ?? 0}`);
  }
  return out.join("|");
}

/** The least time between two reads of the same folder. */
export const READ_GAP_MS = 1000;

export interface FolderReaderOptions {
  gap?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** When to read the folder again. `poke` says something may have changed: it reads at once when no read ran in the last `gap`
 *  and none is running, else once more when the gap is over (pokes in between are one read). Nothing runs unless poked, so there
 *  is no timer on an idle lane. A read that fails or says nothing leaves what was shown: git not answering is not a reason to
 *  say the folder is clean. */
export function folderReader(read: () => Promise<LaneFolder | null>, show: (f: LaneFolder) => void, opts: FolderReaderOptions = {}) {
  const gap = opts.gap ?? READ_GAP_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  let running = false;
  let again = false;
  let last = -Infinity;
  let timer: unknown = null;

  const run = async () => {
    timer = null;
    running = true;
    again = false;
    last = now();
    try {
      const got = await read();
      if (!stopped && got) show(got);
    } catch {
      /* keep what was shown */
    } finally {
      running = false;
    }
    if (!stopped && again) poke();
  };
  function poke() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    if (timer !== null) return;
    const wait = last + gap - now();
    if (wait <= 0) void run();
    else timer = setTimer(() => void run(), wait);
  }
  return {
    poke,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
