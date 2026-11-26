// An ask a coding session raised, read as one of Kit's steps and decided by Kit's dial for the session's project.
//
// The shell names what each ask is from the agent's own message (`tool` on the ask, src-tauri/src/ask_tool.rs): the
// kind of step, a command's whole line, every path a file tool names and the folder the step runs in. That is what is
// read here first. A part the shell could not read is left out, and an ask missing a part it needs is left as it is:
// its card asks the person, as every ask did before the dial. Such an ask is never read by its words instead, since
// the words are where the shell's reading stops being exact.
//
// An ask with no `tool` at all (from a shell that did not name one) is read by the words the shell writes on it: "Run
// this command?" with the command, "Allow <tool> to change <files>?" for a file change, and "Allow <tool>?" with the
// tool's main argument for anything else; Codex puts its own reason in the title of a command. An ask those words do
// not cover whole (a plan, a tool that is not a file tool, a path the shell cut short, a change that names no file)
// is left as it is.
import { kitDecide, type Connection, type KitAction, type KitDecision } from "@manut/member-grants";
import { IN_GIT_DIR, folderOf, guardedPath, insideProject, readCommand, ruleCovers, type ReadCommand, type Rule, type Say, type Where } from "./command";
import type { KitProject } from "./project";
import type { AskTool } from "../lib/protocol";

/** A developer's own project on this Mac is Kit's connection, there from the start and with no practice days: the
 *  developer chooses the dial's level, and the lowest level is where a project starts. */
export const ON_THIS_MAC: Connection = { connected: true, connectedAt: 0, practiceDays: 0 };

/** The ask's own words, and what the shell named of it from the agent's own message. */
export interface AskWords {
  title: string;
  command: string;
  cwd?: string;
  plan?: string;
  /** Read first; the words above are read only for an ask without it. */
  tool?: AskTool;
}

export interface AskRead {
  what: "command" | "edit" | "read";
  action: KitAction;
  /** Paths outside the project, as written. */
  outside: string[];
  /** The folder "Allow this folder" would add for the first of them, when it can be known. */
  folder: string | null;
  /** It saves or sends the change (a commit, a push, a pull request). */
  saves: boolean;
  /** The rule "Always allow in this project" would keep. */
  rule: Rule | null;
  /** A command's line as it was read: what a kept rule is matched against. */
  line?: string;
  say: Say;
  /** For a command: the folders its shell may be in once it has run, and the folder a `cd` to the project's set it to
   *  (`foldersAfter` in ./command). */
  ends?: (string | null)[];
  resets?: string;
  /** For a command: once it has run, the branch checked out may not be the one read before it (item 120). */
  movesHead?: boolean;
}

const RUN = "Run this command?";
const CHANGE = /^Allow (.+?) to change (.+)\?$/s;
const READ = /^Allow (Read|NotebookRead|View|Grep|Glob|LS)\?$/;
/** The shell cuts a long detail short with an ellipsis: what is left is not the whole path. */
const cut = (s: string) => s.endsWith("…") || s.endsWith("...");
/** The longest list of files a step's words give, before it is cut after a whole name. */
const SAY_CHARS = 160;

/** The paths of `paths` outside the project and the folders in `mayUse`. A name with no folder in it is wherever the
 *  ask runs, and a `~` path is outside when the home folder is not known. */
const outsideOf = (paths: string[], where: Where, mayUse: readonly string[]) =>
  paths.filter((p) => {
    const abs = absolute(p, where);
    return abs === null || !insideProject(abs, where.root, mayUse);
  });

/** `p` as an absolute path from where the ask runs, or null when it cannot be known. */
function absolute(p: string, where: Where): string | null {
  if (p === "~" || p.startsWith("~/")) return where.home ? where.home + p.slice(1) : null;
  if (p.startsWith("~")) return null;
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]|^\\\\/.test(p)) return p;
  return `${(where.cwd || where.root).replace(/[\\/]+$/, "")}/${p}`;
}

/** Whether `p` is read from the folder it is used in, rather than from a root or the home folder. */
const relative = (p: string) => !(p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]|^\\\\/.test(p));

/** `p` as the project names it: from the project's folder when it is inside it, else as written. */
function shown(p: string, where: Where): string {
  const abs = absolute(p, where);
  const root = where.root.replace(/[\\/]+$/, "");
  if (abs === null || !root) return p;
  for (const sep of ["/", "\\"]) if (abs.startsWith(root + sep)) return abs.slice(root.length + 1);
  return p;
}

/** The files a step names, as its words list them: cut after the last whole name that fits, so a long list stays a
 *  line. Every path is still read; only the words are cut. */
function listed(paths: string[], where: Where): string {
  let out = "";
  for (const p of paths.map((x) => shown(x, where))) {
    const next = out ? `${out}, ${p}` : p;
    if (out && next.length > SAY_CHARS) return `${out}, …`;
    out = next;
  }
  return out;
}

/** Where a command leaves its shell, for the session's next command. */
const folders = (c: ReadCommand): Pick<AskRead, "ends" | "resets" | "movesHead"> => ({ ends: c.ends, ...(c.resets ? { resets: c.resets } : {}), movesHead: c.movesHead });

/** `v` when it is text that is not blank. */
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** `v` when it is a list of paths, each text that is not blank; null for anything else, an empty list included. */
const pathList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((p) => text(p) !== null) ? (v as string[]) : null;

/** The ask as one of Kit's steps at `where` (the project, its home folder, the folders Kit may read), or null when
 *  what it says does not say it whole. */
