// Settings › Worktrees (item 73): how a lane's folder is made and cleaned up. Saved on this computer in `localStorage` like the
// other Settings choices (`lib/power.ts`), and handed to the shell on each call that needs one (src-tauri/src/lane.rs), so the
// shell keeps nothing of its own and a setting changed now applies to the next lane at once.
//
// - Where lanes are made: a folder the person chose ("" is the default, `~/.manut/lanes`). The shell checks it again every time.
// - Start from the remote: default OFF. A fetch reaches the network and may need a sign-in the person did not expect from
//   starting a chat, and the lane then starts from a commit the developer's own folder does not have. The person who wants it
//   turns it on.
// - Branch prefix: free text, checked by `validPrefix` (one or two lower case words ending in `/`), default `kit/`. Free
//   text over a fixed list because a team already has its own (`feature/`, `ana/`), and the check keeps every value one git takes.
// - Remove a deleted chat's folder: default ON, which is what closing a chat has always done for a folder with nothing in it.
//   Now it also leaves one whose branch has commits on no remote.
// - Remove a merged lane's folder: default OFF. It reads pull requests through `gh` or `glab`, so it is the person's to turn on.
import { useSyncExternalStore } from "react";
import { LANE_FOLDER, validPrefix } from "../code/laneBranch";

export interface WorktreeSettings {
  /** The folder lanes' folders are made under; "" is the default. */
  root: string;
  remote: boolean;
  prefix: string;
  cleanDeleted: boolean;
  cleanMerged: boolean;
}

export const WORKTREE_DEFAULTS: WorktreeSettings = { root: "", remote: false, prefix: LANE_FOLDER, cleanDeleted: true, cleanMerged: false };

const KEY = "manut.worktrees";
const RAN_KEY = "manut.worktrees.cleaned";

/** A merged clean-up for a project runs at most this often. It is asked for when the Code page opens the project and when the
 *  window is looked at again, never on a timer, so a person who leaves the app open makes no call in the background. */
export const CLEAN_EVERY_MS = 60 * 60 * 1000;

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

/** The saved settings; a value that is not usable (a prefix that fails the check, a folder that is not absolute) is the default. */
export function parseWorktrees(text: string | null): WorktreeSettings {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object") o = v as Record<string, unknown>;
  } catch {
    /* damaged: the defaults */
  }
  const d = WORKTREE_DEFAULTS;
  const root = typeof o.root === "string" && /^([/]|[A-Za-z]:[\\/])/.test(o.root) && !/[\u0000-\u001f]/.test(o.root) ? o.root : d.root;
  return {
    root,
    remote: typeof o.remote === "boolean" ? o.remote : d.remote,
    prefix: typeof o.prefix === "string" && validPrefix(o.prefix) ? o.prefix : d.prefix,
    cleanDeleted: typeof o.cleanDeleted === "boolean" ? o.cleanDeleted : d.cleanDeleted,
    cleanMerged: typeof o.cleanMerged === "boolean" ? o.cleanMerged : d.cleanMerged,
  };
}

const listeners = new Set<() => void>();
let cache: { text: string | null; value: WorktreeSettings } | null = null;

export function worktreeSettings(): WorktreeSettings {
  const text = read(KEY);
  if (!cache || cache.text !== text) cache = { text, value: parseWorktrees(text) };
  return cache.value;
}

/** Saves the choices in `patch`; a prefix that fails the check is not saved (the page says why before it gets here). */
export function setWorktreeSettings(patch: Partial<WorktreeSettings>): void {
  const next = { ...worktreeSettings(), ...patch };
  write(KEY, JSON.stringify(parseWorktrees(JSON.stringify(next))));
  listeners.forEach((l) => l());
}

export function useWorktreeSettings(): WorktreeSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    worktreeSettings,
    worktreeSettings,
  );
}

/** What the shell is told when a lane is made. */
export const startOf = (s: WorktreeSettings): { root: string; remote: boolean } => ({ root: s.root, remote: s.remote });

/** Why a prefix is refused, or null when it is fine. */
export function prefixProblem(text: string): "empty" | "slash" | "form" | null {
  if (text.trim() === "") return "empty";
  if (!text.endsWith("/")) return "slash";
  return validPrefix(text) ? null : "form";
}

/** Whether a merged clean-up of project `root` is due: never ran, or the last run was at least [`CLEAN_EVERY_MS`] ago. */
export function cleanupDue(now: number, last: number | undefined): boolean {
  return last === undefined || !Number.isFinite(last) || now - last >= CLEAN_EVERY_MS || now < last;
}

function ranMap(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(read(RAN_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
export const lastCleanup = (root: string): number | undefined => (typeof ranMap()[root] === "number" ? ranMap()[root] : undefined);
export function markCleanup(root: string, now: number): void {
  const m = ranMap();
  const keep = Object.entries({ ...m, [root]: now }).sort((a, b) => b[1] - a[1]).slice(0, 50);
  write(RAN_KEY, JSON.stringify(Object.fromEntries(keep)));
}
