// A lane's branch and its own working folder. When Kit starts a piece of work in a project, the lane gets a branch of its
// own, named from the work (`kit/promptpay-qr`) and made from the branch the developer's folder is on, checked out in a
// folder of its own: a git worktree under the app's data folder (`~/.manut/lanes/<project>/<words>`). The shell makes it
// (`lane_worktree` in src-tauri/src/lane.rs); what is decided here is the name, and whether to make one at all. Pure:
// nothing runs and nothing is looked up.
//
// Each lane has its own folder, so several lanes work at once without touching each other's files, each made from the
// developer's branch (never stacked on another lane's work), and the developer's folder (its branch, index, stash and HEAD)
// never changes because of a lane. A lane with no folder of its own (the folder is not a repository, git refused, or the lane
// was made before lanes had folders) works in the session's folder, as every session did before.

/** The folder every branch Kit makes is in, so the developer sees at once which branches are Kit's. */
export const LANE_FOLDER = "kit/";

/** What a lane knows of its branch: the one it works on, the branch it was made from, and its own working folder: `dir`, where
 *  its agent works (the worktree, or the folder inside it that matches the session's), and `worktree`, the worktree itself,
 *  which names the lane to the shell when it goes. None of the two: the lane works in the session's own folder. */
export interface LaneBranch {
  name: string;
  base: string;
  dir?: string;
  worktree?: string;
}

/** What the shell made (`lane_worktree`): `left` is how many changed files of the developer's folder did not come along. */
export interface LaneMade {
  branch: string;
  base: string;
  dir: string;
  worktree: string;
  left: number;
}

/** A lane's working folder the app made, as the shell lists it (`lane_list`): still there or not, how many of its files are
 *  changed or new (null: not read), how many commits on its branch are not on its base (null: not read, or the base is gone),
 *  and when it was made (seconds). */
export interface KeptLane {
  worktree: string;
  dir: string;
  branch: string;
  base: string;
  made: number;
  exists: boolean;
  changed: number | null;
  ahead: number | null;
}

/** What the person said yes to when a lane's folder goes (`lane_remove`): the changed files they saw counted and the commits
 *  on its branch, and whether the branch goes too. 0 changed files: the folder goes only if nothing in it would be lost. */
export interface LaneRemoveAsk {
  changed: number;
  branch: boolean;
  ahead: number | null;
}

/** What happened: the folder went (`removed`), the branch went (`deleted`), or nothing was done because what is there differs
 *  from what the person saw (`changed` and `ahead` say what is there now). `error`: git's words when the branch stayed. */
export interface LaneRemoved {
  removed: boolean;
  deleted: boolean;
  changed: number | null;
  ahead: number | null;
  error: string | null;
}

/** Where session `rec`'s agent works: its lane's own folder, else the session's folder. Everything that reads a lane (the
 *  agent, Kit's dial, the test runs, Rewind, the main-moved note, what keeps running) reads it there. */
export const workDir = (rec: { cwd: string; lane?: LaneBranch }): string => rec.lane?.dir || rec.cwd;

/** Words a title is padded with, which say nothing of the work. */
const SMALL = new Set(
  "a an the to of in on at for and or with from into by as is it its this that these those my our your me we you i so be are was were do does can could would should will please what why how when where which who there here if then".split(" "),
);

/** The most words a name takes, and the longest the words may be together. A branch name is read in a list of them. */
const WORDS_MAX = 4;
const SLUG_MAX = 40;

/** `title` as the words a branch name is made of: lower case letters and numbers of the Latin alphabet, accents taken
 *  off (café is cafe). Words in another script are left out, since a name that git, every file system and every shell
 *  take is what the shell makes; a title that is all in another script gets `work`. */
function slug(title: string): string {
  const words = (title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SMALL.has(w));
  let out = "";
  for (const w of words.slice(0, WORDS_MAX)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > SLUG_MAX) {
      // the first word alone may be too long: cut it, and take no more
      if (!out) out = w.slice(0, SLUG_MAX);
      break;
    }
    out = next;
  }
  return out || "work";
}

/** The names to try for a lane called `title`, in order: `kit/promptpay-qr`, then the same with `-2`, `-3` … for a
 *  branch that is taken. The shell makes the first that no branch has. */
export function laneBranchNames(title: string, tries = 9): string[] {
  const base = `${LANE_FOLDER}${slug(title)}`;
  return Array.from({ length: Math.max(1, tries) }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
}

/** What to do about a lane's branch as the lane starts. */
export type LanePlan =
  /** Make the first of `names` that is free, from `base`, in a folder of its own. */
  | { kind: "make"; names: string[]; base: string }
  /** The folder is not a repository, so there is no branch to make or to be made from. */
  | { kind: "none"; why: "no_repository" };

/** `current`: the branch the developer's folder is on now (a short commit when it is detached, "" outside a repository).
 *  Every lane is made from it, whatever other lanes of the folder are doing: each works in a folder of its own. */
export function planLaneBranch(input: { title: string; current: string }): LanePlan {
  const { title, current } = input;
  if (!current) return { kind: "none", why: "no_repository" };
  return { kind: "make", names: laneBranchNames(title), base: current };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** The shell's answer to `lane_worktree` as a `LaneMade`, or null when it is not one: a lane runs in its folder only when the
 *  shell named a branch Kit makes and an absolute folder for it. */
export function readMade(raw: unknown): LaneMade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const made = { branch: str(r.branch), base: str(r.base), dir: str(r.dir), worktree: str(r.worktree), left: count(r.left) ?? 0 };
  const abs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  return made.branch.startsWith(LANE_FOLDER) && made.base && abs(made.dir) && abs(made.worktree) ? made : null;
}

/** The shell's list (`lane_list`), with every entry that is not one left out. */
export function readKept(raw: unknown): KeptLane[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    const k: KeptLane = { worktree: str(r.worktree), dir: str(r.dir), branch: str(r.branch), base: str(r.base), made: count(r.made) ?? 0, exists: r.exists === true, changed: count(r.changed), ahead: count(r.ahead) };
    return k.worktree && k.branch.startsWith(LANE_FOLDER) ? [k] : [];
  });
}

/** The shell's answer to `lane_remove`. Nothing is taken as removed unless the shell said so. */
export function readRemoved(raw: unknown): LaneRemoved {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { removed: r.removed === true, deleted: r.deleted === true, changed: count(r.changed), ahead: count(r.ahead), error: typeof r.error === "string" && r.error ? r.error : null };
}