export function readAsk(ask: AskWords, where: Where): AskRead | null {
  if (ask.plan) return null;
  return ask.tool === undefined ? readWords(ask, where) : readTool(ask.tool, where);
}

/** The ask by what the shell named from the agent's own message. */
function readTool(tool: unknown, where: Where): AskRead | null {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
  const t = tool as Record<string, unknown>;
  const cwd = text(t.cwd);
  const paths = t.paths === undefined ? undefined : pathList(t.paths);
  // paths named but not readable whole: what they would have shown is not known
  if (paths === null) return null;
  // a command, and a path that is not from a root, are read from the folder the step runs in
  if (!cwd && (t.kind === "command" || paths?.some(relative))) return null;
  const at: Where = { ...where, cwd: cwd ?? where.root };
  const allowed = where.allowed ?? [];
  const folder = (outside: string[]) => (outside.length ? folderOf(outside[0], at) : null);

  if (t.kind === "command") {
    const line = text(t.line);
    if (!line) return null;
    const c = readCommand(line, at);
    // the paths the agent itself found the command reaching (Claude Code's `blocked_path`) are checked beside the
    // line's own, as the line's are: a folder Kit may read counts only for a command that only reads
    const reads = c.action === "read" || c.action === "check";
    const outside = [...c.outside];
    for (const p of outsideOf(paths ?? [], at, reads ? allowed : [])) if (!outside.includes(p)) outside.push(p);
    return { what: "command", action: c.action, outside, folder: folder(outside), saves: c.saves, rule: outside.length ? null : c.rule, line, say: c.say, ...folders(c) };
  }
  if (!paths) return null;
  if (t.kind === "read") {
    const outside = outsideOf(paths, at, allowed);
    return { what: "read", action: "read", outside, folder: folder(outside), saves: false, rule: null, say: { key: "kit.say.readFile", vars: { path: listed(paths, at) } } };
  }
  if (t.kind !== "edit" && t.kind !== "write" && t.kind !== "delete") return null;
  // a change is a write: the folders Kit may read do not count for it
  const outside = outsideOf(paths, at, []);
  let action: KitAction = t.kind === "delete" ? "delete" : "edit";
  let say: Say = t.kind === "delete" ? { key: "kit.say.delete" } : { key: "kit.say.edit", vars: { path: listed(paths, at) } };
  // git's own folder holds its settings and hooks, which can make a later read run a program, and the agents' settings
  // and instructions, the hooks a tool runs by itself and package.json do the same (`guardedPath`): a change to one, a
  // move into one or out of one included, asks at every level
  if (paths.some((p) => IN_GIT_DIR.test(p) || guardedPath(p, at))) action = "unknown";
  // deleting the project, or a folder it is in, is no step any level lets Kit take alone
  if (t.kind === "delete" && paths.some((p) => {
    const abs = absolute(p, at);
    return abs !== null && insideProject(where.root, abs, []);
  })) {
    action = "unknown";
    say = { key: "kit.say.wipe" };
  }
  return { what: "edit", action, outside, folder: folder(outside), saves: false, rule: null, say };
}

/** The ask by the words the shell writes on it, for an ask that names nothing. */
function readWords(ask: AskWords, where: Where): AskRead | null {
  const at: Where = { ...where, cwd: ask.cwd || where.cwd || where.root };
  const change = CHANGE.exec(ask.title);
  if (change) {
    const list = change[2];
    if (list === "files" || cut(list)) return null;
    const paths = list.split(", ").filter(Boolean);
    // a change is a write: the folders Kit may read do not count for it
    const outside = outsideOf(paths, at, []);
    // git's own folder holds its settings and hooks, which can make a later read run a program: a change there asks
    // at every level
    const gitOwn = paths.some((p) => IN_GIT_DIR.test(p) || guardedPath(p, at));
    return { what: "edit", action: gitOwn ? "unknown" : "edit", outside, folder: outside.length ? folderOf(outside[0], at) : null, saves: false, rule: null, say: { key: "kit.say.edit", vars: { path: list } } };
  }
  if (READ.test(ask.title)) {
    const path = ask.command.trim();
    if (!path || cut(path)) return null;
    const outside = outsideOf([path], at, where.allowed ?? []);
    return { what: "read", action: "read", outside, folder: outside.length ? folderOf(path, at) : null, saves: false, rule: null, say: { key: "kit.say.readFile", vars: { path } } };
  }
  const isCommand = ask.title === RUN || (ask.command.trim() !== "" && !/^Allow .+\?$/s.test(ask.title));
  if (!isCommand || cut(ask.command)) return null;
  const c = readCommand(ask.command, at);
  return { what: "command", action: c.action, outside: c.outside, folder: c.outside.length ? folderOf(c.outside[0], at) : null, saves: c.saves, rule: c.rule, line: ask.command, say: c.say, ...folders(c) };
}

/** What Kit's dial does with the step `read`, in `project`, while `keys` (files with a key typed in) are in the
 *  session's changes. */
export function decideAsk(read: AskRead, project: KitProject, keys: readonly string[], now: number = Date.now()): KitDecision {
  const line = read.what === "command" ? read.line : undefined;
  // a rule covers only the step it was kept for, never a harsher one with the same first words
  const alwaysAllowed = line !== undefined && project.rules.some((r) => ruleCovers(r, line, read.action));
  return kitDecide({ action: read.action, outside: read.outside.length > 0, holdsSecret: read.saves && keys.length > 0, alwaysAllowed }, project.level, ON_THIS_MAC, now);
}
