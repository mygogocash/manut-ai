// An ask a coding session raised, read as one of Kit's steps and decided by Kit's dial for the session's project.
//
// The shell writes every ask in the same few shapes, whichever agent raised it (src-tauri/src/agent_chat.rs for
// Claude Code and Codex, acp_chat.rs for the ACP agents): "Run this command?" with the command, "Allow <tool> to
// change <files>?" for a file change, and "Allow <tool>?" with the tool's main argument for anything else; Codex puts
// its own reason in the title of a command. Those words are what is read here. An ask they do not cover whole (a
// plan, a tool that is not a file tool, a path the shell cut short, a change that names no file) is left as it is:
// its card asks the person, as every ask did before.
import { kitDecide, type Connection, type KitAction, type KitDecision } from "@manut/member-grants";
import { IN_GIT_DIR, folderOf, insideProject, readCommand, ruleMatches, type Rule, type Say, type Where } from "./command";
import type { KitProject } from "./project";

/** A developer's own project on this Mac is Kit's connection, there from the start and with no practice days: the
 *  developer chooses the dial's level, and the lowest level is where a project starts. */
export const ON_THIS_MAC: Connection = { connected: true, connectedAt: 0, practiceDays: 0 };

/** The ask's own words. */
export interface AskWords {
  title: string;
  command: string;
  cwd?: string;
  plan?: string;
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
  say: Say;
}

const RUN = "Run this command?";
const CHANGE = /^Allow (.+?) to change (.+)\?$/s;
const READ = /^Allow (Read|NotebookRead|View|Grep|Glob|LS)\?$/;
/** The shell cuts a long detail short with an ellipsis: what is left is not the whole path. */
const cut = (s: string) => s.endsWith("…") || s.endsWith("...");

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

/** The ask as one of Kit's steps at `where` (the project, its home folder, the folders Kit may read), or null when
 *  its words do not say it whole. */
export function readAsk(ask: AskWords, where: Where): AskRead | null {
  if (ask.plan) return null;
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
    const gitOwn = paths.some((p) => IN_GIT_DIR.test(p));
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
  return { what: "command", action: c.action, outside: c.outside, folder: c.outside.length ? folderOf(c.outside[0], at) : null, saves: c.saves, rule: c.rule, say: c.say };
}

/** What Kit's dial does with the ask `read` came from, in `project`, while `keys` (files with a key typed in) are in
 *  the session's changes. */
export function decideAsk(read: AskRead, ask: AskWords, project: KitProject, keys: readonly string[], now: number = Date.now()): KitDecision {
  const alwaysAllowed = read.what === "command" && project.rules.some((r) => ruleMatches(r, ask.command));
  return kitDecide({ action: read.action, outside: read.outside.length > 0, holdsSecret: read.saves && keys.length > 0, alwaysAllowed }, project.level, ON_THIS_MAC, now);
}
