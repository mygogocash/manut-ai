// The main branch moving while Kit worked (the canvas's StatesCodeDev board, "The project and its history"): "main
// changed while Kit worked. 1 file needs both changes", with Let Kit merge and Show me both.
//
// The shell reads git for the folder (`session_main_moved`, src-tauri/src/git_moved.rs) and answers with names and
// commit ids only: the branch, the branch it started from, where that branch is now, where this one left it, and the
// paths each side changed since. Everything else is decided here, from that answer, so it can be tested without git:
// which files need both changes, what the shell's answer must look like to be believed, one side's diff as the diff view
// draws it, and the ask Let Kit merge sends. Nothing here reads a file or runs a program.
import type { DiffFile } from "../lib/protocol";
import { t } from "../i18n";

/** What the shell read of git for one folder. `ours` is what the branch changed since it left `base`, uncommitted work
 *  included; `theirs` is what `base` changed since. `both` holds the two diffs of the paths the page asked to see. */
export interface GitView {
  branch: string;
  base: string;
  /** Where `base` is now, and where the branch left it (commit ids): they differ once `base` has moved on. */
  tip: string;
  fork: string;
  ours: string[];
  theirs: string[];
  both: SideText[];
}

/** One path's two diffs, as git printed them (the shell masked every key in them first). */
export interface SideText {
  path: string;
  theirs: string;
  ours: string;
}

/** The state the lane shows: the branch, the one it started from, and the files that need both changes. */
export interface Moved {
  branch: string;
  base: string;
  files: string[];
}

/** The files named in the ask Let Kit merge: past this many the rest are counted, not listed. */
export const MAX_ASKED = 10;

/** The lines of one side's diff drawn at most, per file: the rest is counted (`more`). */
export const DIFF_LINES = 120;

/** The paths both lists hold, once each, in name order. A path matches whole and in its own letter case. */
export function bothSides(ours: readonly string[], theirs: readonly string[]): string[] {
  const there = new Set(theirs);
  return [...new Set(ours)].filter((p) => p !== "" && there.has(p)).sort();
}

/** The state to show for the shell's answer, or null: no answer, the base branch itself, a base that has not moved,
 *  or one that moved without touching a file the branch touched (git merges that by itself, and nothing in it needs
 *  the person). */
export function movedOf(view: GitView | null | undefined): Moved | null {
  if (!view || view.branch === view.base || view.tip === view.fork) return null;
  const files = bothSides(view.ours, view.theirs);
  return files.length ? { branch: view.branch, base: view.base, files } : null;
}

const text = (x: unknown): string => (typeof x === "string" ? x : "");
const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string" && n !== "") : []);

/** The shell's answer as a `GitView`, or null when it is not one (an older shell answers with nothing; a reply that names
 *  no branch, base or commit cannot be told apart from a wrong one). Names and diffs that are not text are dropped. */
export function readView(raw: unknown): GitView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const branch = text(r.branch);
  const base = text(r.base);
  const tip = text(r.tip);
  const fork = text(r.fork);
  if (!branch || !base || !tip || !fork) return null;
  const both: SideText[] = [];
  for (const b of Array.isArray(r.both) ? r.both : []) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    if (typeof o.path === "string" && o.path !== "") both.push({ path: o.path, theirs: text(o.theirs), ours: text(o.ours) });
  }
  return { branch, base, tip, fork, ours: names(r.ours), theirs: names(r.theirs), both };
}

/** One side's change to a file, as the diff view draws it; `binary` when git could not show lines. */
export type SideFile = DiffFile & { binary?: true };

/** Git's unified diff of one path as a `DiffFile`: its hunks and lines without git's header, the "no newline" notes
 *  left out, counted over the whole diff and cut at `max` lines (`more` says how many were left out). */
export function diffOf(path: string, diff: string, max: number = DIFF_LINES): SideFile {
  const rows = diff.split("\n");
  let kind: DiffFile["kind"] = "update";
  let binary = false;
  let i = 0;
  // git's header is everything before the first hunk; once a hunk began, a line that starts with `---` is a change
  for (; i < rows.length && !rows[i].startsWith("@@"); i++) {
    if (rows[i].startsWith("new file mode")) kind = "add";
    else if (rows[i].startsWith("deleted file mode")) kind = "delete";
    else if (rows[i].startsWith("Binary files ") || rows[i].startsWith("GIT binary patch")) binary = true;
  }
  let lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (; i < rows.length; i++) {
    const l = rows[i];
    if (l.startsWith("\\")) continue;
    if (l === "" && i === rows.length - 1) continue;
    if (l.startsWith("@@") || l[0] === " ") {
      lines.push(l);
    } else if (l[0] === "+") {
      added++;
      lines.push(l);
    } else if (l[0] === "-") {
      removed++;
      lines.push(l);
    } else if (l === "") {
      // a blank line of context, with the space git printed before it trimmed away on the way
      lines.push(" ");
    }
  }
  const out: SideFile = { path, kind, lines, added, removed };
  if (lines.length > max) {
    out.more = lines.length - max;
    lines = lines.slice(0, max);
    out.lines = lines;
  }
  if (binary) out.binary = true;
  return out;
}

/** The most files whose two sides Show me both reads at once (the shell reads no more than this either). */
export const MAX_SHOWN = 20;

/** The part of the sessions host this reads (`SessionHost.mainMoved`), so a test can stand in for it. */
export interface ReadsGit {
  mainMoved(cwd: string, o?: { base?: string | null; show?: string[] }): Promise<GitView | null>;
}

/** Both sides of one file: what the base changed, and what the lane changed. */
export interface Side {
  path: string;
  theirs: SideFile;
  ours: SideFile;
}

/** Both sides of the first `MAX_SHOWN` of `files`, as the shell read them, in the order of `files`; null when the shell
 *  has nothing to say any more (the folder is not on that branch now). A file the shell gave no diffs for is left out. */
export async function readSides(host: ReadsGit, root: string, files: readonly string[]): Promise<Side[] | null> {
  const asked = files.slice(0, MAX_SHOWN);
  const v = await host.mainMoved(root, { show: asked });
  if (!v) return null;
  return asked.flatMap((path) => {
    const b = v.both.find((x) => x.path === path);
    return b ? [{ path, theirs: diffOf(path, b.theirs), ours: diffOf(path, b.ours) }] : [];
  });
}

/** A name as one line of text for the ask: a line break or a control character in a file name turns into a space, so a
 *  name cannot start a line of its own in what Kit reads. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ");

/** The ask Let Kit merge sends Kit: merge the base into the branch, name what changed on both sides, run the tests and
 *  show the result as a diff, and push nothing until the person says so. It goes to Kit as a message, so each step Kit
 *  takes then asks through its own card, as every step does (`kitDecide` decides which ones ask). */
export function mergeAsk(m: Moved): string {
  const shown = m.files.slice(0, MAX_ASKED).map(oneLine);
  const rest = m.files.length - shown.length;
  const files = shown.join(", ") + (rest > 0 ? ` ${t("kit.moved.askMore", { n: rest })}` : "");
  const vars = { base: oneLine(m.base), branch: oneLine(m.branch), n: m.files.length, files };
  return t(m.files.length === 1 ? "kit.moved.ask.one" : "kit.moved.ask.many", vars);
}
