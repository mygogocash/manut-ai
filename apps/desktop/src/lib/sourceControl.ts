// Settings › Source control (item 75): the choices the page keeps. Saved on this computer in `localStorage` like Settings ›
// Worktrees (`lib/worktrees.ts`), and handed to the shell on each call that needs one, so the shell keeps nothing of its own.
//
// - Automatically pull: default OFF. It reaches the network and moves the developer's own checkout (it writes the files the new
//   commits changed into their folder), which nobody should find has happened without having asked for it. T3 Code's own default
//   is off too. The person who wants it turns it on; it then runs only as `git_pull.rs` says (a clean default branch, a
//   fast-forward, never a lane's folder).
// - Default merge method: default "the last one I chose", which starts as a merge commit (GitHub's and GitLab's own first choice)
//   until the person picks another in a merge's ask. It only picks what the ask starts with: every merge is still asked, with the
//   method shown and changeable there, and no setting merges without asking.
// - Remove agent credits when merging: default OFF. Whose name goes in a merge's message is the person's call, and a co-author
//   line is a credit someone wrote on purpose; the person who wants them out turns it on. It changes only the message the app
//   proposes for its own merge (shown in the ask as sent), never a commit that exists (src-tauri/src/credits.rs).
import { useSyncExternalStore } from "react";
import { MERGE_METHODS, type MergeMethod } from "../code/source";
import { changes } from "./changes";

export interface SourceSettings {
  autoPull: boolean;
  /** What a merge's ask starts with: a method, or `last`, the one the person last chose there. */
  mergeMethod: MergeMethod | "last";
  /** The method the person last chose in a merge's ask on this computer. */
  lastMethod: MergeMethod;
  /** Take the recognised agent credit lines out of the merge or squash message the app proposes. */
  dropCredits: boolean;
}

export const SOURCE_DEFAULTS: SourceSettings = { autoPull: false, mergeMethod: "last", lastMethod: "merge", dropCredits: false };

const KEY = "manut.source";
const PULLED_KEY = "manut.source.pulled";

/** A pull of a project's default branch runs at most this often. It is asked for when the Code page opens the project and when
 *  the window is looked at again, never on a timer, so a person who leaves the app open makes no call in the background. Fifteen
 *  minutes, not item 73's hour: a branch an hour behind is one a person notices, and one fetch of one branch costs little. */
export const PULL_EVERY_MS = 15 * 60 * 1000;

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
    /* no storage */
  }
}

/** The saved settings; a value that is not usable is the default. */
export function parseSource(text: string | null): SourceSettings {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object") o = v as Record<string, unknown>;
  } catch {
    /* damaged: the defaults */
  }
  const d = SOURCE_DEFAULTS;
  const method = (v: unknown): MergeMethod | undefined => MERGE_METHODS.find((m) => m === v);
  return {
    autoPull: typeof o.autoPull === "boolean" ? o.autoPull : d.autoPull,
    mergeMethod: o.mergeMethod === "last" ? "last" : (method(o.mergeMethod) ?? d.mergeMethod),
    lastMethod: method(o.lastMethod) ?? d.lastMethod,
    dropCredits: typeof o.dropCredits === "boolean" ? o.dropCredits : d.dropCredits,
  };
}

/** The method a merge's ask starts with. */
export const startMethod = (s: SourceSettings): MergeMethod => (s.mergeMethod === "last" ? s.lastMethod : s.mergeMethod);

const listeners = changes();
let cache: { text: string | null; value: SourceSettings } | null = null;

export function sourceSettings(): SourceSettings {
  const text = read(KEY);
  if (!cache || cache.text !== text) cache = { text, value: parseSource(text) };
  return cache.value;
}

export function setSourceSettings(patch: Partial<SourceSettings>): void {
  write(KEY, JSON.stringify(parseSource(JSON.stringify({ ...sourceSettings(), ...patch }))));
  listeners.emit();
}

export function useSourceSettings(): SourceSettings {
  return useSyncExternalStore(
    (l) => {
      return listeners.subscribe(l);
    },
    sourceSettings,
    sourceSettings,
  );
}

/** Whether a pull of project `root` is due: never ran, or the last run was at least [`PULL_EVERY_MS`] ago (or the clock went
 *  back). */
export function pullDue(now: number, last: number | undefined): boolean {
  return last === undefined || !Number.isFinite(last) || now - last >= PULL_EVERY_MS || now < last;
}

function pulledMap(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(read(PULLED_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
export const lastPull = (root: string): number | undefined => (typeof pulledMap()[root] === "number" ? pulledMap()[root] : undefined);
/** Notes that project `root` was asked for now; the newest fifty projects are kept. */
export function markPull(root: string, now: number): void {
  const keep = Object.entries({ ...pulledMap(), [root]: now })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);
  write(PULLED_KEY, JSON.stringify(Object.fromEntries(keep)));
}
