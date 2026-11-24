// What Kit keeps per project on this computer (localStorage `manut.kit.projects`, keyed by the project's folder as
// `pathKey` spells it): the level of Kit's dial, the rules kept with "Always allow in this project", the folders Kit
// may read beside the project ("Allow this folder"), and the latest steps stopped outside it. Like the TERMINALS folder
// groups, it never leaves this computer and nothing on disk changes for it. The pure helpers carry the rules; the
// store below them is the page's.
import { useSyncExternalStore } from "react";
import { kitLevelOf, type KitLevel } from "@manut/member-grants";
import { isTildePath, pathKey } from "../sessions/folders";
import { insideProject, type Rule } from "./command";

export const KIT_KEY = "manut.kit.projects";

/** A step stopped outside the project: what it was, the path as Kit wrote it, and the folder allowing it would add. */
export interface Blocked {
  what: "read" | "edit" | "command";
  path: string;
  folder: string;
  /** ms since epoch */
  at: number;
}

export interface KitProject {
  level: KitLevel;
  rules: Rule[];
  /** Folders Kit may read beside the project, absolute. */
  folders: string[];
  /** Newest first, one per path, at most `BLOCKED_MAX`. */
  blocked: Blocked[];
}

export type Projects = Record<string, KitProject>;

export const BLOCKED_MAX = 10;
const RULES_MAX = 50;
const FOLDERS_MAX = 20;

export const emptyProject = (): KitProject => ({ level: kitLevelOf(undefined), rules: [], folders: [], blocked: [] });

export const projectOf = (p: Projects, root: string): KitProject => p[pathKey(root)] ?? emptyProject();

const withProject = (p: Projects, root: string, f: (x: KitProject) => KitProject): Projects => {
  const key = pathKey(root);
  return key ? { ...p, [key]: f(projectOf(p, key)) } : p;
};

const sameRule = (a: Rule, b: Rule) => !!a.exact === !!b.exact && a.words.length === b.words.length && a.words.every((w, i) => w === b.words[i]);

export const setLevel = (p: Projects, root: string, level: KitLevel): Projects => withProject(p, root, (x) => ({ ...x, level: kitLevelOf(level) }));

export const addRule = (p: Projects, root: string, rule: Rule): Projects =>
  withProject(p, root, (x) => (x.rules.some((r) => sameRule(r, rule)) ? x : { ...x, rules: [...x.rules, rule].slice(-RULES_MAX) }));

export const dropRule = (p: Projects, root: string, rule: Rule): Projects => withProject(p, root, (x) => ({ ...x, rules: x.rules.filter((r) => !sameRule(r, rule)) }));

/** Whether `folder` may be allowed beside the project at `root`: an absolute folder that is not the project, and not
 *  one the project is in (the home folder, the root of the disk), which would open everything at once. */
export function mayAllow(folder: string, root: string): boolean {
  const f = pathKey(folder);
  if (!f || isTildePath(f) || !(f.startsWith("/") || /^[A-Za-z]:\\|^\\\\/.test(f))) return false;
  return !insideProject(root, f, []);
}

export const allowFolder = (p: Projects, root: string, folder: string): Projects => {
  const f = pathKey(folder);
  if (!mayAllow(f, root)) return p;
  return withProject(p, root, (x) => ({
    ...x,
    folders: x.folders.includes(f) ? x.folders : [...x.folders, f].slice(-FOLDERS_MAX),
    // what was stopped there is no longer stopped
    blocked: x.blocked.filter((b) => !insideProject(pathKey(b.folder), f, [])),
  }));
};

export const removeFolder = (p: Projects, root: string, folder: string): Projects =>
  withProject(p, root, (x) => ({ ...x, folders: x.folders.filter((f) => f !== pathKey(folder)) }));

export const noteBlocked = (p: Projects, root: string, b: Blocked): Projects =>
  withProject(p, root, (x) => ({ ...x, blocked: [b, ...x.blocked.filter((o) => o.path !== b.path)].slice(0, BLOCKED_MAX) }));

// ---- the saved record ---------------------------------------------------------------------------------------------

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((w) => typeof w === "string");

function readRule(x: unknown): Rule | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { words?: unknown; exact?: unknown };
  if (!isStrings(r.words) || !r.words.length || r.words.some((w) => !w)) return null;
  return r.exact === true ? { words: r.words, exact: true } : { words: r.words };
}

function readBlocked(x: unknown): Blocked | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Partial<Blocked>;
  if (!["read", "edit", "command"].includes(b.what as string) || typeof b.path !== "string" || typeof b.folder !== "string" || typeof b.at !== "number") return null;
  return { what: b.what as Blocked["what"], path: b.path, folder: b.folder, at: b.at };
}

/** The saved record, or nothing kept when it cannot be read. Each project's level, rules, folders and stopped steps are
 *  read on their own: a broken level is the lowest, a rule, folder or step that cannot be read is dropped. */
export function parseProjects(raw: string | null): Projects {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Projects = {};
  for (const [root, x] of Object.entries(v as Record<string, unknown>)) {
    const key = pathKey(root);
    if (!key || !x || typeof x !== "object" || Array.isArray(x)) continue;
    const o = x as Record<string, unknown>;
    out[key] = {
      level: kitLevelOf(o.level),
      rules: (Array.isArray(o.rules) ? o.rules : []).map(readRule).filter((r): r is Rule => r !== null).slice(-RULES_MAX),
      folders: (Array.isArray(o.folders) ? o.folders : []).filter((f): f is string => typeof f === "string" && mayAllow(f, key)).map(pathKey).slice(-FOLDERS_MAX),
      blocked: (Array.isArray(o.blocked) ? o.blocked : []).map(readBlocked).filter((b): b is Blocked => b !== null).slice(0, BLOCKED_MAX),
    };
  }
  return out;
}

// ---- the store ----------------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let cache: Projects | null = null;

const storage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** Every project's settings as saved on this computer. */
export function kitProjects(): Projects {
  if (cache) return cache;
  try {
    cache = parseProjects(storage()?.getItem(KIT_KEY) ?? null);
  } catch {
    cache = {};
  }
  return cache;
}

/** Changes the saved settings with `f`, and tells the page. Without storage the change holds for this run. */
export function updateKitProjects(f: (p: Projects) => Projects): void {
  const next = f(kitProjects());
  if (next === cache) return;
  cache = next;
  try {
    storage()?.setItem(KIT_KEY, JSON.stringify(next));
  } catch {
    /* no storage: the change holds for this run */
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Every project's settings, read again when they change. */
export function useKitProjects(): Projects {
  return useSyncExternalStore(subscribe, kitProjects, kitProjects);
}

/** One project's settings, read again when they change. */
export function useKitProject(root: string): KitProject {
  return projectOf(useKitProjects(), root);
}

/** Forgets the cached record, so the next read is from storage again (tests). */
export function resetKitProjects(): void {
  cache = null;
}
