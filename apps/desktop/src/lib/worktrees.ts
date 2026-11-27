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
//
// One project can set its own (item 99, "settings for one project"): start from the remote, the branch prefix and both
// clean-ups, each left out to follow every project's choice. Where lanes are made stays one choice for all projects, as it is
// a place on this Mac, not a habit of one repository. Kept on this computer beside the rest (`manut.worktrees.projects`, by the
// project's folder as `pathKey` spells it), and read by the lane code with the project it acts for.
import { useSyncExternalStore } from "react";
import { LANE_FOLDER, validPrefix } from "../code/laneBranch";
import { pathKey } from "../sessions/folders";
import { changes } from "./changes";

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

const listeners = changes();
let cache: { text: string | null; value: WorktreeSettings } | null = null;

/** Every project's choices, or project `project`'s: its own where it set them, every project's where it did not. */
export function worktreeSettings(project?: string): WorktreeSettings {
  const text = read(KEY);
  if (!cache || cache.text !== text) cache = { text, value: parseWorktrees(text) };
  if (!project) return cache.value;
  const own = projectWorktrees(project);
  return Object.keys(own).length ? { ...cache.value, ...own } : cache.value;
}

/** What one project sets for itself; each field it leaves out follows every project's choice. */
export type ProjectWorktrees = Partial<Pick<WorktreeSettings, "remote" | "prefix" | "cleanDeleted" | "cleanMerged">>;
const PROJECTS_KEY = "manut.worktrees.projects";
/** At most this many projects keep their own choices. */
const MAX_PROJECTS = 100;

/** The projects' own choices as kept, each checked as it is read: a value that is not usable is left out, so the project
 *  follows every project's choice there. */
export function parseProjectWorktrees(text: string | null): Record<string, ProjectWorktrees> {
  let v: unknown;
  try {
    v = text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, ProjectWorktrees> = {};
  for (const [project, o] of Object.entries(v as Record<string, unknown>).slice(0, MAX_PROJECTS)) {
    if (!/^([/]|[A-Za-z]:[\\/])/.test(project) || !o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const own: ProjectWorktrees = {
      ...(typeof r.remote === "boolean" ? { remote: r.remote } : {}),
      ...(typeof r.prefix === "string" && validPrefix(r.prefix) ? { prefix: r.prefix } : {}),
      ...(typeof r.cleanDeleted === "boolean" ? { cleanDeleted: r.cleanDeleted } : {}),
      ...(typeof r.cleanMerged === "boolean" ? { cleanMerged: r.cleanMerged } : {}),
    };
    if (Object.keys(own).length) out[project] = own;
  }
  return out;
}

let projectsCache: { text: string | null; value: Record<string, ProjectWorktrees> } | null = null;
function allProjectWorktrees(): Record<string, ProjectWorktrees> {
  const text = read(PROJECTS_KEY);
  if (!projectsCache || projectsCache.text !== text) projectsCache = { text, value: parseProjectWorktrees(text) };
  return projectsCache.value;
}

/** Project `project`'s own choices (none: it follows every project's). */
export const projectWorktrees = (project: string): ProjectWorktrees => allProjectWorktrees()[pathKey(project)] ?? {};

/** The projects that set any of their own. */
export const projectsWithOwnWorktrees = (): string[] => Object.keys(allProjectWorktrees());

/** Sets project `project`'s own choices: a value sets it, `null` puts it back to every project's choice. A prefix that fails
 *  the check is not saved (the page says why before it gets here). */
export function setProjectWorktrees(project: string, patch: { [K in keyof ProjectWorktrees]?: ProjectWorktrees[K] | null }): void {
  const all = { ...allProjectWorktrees() };
  const key = pathKey(project);
  const own: Record<string, unknown> = { ...(all[key] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete own[k];
    else own[k] = v;
  }
  if (Object.keys(own).length) all[key] = own as ProjectWorktrees;
  else delete all[key];
  write(PROJECTS_KEY, JSON.stringify(parseProjectWorktrees(JSON.stringify(all))));
  listeners.emit();
}

export function useProjectWorktrees(project: string): ProjectWorktrees {
  const get = () => projectWorktrees(project);
  return useSyncExternalStore((l) => listeners.subscribe(l), get, get);
}

/** Saves the choices in `patch`; a prefix that fails the check is not saved (the page says why before it gets here). */
export function setWorktreeSettings(patch: Partial<WorktreeSettings>): void {
  const next = { ...worktreeSettings(), ...patch };
  write(KEY, JSON.stringify(parseWorktrees(JSON.stringify(next))));
  listeners.emit();
}

export function useWorktreeSettings(): WorktreeSettings {
  const all = () => worktreeSettings();
  return useSyncExternalStore((l) => listeners.subscribe(l), all, all);
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
