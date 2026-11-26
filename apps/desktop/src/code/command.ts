// Reading a command Kit asks to run, before it runs: what kind of step it is (member-grants' `KitAction`), the paths it
// names outside the project, the rule "Always allow in this project" would keep for it, and what it does in words.
// Kit's dial (`kitDecide` in @manut/member-grants) decides from this whether Kit may run it alone, must ask, or is
// stopped. Pure: no file is looked at and nothing runs.
//
// The reading is careful rather than clever. A command it cannot read in advance (a substitution, a pipe into a
// shell, a program it does not know, a script of the project's own with an unknown name) is `unknown`, which asks at
// every level and keeps no rule. A command built from several takes its strictest part. Paths are compared as
// written, after `.` and `..` are taken out: nothing is looked up on disk, so a link that leads out is not seen, and
// `~` is outside unless the home folder is known.
import type { KitAction } from "@manut/member-grants";
import type { Key } from "../i18n";

/** Where a command runs. */
export interface Where {
  /** The folder it runs in: the ask's own, else the session's. */
  cwd: string;
  /** The project's folder: the folder the session started in. */
  root: string;
  /** The home folder, for `~`. */
  home?: string;
  /** Folders the developer allowed Kit to read beside the project ("Allow this folder"). Kit changes nothing there. */
  allowed?: readonly string[];
  /** The branch the project has checked out, for a push that names none. */
  branch?: string;
  /** The folders a session's earlier commands may have left its shell in, besides `cwd` (item 116): absolute paths, and
   *  null for one that cannot be known. The line is read from `cwd` and from each of them, and the strictest reading
   *  speaks, so whether an agent keeps a `cd` for its next command never decides what the dial lets go. */
  from?: readonly (string | null)[];
}

/** What a step does, in words: a dictionary key and its slots. */
export interface Say {
  key: Key;
  vars?: Record<string, string | number>;
}

/** What "Always allow in this project" keeps: a command's first words, or the whole command (`exact`), and the step it
 *  was kept for (item 116). A rule saved before it named its step has none. */
export interface Rule {
  words: string[];
  exact?: true;
  action?: KitAction;
}

export interface ReadCommand {
  action: KitAction;
  /** The paths it names outside the project and the allowed folders, as written. */
  outside: string[];
  /** It saves the change to the project's history or sends it (a commit, a push, a pull request). */
  saves: boolean;
  /** The rule "Always allow in this project" would keep, or null when none may be kept. */
  rule: Rule | null;
  say: Say;
  /** The folders the shell may be in once the line has run, absolute (null: one that cannot be known), for the
   *  session's next command (`foldersAfter`). */
  ends: (string | null)[];
  /** The line is only a `cd` to the project's or the session's folder, written in full: after it, that is where the
   *  shell is. */
  resets?: string;
  /** Once it has run, the branch checked out in the project's folder may not be the one read before it (item 120): a step
   *  switches, renames or detaches it, may leave the shell in another folder, or cannot be read at all. The session's next
   *  push that names no branch is then read with none, until the branch is read again from disk. */
  movesHead: boolean;
}

// ---- paths --------------------------------------------------------------------------------------------------------

const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A path as its root and its parts, `.` and `..` taken out. A Windows path compares without letter case. */
function parts(path: string): { root: string; list: string[]; win: boolean } {
  const win = WIN_ABS.test(path);
  const root = win ? (path.startsWith("\\\\") ? "\\\\" : path.slice(0, 2).toLowerCase()) : path.startsWith("/") ? "/" : "";
  const list: string[] = [];
  for (const p of path.slice(win && root !== "\\\\" ? 2 : 0).split(win ? /[\\/]+/ : /\/+/)) {
    if (!p || p === ".") continue;
    if (p === "..") list.pop();
    else list.push(win ? p.toLowerCase() : p);
  }
  return { root, list, win };
}

/** Whether `inner` is `outer` or a path inside it, by whole folder names. */
function within(inner: string, outer: string): boolean {
  const a = parts(inner);
  const b = parts(outer);
  if (a.root !== b.root || a.win !== b.win || a.list.length < b.list.length) return false;
  return b.list.every((p, i) => a.list[i] === p);
}

/** Whether the absolute path `path` is inside the project `root` or one of the `allowed` folders. */
export function insideProject(path: string, root: string, allowed: readonly string[]): boolean {
  return within(path, root) || allowed.some((f) => within(path, f));
}

const isAbs = (p: string) => p.startsWith("/") || WIN_ABS.test(p);

/** The folder "Allow this folder" would add for `written`, a path as Kit wrote it: the folder a file is in, or the
 *  folder itself. Null when it cannot be known. Nothing is looked up on disk, so a name with an extension is a file. */
export function folderOf(written: string, where: Pick<Where, "cwd" | "home">): string | null {
  const abs = resolve(written, where.cwd, where.home);
  if (abs === null) return null;
  const p = parts(abs);
  const last = p.list[p.list.length - 1] ?? "";
  const list = /.\.[A-Za-z0-9]{1,8}$/.test(last) ? p.list.slice(0, -1) : p.list;
  const sep = p.win ? "\\" : "/";
  return p.root === "/" ? `/${list.join("/")}` : `${p.root}${sep}${list.join(sep)}`;
}

/** `word` as an absolute path from `cwd`, or null when it cannot be known (`~` with no home, `~user`). */
function resolve(word: string, cwd: string, home: string | undefined): string | null {
  if (word === "~" || word.startsWith("~/")) return home ? home + word.slice(1) : null;
  if (word.startsWith("~")) return null;
  if (isAbs(word)) return word;
  return `${cwd.replace(/[\\/]+$/, "")}/${word}`;
}

/** The same folder as `b`, compared after `.` and `..` are taken out. */
function samePath(a: string, b: string): boolean {
  return within(a, b) && within(b, a);
}

// ---- files a change to which always asks --------------------------------------------------------------------------

/** Folders whose files make a program run later or change what an agent may do: git's own; the agents' settings,
 *  instructions, skills, commands and plugins (for every agent the app starts, `src-tauri/src/agent_chat.rs`,
 *  `acp_agents.rs`, `lane_config.rs`); hooks a tool on the person's side runs (husky, a hooks folder, CI, an editor's
 *  tasks, a dev container); and the package managers' and cargo's own settings, which name what runs every script. */
const GUARDED_DIRS = new Set([
  ".git", ".claude", ".codex", ".agents", ".agent", ".cursor", ".gemini", ".qwen", ".kimi", ".opencode", ".pi", ".omp", ".clinerules",
  ".cline", ".copilot", ".github", ".husky", ".githooks", ".vscode", ".idea", ".devcontainer", ".zed", ".helix", ".fleet", ".yarn",
  ".circleci", ".buildkite", ".gitlab", ".mise", ".cargo",
]);
/** Files of the same kinds, in any folder, and package.json, Makefile and the like, whose scripts a check and Preview's
 *  Start run by a name that says nothing of what they do. */
const GUARDED_FILES = new Set([
  ".mcp.json", "claude.md", "claude.local.md", "agents.md", "agents.override.md", "gemini.md", "qwen.md", ".cursorrules", "opencode.json",
  "opencode.jsonc", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarnrc.yaml", "pnpm-workspace.yaml", "bunfig.toml", ".bunfig.toml",
  "package.json", ".gitmodules", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml",
  "lefthook-local.yml", "lefthook-local.yaml", ".simple-git-hooks.json", ".simple-git-hooks.js", ".simple-git-hooks.cjs",
  "simple-git-hooks.json", ".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile", "makefile",
  "gnumakefile", "justfile", ".justfile", "taskfile.yml", "taskfile.yaml", "taskfile.dist.yml", "taskfile.dist.yaml", "mise.toml",
  ".mise.toml", "mise.local.toml", ".mise.local.toml", "composer.json", "deno.json", "deno.jsonc", "project.json", "nx.json", "turbo.json",
  ".nvim.lua", ".nvimrc", ".exrc",
]);
const GUARDED_NAMES = [/^\.pnpmfile\./, /^\.lintstagedrc/, /^lint-staged\.config\./, /\.code-workspace$/, /^\.?mise\..+\.toml$/];

/** Whether `root` is a lane's own working folder in the app's folder: exactly two names below `.manut/lanes`
 *  (`~/.manut/lanes/<project>/<words>`, src-tauri/src/lane.rs). */
const laneFolder = (root: string) => {
  const r = parts(root).list.map(fold);
  const k = r.lastIndexOf(".manut");
  return k >= 0 && r[k + 1] === "lanes" && r.length === k + 4;
};

/** Whether `path` is in the app's own storage, which holds what the app runs and trusts later: its workflows, the lanes'
 *  records, the accounts, the providers' settings, the terminals' history, and the web view's own data and caches. All of
 *  `.manut` is, but for the folder the session itself works in when that is a lane's own: every other lane's folder, and
 *  everything above the lane, is the app's. A name in another letter case is never the session's own folder. */
function appOwn(path: string, root: string): boolean {
  const full = parts(path).list.map(fold);
  for (let i = 0; i + 2 < full.length; i++) if (full[i] === "library" && (full[i + 1] === "webkit" || full[i + 1] === "caches") && full[i + 2] === "xyz.manut.desktop") return true;
  if (!full.includes(".manut")) return false;
  return !(laneFolder(root) && within(path, root));
}

/** A file name as a disk that ignores letter case compares it (macOS's, by default): upper case and back folds the
 *  Kelvin sign and the long s as that disk does. A Windows disk also drops dots and spaces at a name's end and reads
 *  `name::$DATA` as the file itself. */
const fold = (part: string) => part.normalize("NFC").toUpperCase().toLowerCase().replace(/:.*$/, "").replace(/[. ]+$/, "");

/** Whether a change to `written` is one the dial never lets go alone: a path into one of the folders above or to one of
 *  the files, compared after `.` and `..` are taken out and by name whatever its letter case, from the project's folder
 *  (a project kept inside a folder of that name is not one). A Windows short name (`PACKAG~1.JSO`) may be any of them. */
export function guardedPath(written: string, where: Pick<Where, "cwd" | "root" | "home">): boolean {
  const abs = resolve(written, where.cwd, where.home);
  if (appOwn(abs ?? written, where.root)) return true;
  const p = parts(abs ?? written);
  const r = parts(where.root);
  const inside = abs !== null && within(abs, where.root);
  const list = (inside ? p.list.slice(r.list.length) : p.list).map(fold);
  if (list.some((x) => GUARDED_DIRS.has(x) || /~[0-9]/.test(x))) return true;
  const name = list[list.length - 1] ?? "";
  return GUARDED_FILES.has(name) || GUARDED_NAMES.some((re) => re.test(name));
}

const NULL_DEVICES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "NUL"]);
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const SCP_LIKE = /^[^\s/:@]+@[^\s/:]+:/;

/** A word that names a place on disk that could be outside the folder it runs in. A bare name (`build`) is inside
 *  wherever the command runs, so it is never one. */
function pathLike(word: string): boolean {
  if (!word || URL_LIKE.test(word) || SCP_LIKE.test(word)) return false;
  return word.startsWith("~") || isAbs(word) || word === ".." || word.startsWith("../") || word.includes("/..") || word.startsWith("..\\");
}

// ---- the shell's words --------------------------------------------------------------------------------------------

/** What joins a simple command to the one before it or after it: `start` and `end` for the line's ends, `;` also for a
 *  line break. */
type Sep = "start" | "end" | ";" | "&&" | "||" | "|" | "&";

interface Simple {
  words: string[];
  /** What joins it to the command before it, and to the one after it. */
  sep: Sep;
  after: Sep;
  /** Where its output or input goes: each target as written. */
  redirects: string[];
  /** The targets it writes its output into. */
  writes: string[];
  /** It reads the output of the command before it through a pipe. */
  piped: boolean;
}

interface Lexed {
  cmds: Simple[];
  /** Something in it cannot be read in advance: a substitution, a variable, a here-document, a subshell. */
  opaque: boolean;
}

/** The command line split into simple commands, as a POSIX shell would, without expanding anything. */
function lex(line: string): Lexed {
  const cmds: Simple[] = [];
  let opaque = false;
  let cur: Simple = { words: [], redirects: [], writes: [], piped: false, sep: "start", after: "end" };
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let redirect = false;
  /** The redirect being read writes (`>`, `>>`, `&>`), rather than reads (`<`). */
  let writing = false;
  /** In the word being read: an unquoted `{`, and after it an unquoted `,` or `..`, so that a `}` closes a brace list. */
  let braceOpen = false;
  let braceList = false;
  /** The redirect being read came with `&` (`>&`, `<&`): a stream's number after it is a copy of that stream. */
  let copies = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirect) {
      // `>&2`, `2>&1`, `>&-`: a copy of another stream, or one closed, not a file. Any other word after `>&` is a file
      // the shell writes both streams into, `>& file` as much as `>&file`.
      if (!(copies && /^([0-9]+-?|-)$/.test(word))) {
        cur.redirects.push(word);
        if (writing) cur.writes.push(word);
      }
      redirect = false;
      copies = false;
    } else cur.words.push(word);
    word = "";
    inWord = false;
    braceOpen = false;
    braceList = false;
  };
  const endCmd = (next: Sep) => {
    endWord();
    if (redirect) opaque = true; // a redirect with no target
    if (cur.words.length || cur.redirects.length) {
      cur.after = next;
      cmds.push(cur);
      cur = { words: [], redirects: [], writes: [], piped: next === "|", sep: next, after: "end" };
    } else if (cur.sep === "start" || cur.sep === ";") {
      // `a &&` then a line break goes on with the same list: a command after it is joined by `&&`, not by the break
      cur = { ...cur, piped: next === "|", sep: next };
    }
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== undefined && '"\\$`'.includes(next)) word += line[++i];
      else if (c === "$" || c === "`") {
        opaque = true;
        word += c;
      } else word += c;
      continue;
    }
    if (c === "\\") {
      if (next === "\n") i++;
      else if (next !== undefined) {
        word += line[++i];
        inWord = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n" || c === ";") {
      endCmd(";");
      continue;
    }
    if (c === "&" && next === "&") {
      endCmd("&&");
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endCmd("||");
        i++;
      } else {
        if (next === "&") i++;
        endCmd("|");
      }
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      redirect = true;
      writing = true;
      i += line[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endCmd("&");
      continue;
    }
    if ((c === "<" || c === ">") && next === "(") {
      opaque = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "<" || c === ">") {
      // a file descriptor written right before it (`2>`) belongs to the redirect, not to the words
      if (inWord && /^[0-9]+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      writing = c === ">";
      // `<>` opens the file to write as well as read, and makes it when it is not there
      if (c === "<" && next === ">") writing = true;
      if (c === "<" && next === "<") {
        // a here-document's text follows on the next lines; a here-string's is a word, not a file
        if (line[i + 2] === "<") {
          i += 2;
          redirect = false;
          continue;
        }
        opaque = true;
        i++;
        continue;
      }
      if (next === ">" || next === "|") i++;
      // zsh reads `>!` and `>>!` as a write that may replace a file, and its target is the word after; bash reads `!` as
      // the file's name. The two differ, so the command is not read in advance.
      if (line[i + 1] === "!") opaque = true;
      if (line[i + 1] === "&") {
        i++;
        copies = true;
      }
      redirect = true;
      continue;
    }
    // `$'…'` decodes escapes (`$'\x2dexec'` is `-exec`) and `$"…"` translates its text: neither is what it looks like.
    // zsh, the shell Codex and Claude Code run commands in on a Mac, expands more after a `$` than bash does: `$=X` and
    // `${=X}` split a variable into words (options among them), `$~X` reads it as a pattern, `$^X`, `$+X`, `${(z)X}` and
    // `${(e)X}` do more again. So a `$` followed by anything but a blank or the line's end is never read as itself, and
    // since no expansion is read, a variable set earlier in the line cannot reach a later word unseen.
    if (c === "`" || (c === "$" && next !== undefined && !/[\s]/.test(next))) {
      opaque = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "(" || c === ")" || ((c === "{" || c === "}") && !inWord && (next === undefined || next === " " || next === "\n"))) {
      opaque = true;
      continue;
    }
    // The shell expands an unquoted word before the program sees it, and this reading cannot follow it there. A pattern
    // (`*`, `?`, `[`) becomes the names of files, and a file the agent named like an option (`-delete`) then becomes one;
    // a brace list (`-{true,exec}`) becomes several words, so `find . -{true,exec} rm {} \;` runs `rm` while it reads as
    // a plain `find`. A command holding either is one that cannot be read in advance, and asks. Quoted or escaped, each
    // is only itself, and `find`'s `{}`, with no list inside, is not expanded.
    if (c === "*" || c === "?" || c === "[") opaque = true;
    // zsh replaces a word that starts with `=` by the path of the program it names (`=node` is `/usr/local/bin/node`),
    // which is no path the command wrote
    if (c === "=" && !inWord && next !== undefined && !/[\s;|&<>()]/.test(next)) opaque = true;
    if (c === "{") braceOpen = true;
    else if (braceOpen && (c === "," || (c === "." && next === "."))) braceList = true;
    else if (c === "}" && braceOpen && braceList) opaque = true;
    word += c;
    inWord = true;
  }
  if (quote) opaque = true;
  endCmd("end");
  return { cmds, opaque };
}

// ---- what a program does ------------------------------------------------------------------------------------------

/** How strict a step is, for a command built from several: the strictest part speaks for the whole. */
const RANK: Record<KitAction, number> = { read: 0, check: 1, edit: 2, change: 3, install: 4, delete: 5, push: 6, unknown: 7, live: 8 };

interface Verdict {
  action: KitAction;
  say: Say;
  /** How many of the command's first words a kept rule holds; "exact" for the whole command; absent for none. */
  head?: number | "exact";
  saves?: boolean;
  /** Words that are text, not paths (a pattern, a message, a script), by their index in the command's words. */
  text?: Set<number>;
  /** For `cd`: where it goes, as written (`~` when it names nothing). */
  cd?: string;
  /** Its folders are where it looks, not what it deletes (a `find` that deletes only what matches a name). */
  filtered?: true;
  /** After it, the folder the shell is in cannot be known (`cd -`, `pushd`, `popd`, `source`, `eval`). */
  lost?: true;
  /** It may switch, rename or detach the branch checked out, or make another repository to work in (item 120). */
  moves?: true;
}

const say = (key: Key, vars?: Say["vars"]): Say => (vars ? { key, vars } : { key });
const v = (action: KitAction, s: Say, head?: number | "exact", extra: Partial<Verdict> = {}): Verdict => ({ action, say: s, ...(head === undefined ? {} : { head }), ...extra });
const unknownProgram = (program: string): Verdict => v("unknown", say("kit.say.unknown", { program }));
const thisMac = (): Verdict => v("unknown", say("kit.say.thisMac"));
const sends = (): Verdict => v("unknown", say("kit.say.send"));
const live = (): Verdict => v("live", say("kit.say.live"));

/** The first word that is not an option, from `from`, skipping the values of the options in `takesValue`. */
function operands(words: string[], from: number, takesValue: ReadonlySet<string> = new Set()): number[] {
  const out: number[] = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      for (let j = i + 1; j < words.length; j++) out.push(j);
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (takesValue.has(w)) i++;
      continue;
    }
    out.push(i);
  }
  return out;
}

/** jq's operands (and yq's, which takes jq's options): `--arg`, `--argjson`, `--slurpfile` and `--rawfile` each take a name and
 *  then a value, where its other options with a value take one. Read as one-value options, `--arg x 1 '<filter>'` made `1` the
 *  filter and left the real filter unread. */
const JQ_TWO_VALUES = new Set(["--arg", "--argjson", "--slurpfile", "--rawfile"]);
const JQ_ONE_VALUE = new Set(["--indent", "-L", "--library-path", "--seq-prefix", "--stream-errors-to"]);
function jqOperands(words: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      for (let j = i + 1; j < words.length; j++) out.push(j);
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (JQ_TWO_VALUES.has(w)) i += 2;
      else if (JQ_ONE_VALUE.has(w)) i++;
      continue;
    }
    out.push(i);
  }
  return out;
}

/** Whether the word `w` is the option `opt` in a form the program reads as it: a long one in full, with `=value`, or
 *  shortened to any start of its name (git and every program built on GNU getopt take an unambiguous start, so
 *  `--upload-pa` is `--upload-pack`); a short one alone, joined to its value (`-ofile`) or bundled after other short ones
 *  (`-fsSLo`); a word option (`-exec`, `-TT`) itself or with its value joined. `values` are the short options of the
 *  program that take a value: in a bundle, what follows one of them is its value, not more options. Leaving one out
 *  only reads more into a word, never less. */
function isOpt(w: string, opt: string, values = ""): boolean {
  if (w === opt) return true;
  if (opt.startsWith("--")) {
    if (!w.startsWith("--") || w.length < 3) return false;
    const name = w.slice(2).split("=")[0];
    return name !== "" && opt.slice(2).startsWith(name);
  }
  if (opt.length === 2) {
    if (!/^-[^-]/.test(w)) return false;
    for (const c of w.slice(1)) {
      if (c === opt[1]) return true;
      if (values.includes(c)) return false;
    }
    return false;
  }
  return opt.startsWith("-") && w.startsWith(opt);
}

/** Whether any of `words` is one of the options `opts` (`isOpt`). For an option that makes a step stricter: reading too
 *  much into a word only ever asks more. */
const has = (words: string[], ...opts: string[]) => words.some((w) => opts.some((o) => isOpt(w, o)));
/** `has` with the short options of the program that take a value. */
const hasIn = (values: string, words: string[], ...opts: string[]) => words.some((w) => opts.some((o) => isOpt(w, o, values)));
/** Whether one of `opts` is written in full, for an option that makes a step looser (a dry run, a list). It counts only
 *  as written and only while no word takes an option back (`--no-dry-run`, or any start of one), so a word read too
 *  much into never lets a step through. */
const hasExactly = (words: string[], ...opts: string[]) => words.some((w) => opts.includes(w)) && !words.some((w) => w.startsWith("--no-"));

/** A package.json script, a make target or a task, by its name. Known names only: any other may do anything. */
function script(name: string, head: number): Verdict {
  const n = name.toLowerCase();
  if (/deploy|release|publish|ship|(^|[:._-])prod(uction)?($|[:._-])/.test(n)) return live();
  // A name that only looks says so: "check" anywhere in it ("format:check", "prettier-check"), or "lint" at its end. One
  // that also fixes or writes ("lint:fix") still changes files. A name kept from this rule is read below as a check, or as
  // unknown, which asks every time, so it is never let through as anything freer than what it says.
  const onlyLooks = n.includes("check") || n.endsWith("lint");
  if (/fix|write|format|fmt|prettier/.test(n) && !onlyLooks) return v("change", say("kit.say.format"), head);
  if (/^(test|tests|spec|e2e|coverage|cover)([:._-].*)?$/.test(n) || /[:._-](test|tests|spec|e2e)$/.test(n)) return v("check", say("kit.say.test"));
  if (/^(check|checks|lint|typecheck|type-check|types|tsc|verify|validate|ci)([:._-].*)?$/.test(n) || /[:._-](check|lint|typecheck)$/.test(n))
    return v("check", say("kit.say.check"));
  if (/^(build|compile|bundle|generate|gen|codegen|prepare)([:._-].*)?$/.test(n)) return v("change", say("kit.say.build"), head);
  if (/^(dev|start|serve|preview|watch|storybook)([:._-].*)?$/.test(n)) return v("change", say("kit.say.run"), head);
  return v("unknown", say("kit.say.script", { name }));
}

const PM_VALUE = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd", "--reporter", "--loglevel", "--workspace-dir", "--depth", "--audit-level", "--workspace-concurrency", "--resume-from", "--test-pattern", "--omit", "--include", "--tag"]);
/** A package manager's own options that choose where and how it works and nothing more. Any other may set what it runs
 *  every script with (`--script-shell`, `--node-options`, `--config.script-shell`, `--userconfig`, a settings file): so a
 *  command with one is not read in advance. pnpm, yarn and bun hand the words after a script's name to the script; npm reads
 *  every option before `--` as its own. */
const PM_FLAGS = new Set([
  "-r", "--recursive", "-w", "--workspace-root", "--silent", "-s", "--if-present", "--parallel", "--stream", "--no-bail", "--bail",
  "--aggregate-output", "--sequential", "--frozen-lockfile", "--no-frozen-lockfile", "--prefer-frozen-lockfile", "--prefer-offline", "--offline",
  "--prod", "--production", "-P", "--dev", "-D", "--save-dev", "-E", "--save-exact", "--exact", "-O", "--save-optional", "--save-peer",
  "--save-prod", "--no-optional", "--optional", "--peer", "--ignore-scripts", "-y", "--yes", "--json", "--long", "--version", "-v", "-h",
  "--help", "--color", "--no-color", "-q", "--quiet", "--verbose", "--workspaces", "--include-workspace-root", "--fix", "--latest", "-L",
  "--no-save", "--save", "-S", "--legacy-peer-deps", "--lockfile-only", "--fix-lockfile", "--strict-peer-dependencies", "--no-lockfile",
  "--pure-lockfile", "--immutable", "--non-interactive", "--no-audit", "--no-fund", "--no-package-lock", "--no-progress", "--reverse",
  "--fail-if-no-match", "--report-summary", "--interactive", "-i", "--dry-run",
]);

/** The first of a package manager's own options that is not one it is read with, or null. */
function strangePmOption(words: string[], from: number, to: number): string | null {
  for (let i = from; i < to; i++) {
    const w = words[i];
    if (w === "--") break;
    if (!w.startsWith("-") || w === "-") continue;
    if (PM_FLAGS.has(w)) continue;
    if (PM_VALUE.has(w.split("=")[0])) {
      if (!w.includes("=") && takesWord(words[i + 1])) i++;
      continue;
    }
    return w;
  }
  return null;
}

/** A package named by where it is fetched from rather than by its name, or a registry the agent chose: asking it reaches a
 *  computer the words name, and the address can carry anything out. */
const PKG_ADDRESS = /:\/\/|^(git\+|git@|github:|gitlab:|bitbucket:|gist:|file:)|@(git\+|https?:|file:|github:|git@)/;

/** pnpm, npm, yarn and bun. */
function packageManager(words: string[], where: Where): Verdict {
  const pm = words[0];
  if (has(words, "-g", "--global", "--location")) return thisMac();
  const ops = operands(words, 1, PM_VALUE);
  if (strangePmOption(words, 1, ops.length ? ops[0] : words.length) || (pm === "npm" && strangePmOption(words, 1, words.length))) return unknownProgram(pm);
  if (!ops.length) return pm === "yarn" ? v("install", say("kit.say.installAll"), 1) : v("read", say("kit.say.read"));
  const at = ops[0];
  const sub = words[at];
  const head = at + 1;
  const rest = ops.slice(1).map((i) => words[i]);
  // what a script is handed after its name goes to whatever the script runs
  const handed = (from: number, s: Verdict): Verdict => {
    if (s.action !== "check") return s;
    const known = knownOptions("", words.slice(from), true);
    if (known === "unknown") return unknownProgram(pm);
    return checkOptions("", words.slice(from)) ?? (known === "change" ? v("change", say("kit.say.format"), head) : s);
  };
  if (pm === "yarn" && sub === "global") return thisMac();
  if (["add", "install", "i", "in", "ci"].includes(sub)) {
    if (sub === "ci" || !rest.length) return v("install", say("kit.say.installAll"), head);
    return v("install", rest.length === 1 ? say("kit.say.add1") : say("kit.say.addN", { n: rest.length }), head);
  }
  if (["remove", "rm", "uninstall", "un", "unlink"].includes(sub)) {
    if (!rest.length) return unknownProgram(pm);
    return v("install", rest.length === 1 ? say("kit.say.remove1") : say("kit.say.removeN", { n: rest.length }), head);
  }
  if (["update", "up", "upgrade", "dedupe", "prune"].includes(sub)) return v("install", say("kit.say.update"), head);
  if (sub === "audit") return has(words, "fix", "--fix") ? v("install", say("kit.say.update"), head) : v("check", say("kit.say.check"));
  // bun's `test` is its own runner, which takes a program to load first (`--preload`)
  if (["test", "t", "tst"].includes(sub)) return handed(head, v("check", say("kit.say.test")));
  if (sub === "run" || sub === "run-script") {
    const name = rest[0];
    return name ? handed(words.indexOf(name, head) + 1, script(name, head + 1)) : v("read", say("kit.say.read"));
  }
  // dlx fetches the tool from the registry every time; exec (and bun's x) runs the project's own
  if (sub === "dlx") return v("unknown", say("kit.say.opaque"));
  if (["exec", "x"].includes(sub)) return at$(tool(words.slice(head), where, pm === "npm" ? NPX_FLAGS : undefined), head);
  if (["publish", "deploy"].includes(sub)) return live();
  if (sub === "pack") return v("change", say("kit.say.build"), head);
  // its settings can name the shell every script runs in, so only reading them is a read
  // A key, a token or a password in its settings is printed by `get` of it, and by a listing; an option after the
  // subcommand (yarn's `--no-redacted`) is not read here.
  if (sub === "config") {
    const after = words.slice(at + 1);
    if (rest[0] !== "get" || after.some((w) => w.startsWith("-")) || rest.slice(1).some((w) => /auth|token|passw|secret|cert|key/i.test(w))) return thisMac();
    return v("read", say("kit.say.read"));
  }
  if (["ls", "list", "why", "outdated", "view", "info", "show", "root", "bin", "help", "doctor", "explain", "licenses", "--version", "-v"].includes(sub)) {
    // asking a registry the agent named, or about a package by its address, reaches that computer
    if (has(words, "--registry") || words.some((w) => /^--@[^=\s]*:registry/.test(w)) || rest.some((w) => PKG_ADDRESS.test(w))) return sends();
    return v("read", say("kit.say.read"));
  }
  if (["create", "init", "link"].includes(sub)) return unknownProgram(pm);
  if (pm === "bun" && /[./]/.test(sub)) return unknownProgram(pm);
  if (pm === "npm" && !["start", "stop", "restart"].includes(sub)) return unknownProgram(pm);
  // pnpm, yarn and bun run a tool of the project's by its name when no script has that name
  const asTool = classify(words.slice(at), where);
  if (!(asTool.action === "unknown" && asTool.say.key === "kit.say.unknown")) return at$(asTool, at);
  return handed(head, script(sub, head));
}

/** The main branch's usual names: a push to one goes live. */
const MAIN = new Set(["main", "master", "trunk", "production", "prod", "release", "live", "stable", "gh-pages"]);
/** Names git reads as the branch checked out: HEAD, `@`, and `head` in any letter case, which a disk that ignores letter case
 *  (macOS's) finds as HEAD (item 120; tried with git 2.54). */
const HEAD_NAME = /^(head|@)$/i;
/** git's options before its subcommand that change nothing about what it runs: anything else (`-c`, `--exec-path`,
 *  `--git-dir`, …) can make a read run a program, or read another repository, so it is not read in advance. */
const GIT_GLOBAL_SAFE = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);
/** Options of git's subcommands that run a program, or take one from where nobody looked. git takes any start of a
 *  long option's name, so each is matched by its start too (`--upload-pa` is `--upload-pack`). */
const GIT_RUNS = ["--upload-pack", "--receive-pack", "--exec", "--template", "--open-files-in-pager", "--config"];
/** git grep's short options that take a value: in a bundle, what follows one is its value. */
const GIT_GREP_VALUES = "efABCm";

/** A repository named by its address rather than by a remote's name: a link, `host:path`, `user@host:path`, or a
 *  transport (`ext::…`). A fetch from or a push to one reaches a computer the agent chose, and its address alone can carry
 *  anything out. A Windows path (`C:\…`) is a path. */
const gitAddress = (w: string) => URL_LIKE.test(w) || SCP_LIKE.test(w) || w.includes("::") || (/^[^/\\\s:]+:/.test(w) && !WIN_ABS.test(w));

/** git fetch's options that only choose what to fetch and how to say it, and those of them that take a value. Any other
 *  (`--upload-pack`, `--stdin`, `--set-upstream`, `--refmap`, `--force`, `--update-head-ok`, `--server-option`) runs a
 *  program, writes the settings, reads words nobody has read or moves a local branch, so a fetch with one is not read in
 *  advance. git would take a start of each name: only the whole name is read here, and anything else asks. */
const FETCH_FLAGS = new Set([
  "--all", "--prune", "-p", "--prune-tags", "-P", "--tags", "-t", "--no-tags", "-n", "--quiet", "-q", "--verbose", "-v", "--progress",
  "--no-progress", "--dry-run", "--multiple", "--unshallow", "--update-shallow", "--atomic", "--keep", "-k", "--ipv4", "-4", "--ipv6", "-6",
  "--porcelain", "--show-forced-updates", "--no-show-forced-updates", "--write-fetch-head", "--no-write-fetch-head", "--recurse-submodules",
  "--no-recurse-submodules", "--auto-maintenance", "--no-auto-maintenance", "--auto-gc", "--no-auto-gc", "--write-commit-graph",
  "--no-write-commit-graph", "--append", "-a", "--refetch", "--prefetch",
]);
const FETCH_VALUES = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs", "-j", "--filter", "--negotiation-tip", "--recurse-submodules"]);

/** A git fetch: a read of the project's own remote, or of none named. */
function fetch(words: string[], head: number): Verdict {
  const repos: string[] = [];
  const refspecs: string[] = [];
  let multiple = false;
  for (let i = head; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      words.slice(i + 1).forEach((x) => (repos.length || multiple ? refspecs : repos).push(x));
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      const name = w.split("=")[0];
      if (w === "--multiple") multiple = true;
      if (FETCH_FLAGS.has(w)) continue;
      if (FETCH_VALUES.has(name)) {
        if (!w.includes("=") && !["--recurse-submodules"].includes(w) && takesWord(words[i + 1])) i++;
        continue;
      }
      // bundled short flags (`-pq`) and a job count joined to its option (`-j4`)
      if (/^-[pPtnqvka46]+$/.test(w) || /^-j[0-9]+$/.test(w)) continue;
      return unknownProgram("git");
    }
    (repos.length && !multiple ? refspecs : repos).push(w);
  }
  if (repos.some(gitAddress)) return sends();
  // a refspec with a place to put it updates a local branch: with `+`, whatever that branch held
  if (refspecs.some((r) => r.startsWith("+"))) return v("delete", say("kit.say.discard"), "exact");
  if (refspecs.some((r) => r.includes(":"))) return v("change", say("kit.say.change"), "exact");
  return v("read", say("kit.say.fetch"));
}

/** git branch's and git tag's options that only list, those of them that take a value, and those that take what follows
 *  as a pattern or a commit to list by. Any other option makes, moves, copies or forces one. */
const LIST_FLAGS: Record<"branch" | "tag", ReadonlySet<string>> = {
  branch: new Set(["-a", "--all", "-r", "--remotes", "--list", "-l", "-v", "-vv", "--verbose", "--show-current", "--column", "--no-column", "--color", "--no-color", "-i", "--ignore-case", "--no-abbrev", "-q", "--quiet", "--omit-empty"]),
  tag: new Set(["-l", "--list", "-n", "--column", "--no-column", "--color", "--no-color", "-i", "--ignore-case", "--omit-empty"]),
};
const LIST_VALUES = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--abbrev"]);
const LIST_BY = ["--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];

/** Whether a git branch or git tag only lists: each option is one that lists, and a name it is given is a pattern. */
function onlyLists(args: string[], kind: "branch" | "tag"): boolean {
  let operands = 0;
  let by = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const name = w.split("=")[0];
    if (!w.startsWith("-") || w === "-") {
      operands++;
      continue;
    }
    if (LIST_BY.includes(name)) by = true;
    if (LIST_FLAGS[kind].has(w) || (kind === "tag" && /^-n[0-9]+$/.test(w))) continue;
    if (LIST_VALUES.has(name)) {
      // the commit after `--contains` is optional and is taken as a pattern either way
      if (!w.includes("=") && ["--sort", "--format"].includes(w) && takesWord(args[i + 1])) i++;
      continue;
    }
    return false;
  }
  return !operands || by;
}

/** git config's options that read a setting and change nothing, and those of them that take a value. */
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--local", "--worktree", "--show-origin", "--show-scope", "--name-only", "-z", "--null", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date", "--includes", "--no-includes", "--fixed-value", "--all"]);
const CONFIG_VALUES = new Set(["--type", "--default", "--file", "-f", "--blob", "--value", "--url", "--regexp"]);

/** Whether a git config only reads: every option is one that reads, and it asks for a setting (`--get`, a name alone, or
 *  git's own `get` and `list`). `--edit`, `--unset`, `--remove-section` and the like change the settings, which can name a
 *  program git runs later. */
function configReads(args: string[], rest: string[]): boolean {
  let asks = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.startsWith("-") || w === "-") continue;
    const name = w.split("=")[0];
    if (CONFIG_READS.has(w)) {
      if (w.startsWith("--get") || w === "--list" || w === "-l") asks = true;
      continue;
    }
    if (CONFIG_VALUES.has(name)) {
      if (!w.includes("=") && takesWord(args[i + 1])) i++;
      continue;
    }
    return false;
  }
  if (["get", "list"].includes(rest[0] ?? "")) return true;
  if (["set", "unset", "edit", "rename-section", "remove-section"].includes(rest[0] ?? "")) return false;
  return asks || rest.length === 1;
}

function git(words: string[], where: Where): Verdict {
  let at = 1;
  // `-C` moves git to another folder, each from the last: only the project's own is read (item 116). Any other may be a
  // folder of plain files that git takes for a repository, whose settings name a program it runs on a read.
  let dir: string | null = where.cwd || where.root;
  while (at < words.length && words[at].startsWith("-")) {
    if (words[at] === "-C") {
      dir = dir === null || words[at + 1] === undefined ? null : resolve(words[at + 1], dir, where.home);
      at += 2;
    } else if (GIT_GLOBAL_SAFE.has(words[at])) at++;
    else return unknownProgram("git");
  }
  if (at > 1 && words.slice(1, at).includes("-C") && (dir === null || !samePath(dir, where.root))) return unknownProgram("git");
  if (at >= words.length) return v("read", say("kit.say.read"));
  const ops = operands(words, at);
  const sub = words[at];
  const head = at + 1;
  const args = words.slice(head);
  const rest = ops.slice(1).map((i) => words[i]);
  if (has(args, ...GIT_RUNS)) return unknownProgram("git");
  if (["fetch", "clone", "ls-remote", "pull"].includes(sub) && has(args, "-u", "-c")) return unknownProgram("git");
  if (sub === "grep" && hasIn(GIT_GREP_VALUES, args, "-O")) return unknownProgram("git");
  if (sub === "rebase" && has(args, "-x")) return unknownProgram("git");
  // a step that fetches from, or sends to, an address the agent wrote rather than a remote the project has
  if ((["pull", "clone"].includes(sub) && gitAddress(rest[0] ?? "")) || (sub === "submodule" && rest.slice(1).some(gitAddress))) return sends();
  // where a remote points is a setting: it decides what a later fetch reads and where a push sends
  if (sub === "remote" && ["add", "set-url"].includes(rest[0] ?? "")) return unknownProgram("git");
  // a file it writes its output to: a change, and the path is checked as any other. Every command that shows a diff or a
  // log takes `--output` (`git stash show`, `git reflog show`), so it is looked for in all of them.
  if (has(args, "--output") || (["format-patch", "archive"].includes(sub) && has(args, "-o"))) return v("change", say("kit.say.change"), head);
  const history = () => v("read", say("kit.say.history"));
  const change = () => v("change", say("kit.say.change"), head);
  const del = (s: Say = say("kit.say.delete")) => v("delete", s, "exact");
  // what may switch, rename or detach the branch checked out, or set where it is pushed (item 120)
  const moving = (r: Verdict): Verdict => ({ ...r, moves: true });
  // A branch's upstream is a setting: with the person's `push.default=upstream` a later push that names no branch sends to
  // it, main among them (item 120), as where a remote points decides where every push sends.
  if (["branch", "switch", "checkout"].includes(sub) && has(args, "--track", "-t", ...(sub === "branch" ? ["-u", "--set-upstream-to"] : []))) return { ...unknownProgram("git"), moves: true };
  switch (sub) {
    case "status":
    case "diff":
    case "log":
    case "show":
    case "blame":
    case "rev-parse":
    case "ls-files":
    case "ls-tree":
    case "describe":
    case "shortlog":
    case "cat-file":
    case "whatchanged":
    case "help":
    case "version":
    case "merge-base":
    case "name-rev":
    case "check-ignore":
    case "count-objects":
      return history();
    case "var":
      // `-l` lists every setting from every scope, as `git config --list` does
      return has(args, "-l") ? thisMac() : history();
    case "grep":
      // with `-f` the patterns come from a file, which is checked as any path is, and only the words after `-e` are patterns
      if (hasIn(GIT_GREP_VALUES, args, "-f")) return { ...history(), text: textAfter(words, ["-e"]) };
      return { ...history(), text: new Set(ops.slice(1, 2)) };
    case "fetch":
      return fetch(words, head);
    case "archive":
      return has(args, "--remote") ? unknownProgram("git") : history();
    case "bisect":
      return rest[0] === "run" ? unknownProgram("git") : moving(change());
    case "reflog":
      return has(args, "expire", "delete") ? del() : history();
    case "commit":
      // the file a message or a template is read from (`-F`, `--file`, `-t`) is a path like any other: a key read into a
      // message would leave with the next push
      return v("change", say("kit.say.commit"), head, { saves: true, text: textAfter(words, ["-m", "--message", "--author", "--date", "-C", "-c", "--fixup", "--squash"]) });
    case "switch":
      if (has(args, "--force", "-f", "--discard-changes")) return moving(del(say("kit.say.discard")));
      return moving({ ...change(), text: textAfter(words, ["-c", "--create", "-C", "--force-create"]) });
    case "add":
    case "mv":
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "pull":
    case "init":
    case "notes":
    case "clone": {
      const r = { ...change(), text: textAfter(words, ["-m", "--message", "-b", "--branch", "-c", "--config", "--origin", "-o"]) };
      // a rebase leaves the branch detached while it stops, and a clone or an init makes another repository to work in
      return ["rebase", "init", "clone"].includes(sub) ? moving(r) : r;
    }
    case "checkout": {
      if (has(args, "--force", "-f")) return moving(del(say("kit.say.discard")));
      if (hasExactly(args, "-b", "-B", "--orphan")) return moving(change());
      const discards = args.includes("--") || rest.some((w) => w === "." || /\.[^./\\]+$/.test(w.split(/[\\/]/).pop() ?? ""));
      return moving(discards ? del(say("kit.say.discard")) : change());
    }
    case "restore":
      return hasExactly(args, "--staged", "-S") && !has(args, "--worktree", "-W") ? change() : del(say("kit.say.discard"));
    case "reset":
      return has(args, "--hard", "--keep", "--merge") ? del(say("kit.say.discard")) : change();
    case "clean":
      // `-x` and `-X` take the files git ignores too: the agents' local settings, keys, what the developer keeps out of git
      if (hasExactly(args, "-n", "--dry-run")) return history();
      return has(args, "-x", "-X") ? unknownProgram("git") : del();
    case "rm":
      return hasExactly(args, "--cached") ? change() : del();
    case "gc":
    case "prune":
    case "filter-branch":
    case "filter-repo":
      return del();
    case "update-ref":
      return moving(has(args, "-d") ? del() : change());
    case "branch":
      if (has(args, "-d", "-D", "--delete")) return del();
      // a branch made, moved, renamed or given another upstream: a rename of the one checked out is what HEAD then names
      return onlyLists(args, "branch") ? history() : moving(change());
    case "tag":
      if (has(args, "-d", "--delete")) return del();
      return onlyLists(args, "tag") ? history() : { ...change(), text: textAfter(words, ["-m", "--message"]) };
    case "stash": {
      // git takes a stash's subcommand only as the word right after `stash`: with an option first it is a push, and the
      // word after `-m` is its message (`git stash -m list` stashes the changes away)
      const act = words[head] ?? "";
      if (["drop", "clear"].includes(act)) return del();
      if (["list", "show"].includes(act)) return history();
      // `stash branch` makes a branch and checks it out
      const r = { ...change(), text: textAfter(words, ["-m", "--message"]) };
      return act === "branch" ? moving(r) : r;
    }
    case "worktree":
      if (["remove", "prune"].includes(rest[0] ?? "")) return moving(del());
      return rest[0] === "list" ? history() : moving(change());
    case "submodule":
      if (rest[0] === "foreach") return unknownProgram("git");
      return rest[0] === "status" || !rest.length ? history() : moving(change());
    case "remote":
      if (["remove", "rm"].includes(rest[0] ?? "")) return del();
      return !rest.length || ["show", "get-url"].includes(rest[0] ?? "") ? history() : change();
    case "config": {
      if (has(args, "--global", "--system")) return thisMac();
      // Every setting, or a pattern of them, or one whose name says it holds a key, read from every scope but the
      // project's own: the person's own settings can hold a token (in a link, a header, a helper's setting).
      const scoped = args.some((w) => ["--local", "--worktree", "-f", "--blob"].includes(w) || isOpt(w, "--file") || isOpt(w, "--blob"));
      const lists = args.some((w) => ["--list", "-l", "--get-regexp", "--get-urlmatch"].includes(w)) || ["list", "get-regexp"].includes(rest[0] ?? "");
      if (!scoped && (lists || rest.some((w) => /token|passw|secret|auth|credential|cookie|private|extraheader/i.test(w)))) return thisMac();
      // a setting can name a program git runs later (an alias, a pager, a hook folder), so changing one is never a safe step
      return configReads(args, rest) ? history() : unknownProgram("git");
    }
    case "push":
      return push(words, head, where);
    default:
      return unknownProgram("git");
  }
}

function push(words: string[], head: number, where: Where): Verdict {
  const args = words.slice(head);
  const ops = operands(words, head, new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]));
  // where it sends: the remote it names, or one given by `--repo`; an address the agent wrote is no remote of the project's
  const repo = [words[ops[0]] ?? "", ...args.filter((w) => isOpt(w, "--repo") && w.includes("=")).map((w) => w.slice(w.indexOf("=") + 1)), ...args.flatMap((w, i) => (w === "--repo" ? [args[i + 1] ?? ""] : []))];
  if (repo.some(gitAddress)) return { ...sends(), saves: true };
  // From another folder than the one whose branch was read, it may be another repository's push: a folder of the project
  // can hold a repository of its own, with a remote of its own (item 120).
  if (!samePath(where.cwd || where.root, where.root)) return { ...live(), saves: true };
  const refs = ops.slice(1).map((i) => words[i]);
  const branch = where.branch ?? "";
  /** The branch a refspec sends to, from its own words (item 120): its destination, else its source; the branch checked out
   *  for HEAD, `@` and `head` in any letter case (macOS's disk finds that as HEAD); "" when it cannot be said. `:` alone
   *  pushes every branch both sides have and a pattern every branch it matches. git finds a destination on the remote by
   *  its end too (`heads/main` is refs/heads/main), so only a branch's own name is read as one: any other namespace
   *  (`refs/remotes/`, `refs/for/`, `refs/tags/`) is not known. */
  const target = (ref: string) => {
    const r = ref.replace(/^\+/, "");
    if (r === ":" || r.includes("*")) return "";
    const colon = r.indexOf(":");
    const dst = colon >= 0 ? r.slice(colon + 1) : r;
    if (dst === "") return "";
    const name = HEAD_NAME.test(dst) ? branch : dst;
    if (name.startsWith("refs/")) return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : "";
    return name.replace(/^heads\//, "");
  };
  // a push that names no branch sends the one checked out: live when that is the main branch, or not known
  const names = refs.length ? refs.map(target) : [branch];
  // every branch (`--all` and its alias `--branches`), every tag, a mirror, remote branches removed, the submodules'
  // commits pushed to their own remotes, or an option for the server, which GitLab reads to merge a request as its
  // pipeline passes
  const submodules = args.some((w) => isOpt(w, "--recurse-submodules") && !/^--[^=]*=(check|no)$/.test(w));
  if (has(args, "--tags", "--follow-tags", "--mirror", "--all", "--branches", "--prune", "-o", "--push-option") || submodules || names.some((n) => !n || MAIN.has(n)))
    return { ...live(), saves: true };
  if (has(args, "--delete", "-d") || refs.some((r) => r.startsWith(":"))) return v("delete", say("kit.say.delete"), "exact", { saves: true });
  if (has(args, "--force", "-f", "--force-with-lease", "--force-if-includes") || refs.some((r) => r.startsWith("+"))) return v("delete", say("kit.say.discard"), "exact", { saves: true });
  return v("push", say("kit.say.push"), head, { saves: true });
}

/** The words that are an option's value from `opts`: a message, a name, a pattern. */
function textAfter(words: string[], opts: string[]): Set<number> {
  const out = new Set<number>();
  words.forEach((w, i) => {
    if (opts.includes(w) && i + 1 < words.length) out.add(i + 1);
  });
  return out;
}

/** A link gh would follow to a host other than GitHub's own, or a repository named with its host (`-R host/owner/repo`):
 *  gh then talks to that host, and the words it sends there can carry anything out. */
const ghElsewhere = (words: string[]) =>
  words.some((w, i) => {
    if (URL_LIKE.test(w) && !/^https?:\/\/(www\.)?github\.com(\/|$)/i.test(w)) return true;
    const repo = isOpt(w, "--repo") && w.includes("=") ? w.slice(w.indexOf("=") + 1) : w === "-R" || w === "--repo" ? (words[i + 1] ?? "") : /^-R./.test(w) ? w.slice(2) : null;
    return repo !== null && (URL_LIKE.test(repo) || repo.split("/").length > 2);
  });

function gh(words: string[], where: Where): Verdict {
  const [, area, act] = words;
  const head = 3;
  // `gh api` is a web client: what it asks GitHub, or the host `--hostname` names, is up to the words
  if (area === "api" || has(words, "--hostname") || ghElsewhere(words)) return sends();
  // `--web` opens the person's browser on the page
  if (has(words, "--web", "-w")) return unknownProgram("gh");
  const text = textAfter(words, ["-t", "--title", "-b", "--body", "-m", "--message", "--subject", "-q", "--jq", "--template"]);
  const reads = ["list", "view", "status", "checks", "diff"];
  switch (area) {
    case "pr":
      if (act === "create") {
        // a request on a repository the words name, or one opened from another folder than the session's, which may be
        // another repository (item 120)
        if (words.some((w) => w === "-R" || /^-R./.test(w) || isOpt(w, "--repo"))) return { ...sends(), saves: true };
        if (!samePath(where.cwd || where.root, where.root)) return { ...live(), saves: true };
        return v("push", say("kit.say.pr"), head, { saves: true, text });
      }
      if (act === "merge") return live();
      // it checks out the request's branch (item 120)
      if (act === "checkout") return v("change", say("kit.say.change"), head, { moves: true });
      return reads.includes(act ?? "") ? v("read", say("kit.say.history")) : sends();
    case "repo":
      if (act === "clone") return v("change", say("kit.say.change"), head, { moves: true });
      return ["view", "list"].includes(act ?? "") ? v("read", say("kit.say.history")) : sends();
    case "release":
      return ["list", "view"].includes(act ?? "") ? v("read", say("kit.say.history")) : live();
    case "workflow":
      return ["list", "view"].includes(act ?? "") ? v("read", say("kit.say.history")) : live();
    case "run":
    case "issue":
    case "search":
      return reads.includes(act ?? "") || area === "search" ? v("read", say("kit.say.history"), undefined, { text }) : sends();
    case "status":
      return v("read", say("kit.say.history"));
    default:
      return unknownProgram("gh");
  }
}

const SEARCH_VALUE: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--label", "--binary-files"]),
  rg: new Set(["-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-j", "-M", "-r", "-E", "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--replace", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--max-depth", "--maxdepth", "--sort", "--sortr", "--encoding", "--pre", "--pre-glob", "--ignore-file", "--type-add", "--type-clear"]),
};

/** Their short options that take a value: in a bundle, what follows one of them is its value. */
const SEARCH_SHORT_VALUES: Record<"grep" | "rg", string> = { grep: "efmABCdD", rg: "efgtTABCmjMrE" };
/** Their options whose value is text (a pattern, a glob, a type), joined to it or not. */
const SEARCH_TEXT_SHORT: Record<"grep" | "rg", string> = { grep: "e", rg: "egtTr" };

/** grep, rg and the like: the first word that is not an option is the pattern, unless one came with `-e` or `-f`. A
 *  preprocessor (`rg --pre`) or the program that names the computer (`--hostname-bin`) runs a program on every file or at
 *  the start, and ag's pager does at the end, so a search with one is not a read. */
function search(words: string[], kind: "grep" | "rg"): Verdict {
  if (kind === "rg" && has(words, "--pre", "--pre-glob", "--hostname-bin", "--pager")) return unknownProgram(words[0]);
  const takes = SEARCH_VALUE[kind];
  const ops = operands(words, 1, takes);
  const text = new Set<number>();
  words.forEach((w, i) => {
    if (takes.has(w) && !["-f", "--file", "--ignore-file"].includes(w) && i + 1 < words.length) text.add(i + 1);
    // a pattern or a glob joined to its option (`-efoo`, `--glob=*.ts`) is text too
    else if (new RegExp(`^-[${SEARCH_TEXT_SHORT[kind]}].`).test(w) || /^--(regexp|glob|iglob|type|type-not|replace|type-add)=/.test(w)) text.add(i);
  });
  if (!hasIn(SEARCH_SHORT_VALUES[kind], words, "-e", "--regexp", "-f", "--file") && ops.length) text.add(ops[0]);
  return v("read", say("kit.say.read"), undefined, { text });
}

const READS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df", "ls", "tree", "pwd", "realpath", "readlink",
  "basename", "dirname", "diff", "cmp", "comm", "uniq", "cut", "tr", "nl", "od", "hexdump", "xxd", "strings", "column",
  "fold", "rev", "tac", "which", "type", "whereis", "true", "false", "test", "[", "date", "sleep", "whoami", "uname", "id",
  "hostname", "sw_vers", "fd", "fdfind", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "ps", "lsof", "uptime",
  "unset", "exit", "wait",
]);
const ONLY_TEXT = new Set(["echo", "printf", "unset"]);
/** Options of programs that otherwise read or change files, which make them run another program, and each program's short
 *  options that take a value (`isOpt`). */
const RUNS_PROGRAM: Record<string, { opts: string[]; values: string }> = {
  fd: { opts: ["-x", "--exec", "-X", "--exec-batch"], values: "etEdjSoc" },
  fdfind: { opts: ["-x", "--exec", "-X", "--exec-batch"], values: "etEdjSoc" },
  tar: { opts: ["--to-command", "--checkpoint-action", "-I", "--use-compress-program", "--info-script", "--new-volume-script", "-F"], values: "fCbTXKNLHV" },
  rsync: { opts: ["-e", "--rsh", "--rsync-path"], values: "fTMB" },
  sort: { opts: ["--compress-program"], values: "" },
  zip: { opts: ["-TT", "--unzip-command"], values: "" },
  curl: { opts: ["-K", "--config"], values: "" },
  date: { opts: ["-s", "--set"], values: "dfrIv" },
  // a key file binds keys to commands, and a `+` word is a command less runs as it starts
  less: { opts: ["-k", "--lesskey-file", "--lesskey-src", "--lesskey-content"], values: "bhjopPtTxyzO#" },
  more: { opts: ["-k", "--lesskey-file", "--lesskey-src", "--lesskey-content"], values: "bhjopPtTxyzO#" },
};
const CHANGES = new Set(["mkdir", "touch", "cp", "mv", "chmod", "install", "tar", "unzip", "zip", "gzip", "gunzip", "dos2unix", "truncate"]);
/** The options of uniq and xxd that take a value: what is left are the files it reads and writes (a second one is the file
 *  it writes). Each program has its own: taking `-c` for one that takes a value, as both once shared, swallowed uniq's
 *  input and hid the file it writes. An option left out here only counts one more file, which asks more, never less. */
const UNIQ_VALUES: ReadonlySet<string> = new Set(["-f", "-s", "-w"]);
const XXD_VALUES: ReadonlySet<string> = new Set(["-c", "-g", "-l", "-n", "-o", "-s"]);
/** Programs that write files the command does not name: a link (`ln`, `link`, `cp -s`) makes a later change to its path
 *  land where the link leads, and a patch names its own files inside. */
const WRITES_UNNAMED = new Set(["ln", "link", "patch"]);
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
const THIS_MAC = new Set(["brew", "port", "apt", "apt-get", "yum", "dnf", "pacman", "snap", "choco", "winget", "scoop", "softwareupdate", "defaults", "launchctl", "systemctl", "crontab", "mas", "sudo", "doas", "su", "chown", "nvm", "fnm", "volta", "asdf", "mise", "pyenv", "rbenv"]);
const SENDS = new Set(["ssh", "scp", "sftp", "nc", "ncat", "telnet", "ftp", "mosh"]);
const OPAQUE_PROGRAMS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "source", ".", "eval", "open", "xdg-open", "osascript", "kill", "pkill", "killall", "printenv", "env", "set", "alias", "unalias", "trap", "function"]);

/** Variables a command may be run with and still be read in advance. Any other (`PATH`, `NODE_OPTIONS`, `DYLD_*`,
 *  `GIT_*`, a pager) can make the same words run another program. */
const SAFE_VAR = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TZ|LANG|LANGUAGE|LC_[A-Z]+|DEBUG|PORT|TERM|COLUMNS|LINES|NODE_NO_WARNINGS|RUST_BACKTRACE|RUST_LOG)=/;

/** sed's own commands that only print or change lines on their way through: an address or two, then print, delete,
 *  quit and the like, a substitution whose flags write nothing and run nothing, or a transliteration. `e`, `w`, `r`
 *  and a substitution's `w` and `e` flags run a program or touch a file, so a script with one is not read in advance. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/I?)`;
const SED_SAFE = new RegExp(
  String.raw`^(?:${SED_ADDR}(?:,${SED_ADDR})?!?)?\s*(?:[pdqQnNPDgGhHxl=]|s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gpiImM0-9]*|y(.)(?:(?!\2)[^\\]|\\.)*\2(?:(?!\2)[^\\]|\\.)*\2)$`,
);
const sedSafe = (script: string) => script.split(/[;\n]/).every((c) => SED_SAFE.test(c.trim()) || c.trim() === "");
/** sed's options that print, read and match differently and nothing more. */
const SED_FLAGS = new Set(["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended", "-s", "--separate", "-u", "--unbuffered", "-z", "--null-data", "--posix", "--sandbox", "--debug"]);
/** A path in git's own folder, which holds its settings and hooks; a disk that ignores letter case finds `.GIT` there too. */
export const IN_GIT_DIR = /(^|[\\/])\.git([\\/]|$)/i;
const RUNTIMES = new Set(["node", "deno", "ts-node", "tsx", "ruby", "perl", "php", "java", "lua", "Rscript", "swift"]);

/** Checks that only report, and tools that report unless told to fix. */
const CHECKERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test", "mypy", "pyright", "flake8", "pylint", "shellcheck", "hadolint", "actionlint", "knip", "depcheck", "cspell", "stylelint", "markdownlint", "eslint", "biome", "ruff", "black", "isort", "prettier", "tsc", "vue-tsc", "playwright", "cypress"]);
const FIXES = ["--fix", "--write", "-w", "--apply", "--apply-unsafe", "-u", "--update", "--updateSnapshot", "--update-snapshots"];
/** make's, just's and task's own options that choose how many recipes run at once and how much they say, those of them
 *  that take a value, and the short ones written joined or bundled. */
const RUNNER_FLAGS: Record<string, ReadonlySet<string>> = {
  make: new Set(["-k", "--keep-going", "-s", "--silent", "--quiet", "-w", "--print-directory", "--no-print-directory", "-B", "--always-make", "-n", "--dry-run", "--just-print", "-q", "--question", "-r", "--no-builtin-rules", "-R", "--no-builtin-variables", "--output-sync"]),
  just: new Set(["-q", "--quiet", "-v", "--verbose", "-n", "--dry-run", "--no-deps", "--timestamp"]),
  task: new Set(["-s", "--silent", "-v", "--verbose", "-p", "--parallel", "-f", "--force", "--dry"]),
};
const RUNNER_VALUES: Record<string, ReadonlySet<string>> = { make: new Set(["-C", "--directory", "-j", "--jobs", "-l", "--load-average"]), just: new Set(["--color"]), task: new Set(["--concurrency"]) };
const RUNNER_JOINED: Record<string, RegExp> = { make: /^-([ksBnqrRw]+|j[0-9]*|C.+|O[a-z]*|l[0-9.]*)$/, just: /^-[qvn]+$/, task: /^-[svpf]+$/ };
const FRAMEWORKS = new Set(["vite", "next", "nuxt", "astro", "remix", "webpack", "rollup", "esbuild", "tsup", "parcel", "turbo", "nx"]);

/** A check's options by their name written any way a runner takes it (`--outputFile`, `--output-file`, `-outputfile`):
 *  letter case, `-` and `_` taken out, and each part of a dotted one (`--coverage.reportsDirectory`) on its own. */
const CHECK_RUNS = new Set([
  "require", "import", "loader", "experimentalloader", "plugin", "plugins", "loadplugins", "inithook", "rulesdir", "setupfiles",
  "setupfilesafterenv", "globalsetup", "globalteardown", "testresultsprocessor", "testrunner", "transform", "resolver",
  "snapshotresolver", "testsequencer", "watchplugins", "exec", "toolexec", "vettool", "overlay", "shellcheck", "pyflakes",
  "customformatter", "customsyntax", "pre", "hostnamebin", "scriptshell", "nodeoptions", "rcfile", "resolvepluginsrelativeto",
  "ldflags", "gccgoflags", "asmflags", "modfile", "overrideini", "basetemp", "preload",
  // options a runner hands to node for its workers (mocha's `--node-option`, ava's `--node-arguments`, vitest's
  // `execArgv`), where `--import` and `--require` load a program as `NODE_OPTIONS` would
  "nodeoption", "nodearguments", "nodeargs", "execargv", "customprovidermodule",
  // a debugger on an address, which runs whatever anyone who reaches it sends (item 120): a backstop for every runner, and
  // for node's own names wherever a runner hands them on
  "inspect", "inspectbrk", "inspectport", "inspectwait", "debugport", "debugbrk",
]);
/** Long options only one runner reads this way (another runner's option of the same name is harmless): vitest's diff
 *  settings, pool and workspace name a module it loads, and its benchmark's JSON is a file it writes. */
const CHECK_LONG: Record<string, Record<string, "runs" | "writes" | "config" | "loads">> = {
  vitest: { diff: "loads", pool: "loads", workspace: "config", outputjson: "writes" },
  jest: { runner: "loads" },
  // words a package manager hands to a script nobody has read may reach either
  "": { diff: "loads", pool: "loads", outputjson: "writes", runner: "loads" },
};
const CHECK_SENDS = new Set(["pastebin"]);
/** Options that name what a runner loads: a name of its own (`--reporter=dot`) is fine, a file is a program. */
const CHECK_LOADS = new Set(["reporter", "reporters", "format", "formatter", "environment", "testenvironment", "ui", "preset", "rules", "sequencer"]);
/** Options that name a settings file, which for most runners is a program: one named as settings is the project's own. */
const CHECK_CONFIG = new Set(["config", "configfile", "configpath"]);
const CHECK_WRITES = new Set([
  "output", "outputfile", "outfile", "outdir", "outputdir", "junitxml", "junit", "html", "resultlog", "reportlog", "coverprofile",
  "cpuprofile", "memprofile", "blockprofile", "mutexprofile", "trace", "generatetrace", "generatecpuprofile", "tsbuildinfofile",
  "cachelocation", "cachedir", "coveragedirectory", "reportsdirectory", "targetdir", "logfile", "update", "updatesnapshot",
  "updatesnapshots", "write", "fix", "fuzz", "xunit", "dump",
]);
/** Each runner's short options that load a program, write, or name a settings file. */
const CHECK_SHORT: Record<string, Record<string, "runs" | "writes" | "config" | "loads">> = {
  vitest: { u: "writes", c: "config" },
  jest: { u: "writes", c: "config" },
  mocha: { r: "runs", R: "loads", u: "loads", n: "runs" },
  pytest: { p: "runs", o: "runs", c: "config" },
  "py.test": { p: "runs", o: "runs", c: "config" },
  eslint: { c: "config", f: "loads", o: "writes" },
  playwright: { c: "config", u: "writes" },
  cypress: { C: "config", c: "runs", r: "loads" },
  stylelint: { c: "config", o: "writes" },
  markdownlint: { c: "config", r: "runs", o: "writes" },
  cspell: { c: "config" },
  knip: { c: "config" },
  ruff: { o: "writes" },
  ava: { u: "writes" },
  go: { o: "writes", c: "writes" },
  "": { u: "writes", o: "writes" },
};
/** Runners that read `-name` as a long option, as Go's own flags do. */
const GO_FLAGS = new Set(["go", "actionlint"]);
const looksLikeSettings = (value: string) =>
  /(^|[._-])(config|workspace)([._-]|$)|rc(\.[a-z]+)?$|^\.[a-z0-9_-]*rc|^(pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|ruff\.toml|biome\.jsonc?|t?sconfig.*\.json|jsconfig.*\.json)$/i.test(value.split(/[\\/]/).pop() ?? "");
const namesAFile = (value: string) => /[\\/]/.test(value) || value.startsWith(".") || /\.(c|m)?[jt]sx?$|\.py$/i.test(value);

// ---- the options a check or a read may have (item 116) ------------------------------------------------------------
//
// Four reviews each found an option the deny-lists above did not know that makes a check or a read write a file, run a
// program the line names, open a debugger on an address, or fetch and install. So a check, and a read of the programs
// below, is now read from a list of the options each program is known to take harmlessly: any other option makes the
// line `unknown`, which asks. Each list was read from the program's own `--help` on the Mac that built it (vitest 3.2.7,
// tsc 5.9.3, playwright, pytest 9.0.2, mypy 1.19.1, ruff 0.15.8, pip 21.2.4, uv 0.11.6, cargo, shellcheck, actionlint) or,
// for one not installed there, from its own documentation (jest, eslint, prettier, mocha, pylint, go test, turbo). A
// program with no list here, or one whose documentation was not read, takes no option at all. An option that is only
// harmless for most values (`--reporter`, `--config`) is still checked by `checkOptions`, and every value is checked as a
// path is.

/** A program's options: `flags` take no value, `values` take one (joined by `=`, joined to a short one, or the next word),
 *  and `changes` make the step a change. A long one is written `--name`, compared without letter case, `-` and `_`, and
 *  taken back with `--no-name` when it is a flag; a short one is `-x`, bundled with others. `long1` reads `-name` as a
 *  long option, as Go's flags do. `optional` are the options of `values` whose value is optional, from the program's own
 *  help (item 120): the program takes one only joined to it, never the next word. No value option takes a next word that
 *  starts with `-`: a program whose value is optional reads that word as an option of its own, and one whose value is
 *  required takes it as the value or refuses to start, so reading it as an option only ever asks more. */
interface Known {
  flags?: string;
  values?: string;
  changes?: string;
  optional?: string;
  long1?: true;
}

const optKey = (w: string) => (w.startsWith("--") ? `--${w.slice(2).toLowerCase().replace(/[-_]/g, "")}` : w);
const setOf = (list = "", long1 = false) => new Set(list.split(/\s+/).filter(Boolean).map((w) => optKey(long1 && !w.startsWith("--") ? `-${w}` : w)));

const PIP_COMMON = "-h --help --isolated -v --verbose -q --quiet --no-input --no-cache-dir --disable-pip-version-check --no-color --no-python-version-warning";
const UV_COMMON = "-h --help -q --quiet -v --verbose -n --no-cache --color --offline --no-progress --no-config";
const VITEST =
  "-w --watch --silent --hideSkippedTests --coverage --isolate --globals --fileParallelism --passWithNoTests --logHeapUsage --allowOnly --expandSnapshotDiff --disableConsoleIntercept --typecheck --printConsoleTrace --includeTaskLocation --run --color --clearScreen -h --help -v --version";
const VITEST_VALUES = "-r --root -c --config -t --testNamePattern --dir --reporter --mode --workspace --pool --maxWorkers --minWorkers --environment --shard --changed --testTimeout --hookTimeout --bail --retry --exclude --project --slowTestThreshold --teardownTimeout --maxConcurrency";
/** vitest 3.2.7's `--help` writes these with `[value]`: cac over mri takes a next word for them only when it is no option. */
const VITEST_OPTIONAL = "--changed";
const TSC_FLAGS =
  "--noEmit --pretty --strict --skipLibCheck --skipDefaultLibCheck --listFiles --listFilesOnly --explainFiles --diagnostics --extendedDiagnostics --traceResolution --noErrorTruncation --showConfig --version --help --all " +
  "--allowJs --checkJs --resolveJsonModule --esModuleInterop --allowSyntheticDefaultImports --forceConsistentCasingInFileNames --isolatedModules --isolatedDeclarations --verbatimModuleSyntax --erasableSyntaxOnly " +
  "--allowUnreachableCode --allowUnusedLabels --alwaysStrict --exactOptionalPropertyTypes --noFallthroughCasesInSwitch --noImplicitAny --noImplicitOverride --noImplicitReturns --noImplicitThis " +
  "--noPropertyAccessFromIndexSignature --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --strictBindCallApply --strictBuiltinIteratorReturn --strictFunctionTypes --strictNullChecks " +
  "--strictPropertyInitialization --useUnknownInCatchVariables --noUncheckedSideEffectImports --experimentalDecorators --emitDecoratorMetadata --useDefineForClassFields --noLib --noResolve";
const TSC_VALUES = "-p --project --target --module --moduleResolution --lib --jsx --types --moduleDetection --locale";
const CARGO_CHECK =
  "--future-incompat-report -v --verbose -q --quiet -h --help --workspace --all --lib --bins --examples --tests --benches --all-targets --all-features --no-default-features -r --release --ignore-rust-version --locked --offline --frozen --keep-going";
const CARGO_VALUES = "--message-format --color -p --package --exclude --bin --example --test --bench -F --features -j --jobs --profile --target";
/** cargo's `--help` writes these with `[<NAME>]`: with none it lists the targets. */
const CARGO_OPTIONAL = "-p --package --bin --example --test --bench --target";

const KNOWN: Record<string, Known> = {
  vitest: { flags: VITEST, values: VITEST_VALUES, changes: "-u --update", optional: VITEST_OPTIONAL },
  "vitest list": { flags: `${VITEST} --filesOnly`, values: VITEST_VALUES, optional: VITEST_OPTIONAL },
  tsc: { flags: TSC_FLAGS, values: TSC_VALUES },
  "vue-tsc": { flags: TSC_FLAGS, values: TSC_VALUES },
  "playwright test": { flags: "--fail-on-flaky-tests --forbid-only --fully-parallel --headed --last-failed --list --no-deps --pass-with-no-tests --quiet --shuffle -x -h --help", values: "-c --config --browser -g --grep -G --grep-invert --global-timeout -j --workers --max-failures --project --repeat-each --reporter --retries --shard --timeout", changes: "-u --update-snapshots" },
  pytest: {
    flags: "--markers -x --exitfirst --strict-config --strict-markers --strict --fixtures --fixtures-per-test --runxfail --lf --last-failed --ff --failed-first --nf --new-first --sw --stepwise --sw-skip --cache-show -v --verbose --no-header --no-summary --no-fold-skipped --force-short-summary -q --quiet -l --showlocals --no-showlocals --xfail-tb --full-trace --collect-only --co --noconftest --keep-duplicates --collect-in-virtualenv --continue-on-collection-errors --doctest-modules --doctest-ignore-import-errors --doctest-continue-on-failure --setup-only --setup-show --setup-plan --disable-plugin-autoload --disable-warnings -s -V --version -h --help",
    values: "-k -m --maxfail --durations --durations-min --verbosity -r --tb --show-capture --color --code-highlight -W --ignore --ignore-glob --deselect --doctest-glob --import-mode --capture --assert --log-level --log-cli-level --log-format --log-date-format",
  },
  mypy: {
    flags:
      "-h --help -v --verbose -V --version --warn-unused-configs --no-namespace-packages --ignore-missing-imports --follow-untyped-imports --no-site-packages --no-silence-site-packages --disallow-any-expr --disallow-any-decorated --disallow-any-explicit --disallow-any-generics --disallow-any-unimported --disallow-subclassing-any --disallow-untyped-calls --disallow-untyped-defs --disallow-incomplete-defs --check-untyped-defs --disallow-untyped-decorators --implicit-optional --no-strict-optional --warn-redundant-casts --warn-unused-ignores --no-warn-no-return --warn-return-any --warn-unreachable --report-deprecated-as-note --allow-untyped-globals --allow-redefinition --allow-redefinition-new --no-implicit-reexport --strict-equality --strict-equality-for-none --strict-bytes --extra-checks --strict --show-error-context --show-column-numbers --show-error-end --hide-error-codes --show-error-code-links --pretty --no-color-output --no-error-summary --show-absolute-path --no-incremental --show-traceback --scripts-are-modules --explicit-package-bases --exclude-gitignore",
    values: "-O --follow-imports --python-version --platform --always-true --always-false --untyped-calls-exclude --deprecated-calls-exclude --disable-error-code --enable-error-code --exclude -m -p",
  },
  "ruff check": {
    flags: "--show-fixes --diff --ignore-noqa --preview --statistics --show-files --show-settings -h --help --respect-gitignore --force-exclude -n --no-cache -e --exit-zero --exit-non-zero-on-fix -v --verbose -q --quiet -s --silent --isolated",
    values: "--output-format --target-version --extension --select --ignore --extend-select --per-file-ignores --extend-per-file-ignores --fixable --unfixable --extend-fixable --exclude --extend-exclude --color",
    changes: "--fix --unsafe-fixes --fix-only --add-noqa",
  },
  "ruff format": { flags: "--check --diff --preview -h --help -n --no-cache --exit-non-zero-on-format --respect-gitignore --force-exclude -v --verbose -q --quiet -s --silent --isolated", values: "--extension --target-version --output-format --exclude --line-length --range --color" },
  "ruff version": {},
  jest: {
    flags: "--ci --clearMocks --collectTests --colors --coverage --collectCoverage --detectOpenHandles --errorOnDeprecated -e --expand --forceExit --help --injectGlobals --listTests --logHeapUsage --noStackTrace -o --onlyChanged -f --onlyFailures --passWithNoTests --randomize --resetMocks --restoreMocks -i --runInBand --runTestsByPath --showSeed --silent --testLocationInResults --useStderr --verbose -v --version --watch --watchAll --workerThreads",
    values: "-b --bail --changedSince --collectCoverageFrom --coverageProvider --maxConcurrency -w --maxWorkers --seed --selectProjects --shard --testMatch -t --testNamePattern --testPathIgnorePatterns --testPathPatterns --testTimeout",
    changes: "-u --updateSnapshot",
    // jest's CLI documentation writes `--bail[=<n>]`
    optional: "-b --bail",
  },
  mocha: {
    flags: "--allow-uncaught -A --async-only -b --bail --check-leaks --color -c --colors --delay --diff --dry-run --exit --fail-zero --forbid-only --forbid-pending --full-trace --inline-diffs -i --invert --list-interfaces --list-reporters -C --no-colors -p --parallel --posix-exit-codes --recursive --sort -S -h --help -V --version",
    values: "--global --globals -j --jobs --retries -s --slow -t --timeout --timeouts -u --ui --extension --ignore --exclude -f --fgrep -g --grep",
  },
  eslint: {
    flags: "--no-config-lookup --no-ignore --quiet --color --no-color --no-inline-config --report-unused-disable-directives --report-unused-inline-configs --cache --no-error-on-unmatched-pattern --exit-on-fatal-error --no-warn-ignored --pass-on-no-patterns --debug -h --help -v --version --stats --fix-dry-run",
    values: "--ext --global --rule --ignore-pattern --max-warnings -f --format --report-unused-disable-directives-severity --cache-strategy --fix-type --concurrency",
    changes: "--fix",
  },
  prettier: { flags: "--check -c --list-different -l --no-config --no-editorconfig --with-node-modules --ignore-unknown -u --no-error-on-unmatched-pattern --cache --debug-check", values: "--ignore-path --config-precedence --log-level --find-config-path", changes: "--write -w" },
  pylint: { flags: "-h --help --version --list-msgs --list-msgs-enabled", values: "--disable -d --enable -j --ignore --msg-template --recursive --source-roots" },
  black: { flags: "--check --diff -q --quiet" },
  isort: { flags: "--check --check-only -c --diff -q --quiet" },
  // documentation not read for these: they take no option, and any asks
  ava: {}, tap: {}, pyright: {}, flake8: {}, knip: {}, depcheck: {}, cspell: {}, stylelint: {}, markdownlint: {}, hadolint: {}, cypress: {}, "cypress run": {},
  "biome check": {}, "biome lint": {}, "biome format": {}, "biome ci": {}, shellcheck: { flags: "-a --check-sourced -C --color --list-optional --norc -V --version --help", values: "-i --include -e --exclude --extended-analysis -f --format -o --enable -s --shell -S --severity -W --wiki-link-count" },
  actionlint: { long1: true, flags: "-color -no-color -oneline -verbose -version -debug", values: "-ignore -format" },
  "go test": { long1: true, flags: "-json -cover -failfast -fullpath -short -v -benchmem", values: "-bench -benchtime -count -covermode -coverpkg -cpu -list -parallel -run -shuffle -skip -timeout -vet" },
  "go vet": { long1: true },
  "cargo test": { flags: `${CARGO_CHECK} --no-run --no-fail-fast --doc`, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo check": { flags: CARGO_CHECK, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo bench": { flags: CARGO_CHECK, values: CARGO_VALUES, optional: CARGO_OPTIONAL },
  "cargo clippy": { flags: `${CARGO_CHECK} --no-deps`, values: CARGO_VALUES, changes: "--fix", optional: CARGO_OPTIONAL },
  "pip list": { flags: `${PIP_COMMON} -o --outdated -u --uptodate -e --editable -l --local --user --pre --not-required --exclude-editable --include-editable --no-index`, values: "--format --exclude" },
  "pip show": { flags: `${PIP_COMMON} -f --files` },
  "pip freeze": { flags: `${PIP_COMMON} -l --local --user --all --exclude-editable`, values: "--exclude" },
  "pip check": { flags: PIP_COMMON },
  "uv pip list": { flags: `${UV_COMMON} -e --editable --exclude-editable --outdated --strict`, values: "--exclude --format" },
  "uv pip show": { flags: UV_COMMON },
  "uv pip freeze": { flags: UV_COMMON },
  "uv pip tree": { flags: UV_COMMON },
  "uv pip check": { flags: UV_COMMON },
  // the words a package manager hands to a script nobody has read: options harmless in every runner a test script is
  // likely to run (vitest, jest, mocha, playwright, bun's own), and the ones that update snapshots
  "": { flags: "--run --coverage --silent --verbose --passWithNoTests --runInBand", values: "-t --testNamePattern --reporter --pool --project --shard --testTimeout --maxWorkers --environment --config --mode", changes: "-u --update --updateSnapshot" },
  // turbo hands the words after `--` to the task, read as a script's are
  turbo: { values: "--filter -F" },
};

/** What a program's own options make of a check or a read, by its list in `KNOWN`: null when each is one it takes
 *  harmlessly, `change` when one changes files, `unknown` for any other (a program with no list knows none). With
 *  `handed`, words after `--` are read too, as the options of whatever the script runs. */
function knownOptions(key: string, args: readonly string[], handed = false): "change" | "unknown" | null {
  const k = KNOWN[key] ?? {};
  const flags = setOf(k.flags, k.long1);
  const values = setOf(k.values, k.long1);
  const changes = setOf(k.changes, k.long1);
  const optional = setOf(k.optional, k.long1);
  /** Whether the word after a value option at `i` is its value (item 120): never one that starts with `-`, and never for one
   *  whose value is optional. */
  const takesNext = (i: number, n: string) => !optional.has(n) && takesWord(args[i + 1]);
  let change = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") {
      if (handed) continue;
      break;
    }
    if (!w.startsWith("-") || w === "-") continue;
    if (w.startsWith("--") || k.long1) {
      const n = optKey(`--${w.replace(/^--?/, "").split("=")[0]}`);
      if (flags.has(n) || (n.startsWith("--no") && flags.has(`--${n.slice(4)}`))) continue;
      if (values.has(n) || optional.has(n)) {
        if (!w.includes("=") && takesNext(i, n)) i++;
        continue;
      }
      if (changes.has(n)) {
        change = true;
        continue;
      }
      return "unknown";
    }
    for (let j = 1; j < w.length; j++) {
      const c = `-${w[j]}`;
      if (flags.has(c)) continue;
      if (changes.has(c)) {
        change = true;
        continue;
      }
      if (values.has(c) || optional.has(c)) {
        if (j === w.length - 1 && takesNext(i, c)) i++;
        break;
      }
      return "unknown";
    }
  }
  return change ? "change" : null;
}

/** Whether `next`, the word after an option that takes a value, is read as that value by an allow-list (item 120): never a
 *  word that starts with `-` (but `-` alone, which names the input), so a program whose value is optional cannot hide its
 *  next option there. A program whose value is required takes the word or refuses to start: reading it as an option only
 *  asks more. */
const takesWord = (next: string | undefined) => next !== undefined && (next === "-" || !next.startsWith("-"));

/** What a check's own options make of it, or null when they leave it a check: an option that loads a program, a settings
 *  file that is not one, a file it writes, or a service it sends to. `runner` names the runner (`""` when the words go to a
 *  script nobody has read, as `pnpm test --…` does), for its short options. */
function checkOptions(runner: string, args: readonly string[]): Verdict | null {
  const short = CHECK_SHORT[runner] ?? {};
  const go = GO_FLAGS.has(runner);
  let found: Verdict | null = null;
  const take = (r: Verdict) => {
    if (!found || RANK[r.action] > RANK[found.action]) found = r;
  };
  const kind = (k: "runs" | "writes" | "config" | "loads", value: string | undefined) => {
    if (k === "runs") take(unknownProgram(runner || "test"));
    else if (k === "writes") take(v("change", say("kit.say.change")));
    else if (k === "config" && (value === undefined || !looksLikeSettings(value))) take(unknownProgram(runner || "test"));
    else if (k === "loads" && (value === undefined || namesAFile(value))) take(unknownProgram(runner || "test"));
  };
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.startsWith("-") || w === "-" || w === "--") continue;
    const eq = w.indexOf("=");
    const value = eq >= 0 ? w.slice(eq + 1) : args[i + 1];
    if (w.startsWith("--") || go) {
      const parts = w.slice(0, eq >= 0 ? eq : undefined).replace(/^-+/, "").toLowerCase().replace(/[-_]/g, "").split(".");
      for (const n of parts) {
        if (CHECK_SENDS.has(n)) take(sends());
        if (CHECK_RUNS.has(n)) kind("runs", value);
        if (CHECK_WRITES.has(n)) kind("writes", value);
        if (CHECK_CONFIG.has(n)) kind("config", value);
        if (CHECK_LOADS.has(n)) kind("loads", value);
        const own = CHECK_LONG[runner]?.[n];
        if (own) kind(own, value);
        if (go && short[n]) kind(short[n], value);
      }
      continue;
    }
    // short options, alone, bundled or with their value joined: the first that names one of the runner's own ends the word
    for (let j = 1; j < w.length; j++) {
      const k = short[w[j]];
      if (!k) continue;
      kind(k, j + 1 < w.length ? w.slice(j + 1) : args[i + 1]);
      break;
    }
  }
  return found;
}

/** npx's (and npm exec's) own options that only answer its question about fetching the tool, or say less. npm reads any
 *  other option before the tool as one of its settings: `--node-options` loads a program into the tool, `--registry`
 *  fetches the tool from another computer, `--userconfig` and `--script-shell` change what runs. */
const NPX_FLAGS: ReadonlySet<string> = new Set(["-y", "--yes", "--no", "-q", "--quiet", "-s", "--silent"]);

/** A tool run by name, through npx or a package manager's exec as much as directly. Its runner's own options come before
 *  the tool, and only those in `flags` are read: any other (`--env-file`, `--shell-mode`, a setting) is not read in
 *  advance. One that names the package to fetch (`-p`, `--package`, `-c`) runs what that package holds, not the
 *  project's own tool of that name. */
function tool(words: string[], where: Where, flags: ReadonlySet<string> = new Set()): Verdict {
  let i = 0;
  for (; i < words.length && words[i].startsWith("-"); i++) {
    if (words[i] === "--") {
      i++;
      break;
    }
    if (!flags.has(words[i])) return v("unknown", say("kit.say.opaque"));
  }
  if (words.slice(i).some((w) => ["-p", "--package", "-c", "--call"].includes(w) || w.startsWith("--package=") || w.startsWith("--call="))) return v("unknown", say("kit.say.opaque"));
  return i < words.length ? at$(classify(words.slice(i), where), i) : v("unknown", say("kit.say.opaque"));
}

/** tsc's options that write a file, by name in lower case: tsc takes either letter case, and one dash or two. */
const TSC_WRITES = new Set(["outdir", "outfile", "out", "declarationdir", "tsbuildinfofile", "generatetrace", "generatecpuprofile", "build", "b", "init", "watch", "w"]);

/** The subcommands each checker is read with as a check (item 116): any other (`vitest init`, `ruff clean`, `biome
 *  init`) is not one. A runner with none here takes filters and files after its options. */
const CHECK_SUBS: Record<string, readonly string[]> = {
  ruff: ["check", "format", "version"],
  biome: ["check", "lint", "format", "ci"],
};

function checker(name: string, words: string[]): Verdict {
  const args = words.slice(1);
  const sub = args.find((w) => !w.startsWith("-"));
  if (CHECK_SUBS[name] && !CHECK_SUBS[name].includes(sub ?? "")) return unknownProgram(name);
  if (name === "vitest" && sub === "init") return unknownProgram(name);
  // the options of its subcommand when it has a list of its own, else the program's
  const key = sub !== undefined && KNOWN[`${name} ${sub}`] ? `${name} ${sub}` : CHECK_SUBS[name] ? `${name} ${sub}` : name;
  const known = knownOptions(key, args);
  if (known === "unknown") return unknownProgram(name);
  const opts = checkOptions(name, args);
  if (opts) return opts;
  const r = checkerOf(name, args);
  return known === "change" && RANK[r.action] < RANK.change ? v("change", say("kit.say.format"), 2) : r;
}

function checkerOf(name: string, args: string[]): Verdict {
  if (name === "playwright") return args[0] === "test" ? v("check", say("kit.say.test")) : args[0] === "install" ? thisMac() : unknownProgram(name);
  if (name === "cypress") return args[0] === "run" ? v("check", say("kit.say.test")) : unknownProgram(name);
  if (name === "tsc" || name === "vue-tsc") {
    // only `--noEmit` keeps tsc from writing, and `--noEmit false` takes it back
    const lower = args.map((w) => w.toLowerCase());
    const noEmit = lower.some((w, i) => (w === "--noemit" || w === "-noemit") && lower[i + 1] !== "false");
    const writes = lower.some((w) => w.startsWith("-") && TSC_WRITES.has(w.replace(/^-+/, "").split("=")[0]));
    return noEmit && !writes ? v("check", say("kit.say.check")) : v("change", say("kit.say.build"), 1);
  }
  if (name === "prettier") return has(args, "--write", "-w") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (name === "black" || name === "isort") return hasExactly(args, "--check", "--check-only", "-c", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 1);
  if (name === "ruff" && args[0] === "format") return hasExactly(args, "--check", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
  if (name === "biome" && args[0] === "format" && !has(args, "--write", "--apply", "--fix")) return v("check", say("kit.say.check"));
  if (has(args, ...FIXES)) return v("change", say("kit.say.format"), 2);
  return ["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test"].includes(name) ? v("check", say("kit.say.test")) : v("check", say("kit.say.check"));
}

function lang(name: string, words: string[]): Verdict {
  const [, sub, third] = words;
  if (name === "go") {
    // a test or a vet built with another program (`-exec`, `-toolexec`, `-vettool`), or writing a file, is not a check
    if (["test", "vet"].includes(sub) && knownOptions(`go ${sub}`, words.slice(2))) return unknownProgram(name);
    if (["test", "vet", "list"].includes(sub)) {
      const opts = checkOptions("go", words.slice(2));
      if (opts) return opts;
    }
    if (["test", "vet"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
    // a module at a version, its versions, its updates or its retractions are looked up through the module proxy, which
    // fetches them from the host the module's name begins with
    if (sub === "list" && (words.slice(2).some((w) => !w.startsWith("-") && w.includes("@")) || hasNamed(words.slice(2), "versions", "u", "retracted"))) return sends();
    if (["build", "generate"].includes(sub)) return v("change", say("kit.say.build"), 2);
    if (sub === "fmt") return v("change", say("kit.say.format"), 2);
    if (sub === "get" || (sub === "mod" && ["tidy", "download", "vendor"].includes(third))) return v("install", say("kit.say.update"), sub === "mod" ? 3 : 2);
    if (sub === "install") return thisMac();
    if (sub === "env" && has(words, "-w", "-u")) return thisMac();
    if (["version", "env", "list", "doc"].includes(sub)) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }
  // cargo: `--config` sets what runs a test binary (`target.<triple>.runner`), and `-Z` turns on what is not settled yet
  if (["test", "check", "bench", "clippy"].includes(sub)) {
    if (has(words.slice(2), "--config", "-Z")) return unknownProgram(name);
    const known = knownOptions(`cargo ${sub}`, words.slice(2));
    if (known === "unknown") return unknownProgram(name);
    const opts = checkOptions("cargo", words.slice(2));
    if (opts) return opts;
  }
  if (["test", "check", "bench"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
  if (sub === "clippy") return has(words, "--fix") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (sub === "fmt") return hasExactly(words, "--check") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
  if (["build", "doc"].includes(sub)) return v("change", say("kit.say.build"), 2);
  if (["add", "remove", "update"].includes(sub)) {
    const n = operands(words, 2).length;
    if (sub === "update") return v("install", say("kit.say.update"), 2);
    return v("install", sub === "add" ? (n === 1 ? say("kit.say.add1") : say("kit.say.addN", { n })) : n === 1 ? say("kit.say.remove1") : say("kit.say.removeN", { n }), 2);
  }
  if (sub === "install") return thisMac();
  if (sub === "publish") return live();
  if (sub === "clean") return v("delete", say("kit.say.delete"), "exact");
  return unknownProgram(name);
}

function python(words: string[]): Verdict {
  const [, flag, mod] = words;
  if (flag === "--version" || flag === "-V") return v("read", say("kit.say.read"));
  if (flag !== "-m" || !mod) return unknownProgram(words[0]);
  if (mod === "pytest") return checker("pytest", words.slice(2));
  // no list of unittest's options was read: with any, it asks
  if (mod === "unittest") return words.slice(3).some((w) => w.startsWith("-")) ? unknownProgram(words[0]) : v("check", say("kit.say.test"));
  if (["mypy", "black", "isort", "ruff", "flake8", "pylint"].includes(mod)) return checker(mod, words.slice(2));
  if (mod === "pip") return pip(words.slice(2));
  if (mod === "venv") return v("change", say("kit.say.change"), 3);
  return unknownProgram(words[0]);
}

function pip(words: string[]): Verdict {
  const sub = words[1];
  if (words.length === 2 && ["--version", "-V"].includes(sub)) return v("read", say("kit.say.read"));
  // read only with its own options known to change nothing: `--log` appends to a file, `--python` names a program
  if (["list", "show", "freeze", "check"].includes(sub)) return knownOptions(`pip ${sub}`, words.slice(2)) ? unknownProgram(words[0]) : v("read", say("kit.say.read"));
  if (["install", "uninstall"].includes(sub)) return thisMac();
  return unknownProgram(words[0]);
}

/** An option's name as written, in lower case, without its dashes or its value: `--Cache-Dir=x` is `cache-dir`. */
const optName = (w: string) => (w.startsWith("-") ? w.replace(/^-+/, "").split("=")[0].toLowerCase() : "");
/** Whether any of `words` is one of the options `names` (by `optName`), with one dash or two, its value joined or not. */
const hasNamed = (words: readonly string[], ...names: string[]) => words.some((w) => names.includes(optName(w)));

/** A program that deploys, and the words of its own that do not. */
function deployer(name: string, words: string[]): Verdict | null {
  const sub = words[1] ?? "";
  const run = () => v("change", say("kit.say.run"), 2);
  const look = () => v("read", say("kit.say.read"));
  switch (name) {
    case "wrangler":
      if (["deploy", "publish"].includes(sub) || (["pages", "versions"].includes(sub) && words[2] === "deploy") || (sub === "secret" && words[2] === "put")) return live();
      if (sub === "dev") return run();
      return ["whoami", "--version", "-v"].includes(sub) ? look() : unknownProgram(name);
    case "vercel":
      if (sub === "dev") return run();
      return ["whoami", "ls", "list", "--version", "inspect", "logs"].includes(sub) ? look() : live();
    case "netlify":
      if (sub === "dev") return run();
      if (sub === "deploy") return live();
      return sub === "status" ? look() : unknownProgram(name);
    case "firebase":
      if (sub === "deploy") return live();
      return ["emulators:start", "serve"].includes(sub) ? run() : unknownProgram(name);
    case "fly":
    case "flyctl":
    case "railway":
      if (["deploy", "up", "redeploy"].includes(sub)) return live();
      return ["status", "logs"].includes(sub) ? look() : unknownProgram(name);
    case "kubectl":
      // `-s` is its short `--server`, whose value need not be a link; a kubeconfig or kuberc it is pointed at can name a
      // program it runs for a key (`exec`) and the server it sends to
      if (hasNamed(words, "server", "s")) return sends();
      if (hasNamed(words, "kubeconfig", "kuberc")) return unknownProgram(name);
      // its cache and a profile are files it writes (a profile lands in the folder it runs in)
      if (hasNamed(words, "cache-dir", "profile-output") || words.some((w, i) => optName(w) === "profile" && (w.split("=")[1] ?? words[i + 1]) !== "none")) return v("change", say("kit.say.change"), "exact");
      // a secret's data is printed by `get` and its keys by `describe`: a key of a computer elsewhere, read as printenv is
      if (["get", "describe"].includes(sub) && words.slice(2).some((w) => !w.startsWith("-") && /(^|,)secrets?($|[,/.])/i.test(w))) return thisMac();
      if (["get", "describe", "logs", "explain", "version", "diff"].includes(sub)) return look();
      return ["apply", "create", "delete", "replace", "patch", "rollout", "scale", "set", "edit", "run"].includes(sub) ? live() : unknownProgram(name);
    case "terraform":
    case "tofu":
      // a plan saved to a file, and configuration it writes for what it imports, are files it writes
      if (sub === "plan" && hasNamed(words, "out", "generate-config-out", "state-out")) return v("change", say("kit.say.change"), "exact");
      // its outputs, sensitive ones among them, are printed in plain text with `-json` or `-raw`
      if (sub === "output") return thisMac();
      if (["plan", "validate", "show"].includes(sub)) return look();
      if (["apply", "destroy", "import"].includes(sub)) return live();
      return sub === "init" ? v("install", say("kit.say.update"), 2) : sub === "fmt" ? v("change", say("kit.say.format"), 2) : unknownProgram(name);
    case "pulumi":
      if (sub === "preview" && hasNamed(words, "save-plan")) return v("change", say("kit.say.change"), "exact");
      return sub === "preview" ? look() : ["up", "destroy", "refresh"].includes(sub) ? live() : unknownProgram(name);
    case "helm":
      if (hasNamed(words, "kube-apiserver")) return sends();
      if (hasNamed(words, "kubeconfig")) return unknownProgram(name);
      // a post-renderer is a program it runs on what it renders; `--output-dir` writes what it renders into files
      if (hasNamed(words, "post-renderer")) return unknownProgram(name);
      if (hasNamed(words, "output-dir")) return v("change", say("kit.say.change"), "exact");
      return ["list", "status", "template", "lint"].includes(sub) ? look() : ["install", "upgrade", "uninstall", "rollback"].includes(sub) ? live() : unknownProgram(name);
    case "serverless":
    case "sls":
    case "cdk":
      // a synth (and a diff, which synths first) runs the project's app and writes what it makes into a folder
      return ["deploy", "remove", "destroy"].includes(sub) ? live() : ["synth", "diff"].includes(sub) ? v("change", say("kit.say.build"), 2) : unknownProgram(name);
    case "eas":
    case "expo":
      return ["submit", "update", "publish"].includes(sub) ? live() : unknownProgram(name);
    case "heroku":
      return unknownProgram(name);
    default:
      return null;
  }
}

function docker(words: string[]): Verdict {
  const sub = words[1] ?? "";
  if (sub === "push") return live();
  if (sub === "build") return v("change", say("kit.say.build"), 2);
  if (sub === "compose") {
    // Its own options come before the command, and several take a value (`-p ps up` runs `up` in a project named ps), so
    // the command is read only when it comes first.
    const act = words[2] ?? "";
    if (act.startsWith("-")) return unknownProgram("docker");
    // `config -o` saves what it prints into a file
    if (act === "config" && hasIn("", words.slice(3), "-o", "--output")) return v("change", say("kit.say.change"), "exact");
    // config prints the settings with every variable filled in from the person's environment, unless it only lists names
    if (act === "config" && !hasExactly(words.slice(3), "--services", "--volumes", "--profiles", "--images", "--networks")) return thisMac();
    if (["ps", "logs", "config", "ls"].includes(act)) return v("read", say("kit.say.read"));
    if (["up", "down", "build", "start", "stop", "restart"].includes(act)) return v("change", say("kit.say.run"), 3);
    return unknownProgram("docker");
  }
  // inspect prints a container's environment, keys among them, as printenv does
  if (sub === "inspect" || (["container", "image"].includes(sub) && words[2] === "inspect")) return thisMac();
  if (["ps", "images", "logs", "version", "info"].includes(sub)) return v("read", say("kit.say.read"));
  if (["rm", "rmi", "prune"].includes(sub) || (["system", "volume", "image", "container"].includes(sub) && ["prune", "rm"].includes(words[2] ?? ""))) return v("delete", say("kit.say.delete"), "exact");
  return unknownProgram("docker");
}

/** curl and wget. Reading the network is not reading the project: a GET carries out whatever its address holds, and what it
 *  fetches can be written anywhere, so every request asks as anything that sends does. Only asking curl what it is reaches
 *  nothing. */
function web(name: string, words: string[]): Verdict {
  if (name === "curl" && words.length === 2 && ["--version", "-V", "--help", "-h", "--manual", "-M"].includes(words[1])) return v("read", say("kit.say.read"));
  return sends();
}

/** cd's own options (bash's and zsh's) that only choose how a link in the path is followed or how much it says. */
const CD_FLAGS = /^-[PLqse@]+$/;

/** A `cd` (or zsh's `chdir`). It reads nothing, but it decides where every later command of the session runs (item 116):
 *  one into a folder a change to which always asks asks too, and one whose folder cannot be known (`cd -`, a folder
 *  from the stack as `+1` or `-2`, zsh's two-word form, `~user`, the home folder when it is not known) asks and leaves
 *  the folder unknown. */
function changeFolder(words: string[], where: Where): Verdict {
  const lost = (extra: Partial<Verdict> = {}): Verdict => v("unknown", say("kit.say.opaque"), undefined, { lost: true, ...extra });
  const ops: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--" && !ops.length) {
      ops.push(...words.slice(i + 1));
      break;
    }
    if (!ops.length && w.length > 1 && /^[+-]/.test(w)) {
      if (CD_FLAGS.test(w)) continue;
      return lost();
    }
    ops.push(w);
  }
  if (ops.length > 1 || ops[0] === "-") return lost();
  const to = ops[0] ?? "~";
  const abs = to === "~" ? (where.home ?? null) : resolve(to, where.cwd, where.home);
  // the path is kept so that the line reads it as outside, as it did before
  if (abs === null) return lost({ cd: to });
  if (guardedPath(abs, where)) return v("unknown", say("kit.say.opaque"), undefined, { cd: to });
  return v("read", say("kit.say.read"), undefined, { cd: to });
}

/** One simple command's words as a step, wrappers taken off. Word numbers in the result (the rule's head, the words
 *  that are text) count from the program. */
function classify(words: string[], where: Where): Verdict {
  if (!words.length) return v("read", say("kit.say.read"));
  const raw = words[0];
  const name = raw.split(/[\\/]/).pop() ?? raw;
  const from = (k: number) => at$(classify(words.slice(k), where), k);

  // wrappers: the program after them speaks
  if (["time", "nohup", "command", "builtin", "exec", "stdbuf", "caffeinate"].includes(name)) return from(1);
  if (name === "nice") return from(words[1] === "-n" ? 3 : 1);
  if (name === "timeout") {
    const ops = operands(words, 1, new Set(["-s", "--signal", "-k", "--kill-after"]));
    return ops.length > 1 ? from(ops[1]) : unknownProgram(name);
  }
  // xargs adds the words it reads to the program's: options (`--pre=sh`), paths outside the project, anything. What it
  // runs is not known until it runs.
  if (name === "xargs") return v("unknown", say("kit.say.opaque"));
  // pnpx is `pnpm dlx`, which fetches the tool from the registry every time; bunx's own options are not read here
  if (name === "pnpx") return v("unknown", say("kit.say.opaque"));
  if (name === "npx" || name === "bunx") return at$(tool(words.slice(1), where, name === "npx" ? NPX_FLAGS : undefined), 1);
  if (name === "uv" || name === "poetry" || name === "pipenv" || name === "bundle") {
    const sub = words[1];
    if ((sub === "run" || sub === "exec") && words.length > 2) return from(2);
    if (name === "uv" && sub === "pip") {
      // `sync` installs and removes packages to match a list, and `compile` writes one
      if (["install", "uninstall", "sync"].includes(words[2] ?? "")) return v("install", say("kit.say.update"), 3);
      if (words[2] === "compile") return v("change", say("kit.say.change"), 3);
      // read only with its own options known to change nothing (`--python` runs the program it names)
      return ["list", "show", "freeze", "tree", "check"].includes(words[2] ?? "") && !knownOptions(`uv pip ${words[2]}`, words.slice(3)) ? v("read", say("kit.say.read")) : unknownProgram(name);
    }
    if (name === "uv" && sub === "tool") return thisMac();
    if (["add", "remove", "sync", "lock", "install", "update"].includes(sub ?? "")) return v("install", say("kit.say.update"), 2);
    if (sub === "publish") return live();
    if (sub === "build") return v("change", say("kit.say.build"), 2);
    if (["show", "check", "tree", "list"].includes(sub ?? "")) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }

  // A tool run by its path is the tool of that name only where the path really leads, `..` taken out, to a
  // `node_modules/.bin` of the project or of a folder in it (item 116). Any other path is a program nobody has read.
  if (/[\\/]/.test(raw)) {
    const abs = resolve(raw, where.cwd || where.root, where.home);
    const p = abs === null ? null : parts(abs).list;
    const inBin = p !== null && p.length >= 3 && p[p.length - 3] === "node_modules" && p[p.length - 2] === ".bin";
    if (inBin && abs !== null && within(abs, where.root)) return classify([p[p.length - 1], ...words.slice(1)], where);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    // a script of the project's own, run by its path: known by name only when it deploys
    const base = name.replace(/\.[A-Za-z0-9]+$/, "");
    return /deploy|release|publish/i.test(base) ? live() : unknownProgram(raw);
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(name)) return packageManager(words, where);
  if (name === "git") return (git(words, where));
  if (name === "gh") return gh(words, where);
  if (["grep", "egrep", "fgrep"].includes(name)) return (search(words, "grep"));
  if (["rg", "ag"].includes(name)) return (search(words, "rg"));
  if (name === "find") return find(words, where);
  // A list of files read from a file (`--files0-from`, `--files-from`, tar's `-T`, zip's `-@`): the files it reads, or
  // packs into the project, are named nowhere in the command, so whether they are outside it is not known.
  if (
    words.slice(1).some((w) => ["files0-from", "files-from"].includes(optName(w))) ||
    (name === "tar" && (hasIn("fCbTXKNLHV", words.slice(1), "-T") || /^[A-Za-z]*T/.test(words[1] ?? ""))) ||
    (name === "zip" && words.slice(1).some((w) => /^-[^-]*@/.test(w)))
  )
    return unknownProgram(name);
  if (RUNS_PROGRAM[name] && hasIn(RUNS_PROGRAM[name].values, words.slice(1), ...RUNS_PROGRAM[name].opts)) return unknownProgram(name);
  if ((name === "less" || name === "more") && words.some((w) => w.startsWith("+") && /[!|]/.test(w))) return unknownProgram(name);
  if (name === "sed") {
    // Its options are read from a short list. A script given any other way (`-e…` joined, `-ne`, a file) could hide a
    // command that runs a program, so a sed with any other option is not read in advance.
    const scripts: string[] = [];
    const text = new Set<number>();
    const ops: number[] = [];
    let inPlace = false;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === "--") {
        for (let j = i + 1; j < words.length; j++) ops.push(j);
        break;
      }
      if (w === "-e" || w === "--expression") {
        scripts.push(words[i + 1] ?? "");
        text.add(++i);
      } else if (w.startsWith("--expression=")) {
        scripts.push(w.slice("--expression=".length));
        text.add(i);
      } else if (w === "-i" || w === "--in-place") {
        inPlace = true;
        // macOS's `sed -i ''`: the empty word is the backup's suffix, not the script
        if (w === "-i" && words[i + 1] === "") text.add(++i);
      } else if (/^-i\.[A-Za-z0-9]+$/.test(w) || w.startsWith("--in-place=")) inPlace = true;
      else if (SED_FLAGS.has(w)) continue;
      else if (w.startsWith("-") && w !== "-") return unknownProgram(name);
      else ops.push(i);
    }
    if (!scripts.length && ops.length) {
      scripts.push(words[ops[0]]);
      text.add(ops[0]);
    }
    if (!scripts.every(sedSafe)) return unknownProgram(name);
    return inPlace ? v("change", say("kit.say.change"), 1, { text }) : v("read", say("kit.say.read"), undefined, { text });
  }
  if (name === "awk" || name === "gawk") {
    // Its options are read from a short list: a program from a file or a library (`-f`, `-i`, `-l`, `-e`, `--source`)
    // is not read in advance, nor is one that runs a command, pipes, writes or includes another.
    const ops: number[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === "--") {
        for (let j = i + 1; j < words.length; j++) ops.push(j);
        break;
      }
      if (w === "-F" || w === "-v") i++;
      else if (/^-[Fv]./.test(w)) continue;
      else if (w.startsWith("-") && w !== "-") return unknownProgram(name);
      else ops.push(i);
    }
    // The program is not parsed. A print that writes or pipes is looked for as any `>` or `|` after the first print,
    // wherever it is: a `}` or a `;` inside a string must not end the search early. `@` is gawk's (`@include`, and
    // `@f()`, which calls whatever function `f` names, `system` among them). ARGV and ARGC name the files it reads, so a
    // program that sets them reads what the command never said, and ENVIRON and PROCINFO hold the keys set for it.
    const prog = ops.length ? words[ops[0]] : "";
    const printAt = prog.search(/\bprintf?\b/);
    if ((printAt >= 0 && /[>|]/.test(prog.slice(printAt))) || /system\s*\(|getline|\|&|@|\bARGV\b|\bARGC\b|\bENVIRON\b|\bPROCINFO\b/.test(prog)) return unknownProgram(name);
    return v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) });
  }
  if (name === "export") {
    // a value set for the next commands is read in advance only when it is a harmless one
    // with nothing after it, it prints every variable set, keys among them, as printenv does
    const ops = operands(words, 1);
    return ops.length && ops.every((i) => !words[i].includes("=") || SAFE_VAR.test(words[i])) ? v("read", say("kit.say.read"), undefined, { text: new Set(ops) }) : v("unknown", say("kit.say.opaque"));
  }
  // `-R` runs tree again in every folder with `-o`, writing a file in each
  if (name === "tree" && hasIn("LPIHT", words.slice(1), "-o", "-R")) return v("change", say("kit.say.change"), 1);
  // programs that read, but write their output into a file named after the input (uniq, xxd) or by an option
  if ((name === "uniq" || name === "xxd") && operands(words, 1, name === "uniq" ? UNIQ_VALUES : XXD_VALUES).length > 1) return v("change", say("kit.say.change"), 1);
  // lsof's device cache, on a system built with one, is a file it builds and updates
  if (name === "lsof" && words.some((w) => w.startsWith("-D"))) return v("change", say("kit.say.change"), 1);
  if ((name === "less" || name === "more") && hasIn("bhjkpPtTxyz#", words.slice(1), "-o", "-O", "--log-file", "--LOG-FILE")) return v("change", say("kit.say.change"), 1);
  if (name === "file" && hasIn("mfFeP", words.slice(1), "-C", "--compile")) return v("change", say("kit.say.change"), 1);
  if (name === "hostname" && operands(words, 1).length) return thisMac();
  if (name === "jq" || name === "yq") {
    // yq's `--split-exp` writes each result into a file its expression names
    if (hasIn("poIs", words.slice(1), "-i", "--inplace") || (name === "yq" && hasIn("poI", words.slice(1), "-s", "--split-exp"))) return (v("change", say("kit.say.change"), 1));
    // With `-f` the filter comes from a file: jq takes the first file it is given as the filter wherever `-f` stands, and
    // every word is a file it reads, so none is text and each is checked as any path is.
    if (hasIn("L", words.slice(1), "-f", "--from-file")) return v("read", say("kit.say.read"));
    const all = jqOperands(words);
    // yq takes its expression after `eval` or `eval-all` (`e`, `ea`) when one is written
    const ops = name === "yq" && ["eval", "e", "eval-all", "ea"].includes(words[all[0]] ?? "") ? all.slice(1) : all;
    // a module a filter imports or includes is read from a folder of jq's own, `~/.jq` among them, or one `-L` names
    if (name === "jq" && ops.length && /\b(import|include)\b/.test(words[ops[0]])) return unknownProgram(name);
    // `env` and `$ENV` (jq), `env(NAME)` and `strenv(NAME)` (yq) print the variables set for this program, keys among them,
    // as printenv does, so they are read as it is. A field or a key called env (`.env`, `{env: 1}`) and jq's own `$env`
    // variable are only names. yq's `load` and its kinds (`load_str`, `load_xml`) read any file the expression names,
    // which no word shows as a path (item 116).
    if (ops.length && /(?<![.\w$])(?:env|strenv|envsubst)\b(?!\s*:)|\$ENV\b|\$__prog_args\b/.test(words[ops[0]])) return thisMac();
    if (name === "yq" && ops.length && /(?<![.\w$])load(_\w+)?\s*\(/.test(words[ops[0]])) return thisMac();
    return (v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) }));
  }
  if (name === "sort") return (hasIn("ktST", words.slice(1), "-o", "--output") ? v("change", say("kit.say.change"), 1) : v("read", say("kit.say.read")));
  if (name === "tee") return (v("change", say("kit.say.change"), 1));
  if (name === "cd" || name === "chdir") return changeFolder(words, where);
  // the folder stack, a script read into this shell and text run as a command can each move the shell anywhere
  if (["pushd", "popd", "source", ".", "eval"].includes(name)) return { ...unknownProgram(name), lost: true };
  // bash's and zsh's printf take one option, `-v NAME`, which puts its text into a variable instead of printing it: into
  // PATH, it decides which program every later word of the line runs
  if (name === "printf" && /^-./.test(words[1] ?? "") && words[1] !== "--") return v("unknown", say("kit.say.opaque"));
  // ps prints every program's environment, keys among them, with `-E`, or with `e` in BSD's form without a dash (ps(1));
  // `-e` alone is every process, outside legacy mode
  if (name === "ps" && words.slice(1).some((w, i) => (w.startsWith("-") ? w.slice(1).includes("E") : i === 0 && /^[a-zA-Z]*e[a-zA-Z]*$/.test(w)))) return thisMac();
  if (ONLY_TEXT.has(name)) return v("read", say("kit.say.read"), undefined, { text: new Set(words.map((_, i) => i).slice(1)) });
  if (READS.has(name)) return v("read", say("kit.say.read"));
  if (DELETES.has(name)) return v("delete", say("kit.say.delete"), "exact");
  if (WRITES_UNNAMED.has(name)) return unknownProgram(name);
  if (name === "cp" && hasIn("tS", words.slice(1), "-s", "-l", "--symbolic-link", "--link")) return unknownProgram(name);
  // an archive names its own files, links and folders, `..` among them
  if (name === "tar" && (hasIn("fCbTXKNLHV", words.slice(1), "-x", "--extract", "--get") || /^[a-wyzA-Z]*x/.test(words[1] ?? ""))) return unknownProgram(name);
  if (name === "unzip" && !["-l", "-t", "-v", "-Z", "-p"].includes(words[1] ?? "")) return unknownProgram(name);
  // gunzip writes the file named after the archive, its ending taken off
  if ((name === "gunzip" || (name === "gzip" && has(words.slice(1), "-d", "--decompress"))) && words.slice(1).some((w) => !w.startsWith("-") && guardedPath(w.replace(/(\.gz|\.z|-gz|-z|_z)$/i, ""), where))) return unknownProgram(name);
  if (CHANGES.has(name)) return (v("change", say("kit.say.change"), 1));
  if (name === "rsync") return words.slice(1).some((w) => SCP_LIKE.test(w) || /^[^/\s]+:/.test(w)) ? sends() : (v("change", say("kit.say.change"), 1));
  if (THIS_MAC.has(name)) return thisMac();
  if (SENDS.has(name)) return sends();
  if (OPAQUE_PROGRAMS.has(name)) return unknownProgram(name);
  if (CHECKERS.has(name)) return (checker(name, words));
  if (name === "go" || name === "cargo") return (lang(name, words));
  if (["python", "python3", "py"].includes(name)) return (python(words));
  if (name === "pip" || name === "pip3") return pip(words);
  if (name === "gem") return words[1] === "push" ? live() : words[1] === "install" ? thisMac() : unknownProgram(name);
  if (name === "twine") return words[1] === "upload" ? live() : unknownProgram(name);
  if (name === "composer") return ["require", "install", "update", "remove"].includes(words[1] ?? "") ? (v("install", say("kit.say.update"), 2)) : unknownProgram(name);
  if (["make", "just", "task"].includes(name)) {
    // Read only with its own options that choose how many run at once and how much it says. Any other can name another
    // file of recipes (`-f`, `--justfile`, `-t`), text to read as recipes (`--eval`), the shell they run in (`just
    // --shell`) or a folder to include; and `NAME=value` after it replaces that word in every recipe, `SHELL` among them.
    const values = RUNNER_VALUES[name];
    const targets: number[] = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (!w.startsWith("-") || w === "-") {
        if (w.includes("=")) return unknownProgram(name);
        targets.push(i);
        continue;
      }
      if (RUNNER_FLAGS[name].has(w) || RUNNER_JOINED[name].test(w)) continue;
      if (values.has(w.split("=")[0])) {
        // make's `-j` and `-l` take a number after them only when one is there (GNU make's manual: `-j [jobs]`); no value
        // option takes a word that starts with `-` (item 120: `make -j --file=other.mk test` runs the other file's test)
        const optional = name === "make" && ["-j", "--jobs", "-l", "--load-average"].includes(w);
        if (!w.includes("=") && takesWord(words[i + 1]) && (!optional || /^[0-9.]+$/.test(words[i + 1]))) i++;
        continue;
      }
      return unknownProgram(name);
    }
    if (!targets.length) return unknownProgram(name);
    return (strictest(targets.map((i) => script(words[i], i + 1))));
  }
  if (FRAMEWORKS.has(name)) {
    const sub = words[1] && !words[1].startsWith("-") ? words[1] : "";
    if (name === "turbo" || name === "nx") {
      const task = sub === "run" ? 2 : 1;
      if (!sub || !words[task] || words[task].startsWith("-")) return unknownProgram(name);
      const s = script(words[task], task + 1);
      if (s.action !== "check") return s;
      // its own options are read from its list (nx's from none), and the words after `--` as a script's
      const rest = words.slice(task + 1);
      const dash = rest.indexOf("--");
      const own = dash >= 0 ? rest.slice(0, dash) : rest;
      if (knownOptions(name, own)) return unknownProgram(name);
      if (dash < 0) return s;
      const handed = knownOptions("", rest.slice(dash + 1), true);
      return handed === "unknown" ? unknownProgram(name) : (checkOptions("", rest.slice(dash + 1)) ?? (handed === "change" ? v("change", say("kit.say.format"), task + 1) : s));
    }
    if (sub === "build" || ["webpack", "rollup", "esbuild", "tsup", "parcel"].includes(name)) return (v("change", say("kit.say.build"), sub ? 2 : 1));
    // a framework's lint hands its options to the linter, and no list of them was read: with any, it asks
    if (sub === "lint") return words.slice(2).some((w) => w.startsWith("-")) ? unknownProgram(name) : v("check", say("kit.say.check"));
    if (sub === "deploy") return live();
    return (v("change", say("kit.say.run"), sub ? 2 : 1));
  }
  const d = deployer(name, words);
  if (d) return (d);
  if (["docker", "podman"].includes(name)) return (docker(words));
  if (name === "curl" || name === "wget") return (web(name, words));
  if (RUNTIMES.has(name)) return words[1] === "--version" || words[1] === "-v" ? v("read", say("kit.say.read")) : unknownProgram(name);
  return unknownProgram(name);
}

/** A verdict read from the words from `by` on, with its word numbers counted from the whole command again. */
function at$(r: Verdict, by: number): Verdict {
  if (!by) return r;
  const head = typeof r.head === "number" ? r.head + by : r.head;
  const text = r.text ? new Set([...r.text].map((i) => i + by)) : undefined;
  return { ...r, ...(head === undefined ? {} : { head }), ...(text ? { text } : {}) };
}

/** find's (BSD's and GNU's) options and tests that only choose where it looks, match a file, or print to its own output.
 *  Any other word starting with `-` is not read in advance: it may be one that deletes, writes a file, or reads its list of
 *  files from one (`-files0-from`), or one this list has not met. */
const FIND_FLAGS = new Set([
  "-E", "-H", "-L", "-P", "-X", "-d", "-s", "-x", "-O0", "-O1", "-O2", "-O3", "-depth", "-empty", "-executable", "-readable",
  "-writable", "-false", "-true", "-follow", "-ignore_readdir_race", "-noignore_readdir_race", "-ls", "-mount", "-xdev", "-noleaf",
  "-nogroup", "-nouser", "-print", "-print0", "-prune", "-quit", "-sparse", "-xattr", "-acl", "-not", "-a", "-and", "-o", "-or",
  "-daystart", "-warn", "-nowarn", "-help", "--help", "-version", "--version",
]);
/** Its tests whose value is text: a pattern, a number, a type, a format printed to its own output. */
const FIND_TEXT = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-lname", "-ilname", "-type", "-xtype",
  "-perm", "-user", "-group", "-uid", "-gid", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-Btime", "-Bmin",
  "-used", "-maxdepth", "-mindepth", "-links", "-inum", "-fstype", "-flags", "-printf", "-regextype", "-context", "-xattrname", "-D",
]);
/** Its tests that look at another file's times or identity: the file is a path like any other, checked against the project. */
const FIND_FILE = new Set(["-newer", "-anewer", "-cnewer", "-mnewer", "-Bnewer", "-samefile", "-f"]);
const FIND_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-newer", "-mtime", "-mmin", "-size"]);
/** Its actions that run a program for each file: each one's command runs, however many there are. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** A find, read word by word. Every command it runs (each `-exec`, `-execdir`, `-ok` and `-okdir`, not only the first) is
 *  read as a command of its own, and the find is as strict as the strictest of them. A command ends at `;`, or at a `+`
 *  right after `{}` (a `+` anywhere else is one of its words, as find reads it). `-ok` asks on its input, which a pipe can
 *  answer, so it is read as `-exec` is. */
function find(words: string[], where: Where): Verdict {
  const text = new Set<number>();
  const parts: Verdict[] = [];
  /** Its own `-delete`. */
  const own = v("delete", say("kit.say.delete"), "exact");
  let filtered = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (FIND_RUNS.has(w)) {
      let end = i + 1;
      while (end < words.length && words[end] !== ";" && !(words[end] === "+" && words[end - 1] === "{}")) end++;
      const inner = at$(classify(words.slice(i + 1, end), where), i + 1);
      parts.push({ ...inner, head: inner.action === "read" || inner.action === "check" ? undefined : "exact" });
      i = end;
      continue;
    }
    // a place to start from, or an operator (`!`, `(`, `)`, `,`)
    if (!w.startsWith("-") || w === "-") continue;
    if (FIND_FILTERS.has(w)) filtered = true;
    if (FIND_FLAGS.has(w) || /^-[EHLPXdsx]+$/.test(w)) continue;
    if (FIND_TEXT.has(w)) {
      if (i + 1 < words.length) text.add(i + 1);
      i++;
      continue;
    }
    // `-newermt 2026-01-01` and the like compare with a time or a file: a value that is a path is checked as one
    if (FIND_FILE.has(w) || /^-newer[aBcmt][aBcmt]$/.test(w)) {
      i++;
      continue;
    }
    if (w === "-delete") {
      parts.push(own);
      continue;
    }
    // each writes its list into the file it names; `-fprintf`'s format, after the file, is text
    if (["-fprint", "-fprint0", "-fls", "-fprintf"].includes(w)) {
      parts.push(v("change", say("kit.say.change"), "exact"));
      if (w === "-fprintf" && i + 2 < words.length) text.add(i + 2);
      i += w === "-fprintf" ? 2 : 1;
      continue;
    }
    return unknownProgram("find");
  }
  // the words of each command it runs that are text stay text
  for (const p of parts) for (const i of p.text ?? []) text.add(i);
  const whole = strictest([v("read", say("kit.say.read")), ...parts]);
  // `-delete` with a test on the name or the age, wherever it comes in the words, deletes only what matches: its folders
  // are where it looks, not what it deletes
  return { ...whole, text, ...(whole === own && filtered ? { filtered: true as const } : {}), ...(parts.some((p) => p.moves) ? { moves: true as const } : {}) };
}

function strictest(list: Verdict[]): Verdict {
  return list.reduce((a, b) => (RANK[b.action] > RANK[a.action] ? b : a));
}

// ---- the whole command --------------------------------------------------------------------------------------------

/** The places a word can name: the word itself; after an option's `=`, or after the `=` of a `name=value` the program
 *  reads (`make OUT=…`, `dd of=…`), its value; and a path joined to a short option (`-o/Users/me/.zshenv`, bundled after
 *  others as in `-fsSLo~/.zshenv`). A program reads a short option's value from the letter after it, so the path starts
 *  wherever a part of the word reads as one. */
function valuesIn(w: string): string[] {
  const out: string[] = [];
  if (!w.startsWith("-")) out.push(w);
  const eq = w.indexOf("=");
  if (eq >= 0) out.push(w.slice(eq + 1));
  if (/^-[^-]./.test(w)) {
    for (let k = 2; k < w.length; k++) {
      const rest = w.slice(k);
      if ((pathLike(rest) && rest.length > 1) || /^file:\/\//i.test(rest)) {
        out.push(rest);
        break;
      }
    }
  }
  // `@file` is a file read for its words (a response file, curl's and gh's `@` for a field's value): one from a root, the
  // home folder or a folder above is the path it names. `@~1` and `@{u}` are git's names for a commit.
  for (const x of [...out]) if (x.startsWith("@") && /^(\/|~(\/|$)|\.\.([\\/]|$)|[A-Za-z]:[\\/]|\\\\)/.test(x.slice(1))) out.push(x.slice(1));
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Options whose value is a computer to talk to: a server, an API, a registry, a proxy, a link (`--index-url`). turbo's
 *  `--token` and `--team` send its cache to that team. Compared by name in lower case, a dotted one (`--api.host`) by its
 *  first part. */
const ELSEWHERE = /^(server|api|repo|repository|registry|endpoint|url|host|hostname|remote|proxy)$|-(url|host|proxy|server|endpoint|registry|api|repo)$/;

/** Whether a step reaches another computer by its words: any word but text that holds an address (`scheme://`, a file://
 *  link aside), and, for a read or a check, an option that names a server. git and gh read their own addresses (a remote
 *  is the project's own, github.com is GitHub's), and curl and wget always send. */
function reachesOut(words: string[], verdict: Verdict): boolean {
  const prog = (words[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (["git", "gh", "curl", "wget"].includes(prog)) return false;
  const looks = verdict.action === "read" || verdict.action === "check";
  return words.some((w, i) => {
    if (i === 0 || verdict.text?.has(i)) return false;
    if (w.includes("://") && !/^(-[^=]*=)?file:\/\//i.test(w)) return true;
    if (!looks || !w.startsWith("--")) return false;
    const n = optName(w);
    return ELSEWHERE.test(n) || ELSEWHERE.test(n.split(".")[0]) || (prog === "turbo" && ["token", "team"].includes(n));
  });
}

/** Programs that name no file and read nothing from the folder they run in: the only ones read as they are from a folder
 *  that cannot be known. */
const NO_FILE = new Set(["pwd", "echo", "printf", "date", "whoami", "uname", "true", "false", "sleep", "id", "sw_vers", "uptime", "which", "type", "wait", "exit"]);
/** Words that, as a command, may move the shell to another folder. */
const MOVES = new Set(["cd", "chdir", "pushd", "popd", "source", ".", "eval"]);
/** Words before a program that only change how it runs (`builtin cd x` is a `cd`). */
const WRAPS = new Set(["time", "nohup", "command", "builtin", "exec", "stdbuf", "caffeinate", "nice", "timeout"]);
/** The most folders a session's shell is followed through. Past it, where it is cannot be known. */
const MAX_FOLDERS = 32;

/** The program a simple command runs, assignments and wrappers taken off, as written. */
const programOf = (words: readonly string[]) => words.find((w) => !ASSIGNMENT.test(w) && !WRAPS.has(w) && !w.startsWith("-") && !/^[0-9]+$/.test(w)) ?? "";

/** One way through a line: the folder the shell is in (null when it cannot be known), as written, and whether the last
 *  step that decides a `&&` or a `||` succeeded (`ok`: a `cd` that went; `fail`: one that did not; `any`: not known). */
interface Flow {
  dir: string | null;
  written: string;
  st: "ok" | "fail" | "any";
}

/** Folders as a list with no two the same. */
function distinct(list: readonly (string | null)[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (const f of list) if (!out.some((x) => (x === null || f === null ? x === f : samePath(x, f)))) out.push(f);
  return out;
}

/** What `line` does when it runs at `where`: read from `cwd` and from every folder in `from`, the strictest reading
 *  speaking for all of them. */
export function readCommand(line: string, where: Where): ReadCommand {
  const lexed = lex(line);
  const session = where.cwd || where.root;
  const reads = distinct([session, ...(where.from ?? [])]).map((start) => readFrom(lexed, where, start));
  const first = reads[0];
  const worst = reads.reduce((a, b) => (RANK[b.action] > RANK[a.action] ? b : a));
  const outside: string[] = [];
  for (const r of reads) for (const p of r.outside) if (!outside.includes(p)) outside.push(p);
  const sameRule = reads.every((r) => JSON.stringify(r.rule) === JSON.stringify(first.rule));
  // only a `cd` to the project's or the session's folder, written in full: that folder is there, so the shell is in it
  const only = lexed.cmds.length === 1 && !lexed.opaque ? lexed.cmds[0].words : null;
  const to = only && only.length === 2 && ["cd", "chdir"].includes(only[0]) && isAbs(only[1]) ? only[1] : null;
  const resets = to !== null && (samePath(to, where.root) || samePath(to, session)) ? to : null;
  return {
    action: worst.action,
    outside,
    saves: reads.some((r) => r.saves),
    rule: sameRule && !outside.length ? first.rule : null,
    say: worst.say,
    ends: distinct(reads.flatMap((r) => r.ends)),
    ...(resets ? { resets } : {}),
    movesHead: reads.some((r) => r.movesHead),
  };
}

/** The folders a session's shell may be in after a command read as `read`, from those it may have been in before. They
 *  only grow: a command may fail, and an agent may keep the folder it failed in. Only a command that is a `cd` to the
 *  project's folder (`resets`) sets them again. */
export function foldersAfter(before: readonly (string | null)[], read: Pick<ReadCommand, "ends" | "resets">): (string | null)[] {
  if (read.resets) return [read.resets];
  const all = distinct([...before, ...read.ends]);
  return all.includes(null) || all.length > MAX_FOLDERS ? [null] : all;
}

/** `line` read as it runs from the folder `start` (null: a folder that cannot be known), followed through each way the
 *  shell can take: a `cd` may fail, `&&` runs the next command only after one that went, `||` only after one that did
 *  not, and `;` runs it either way. */
function readFrom({ cmds, opaque }: Lexed, where: Where, start: string | null): Omit<ReadCommand, "resets"> {
  const allowed = where.allowed ?? [];
  const session = where.cwd || where.root;
  const outside: string[] = [];
  const out = (written: string) => {
    if (!outside.includes(written)) outside.push(written);
  };
  if (start !== null && !insideProject(start, where.root, allowed)) out(start);

  const verdicts: Verdict[] = [];
  let saves = false;
  let wipes = false;
  /** A step that changes something names a path in git's own folder, or another whose change always asks. */
  let gitOwn = false;
  // A step anywhere in the line that may switch the branch checked out (item 120): a push in the same line is read with no
  // branch, whether it comes after the step or beside it in a pipeline or in the background, where it may run after it.
  const lineMoves = cmds.some((c) => {
    const at = c.words.findIndex((w) => !ASSIGNMENT.test(w));
    return at >= 0 && classify(c.words.slice(at), { ...where, cwd: session }).moves === true;
  });

  /** One simple command read in the folder of `f`: what it moves the shell to, or that the folder is lost after it. */
  const readOne = (c: Simple, f: Flow): { to?: { dir: string; written: string }; lost?: true } => {
    const unknownHere = f.dir === null;
    const cwd = f.dir ?? session;
    // where the commands run so far, as written: the folder they started in, or the last `cd`
    const cwdWritten = f.dir === null ? session : f.written;
    let at = 0;
    while (at < c.words.length && ASSIGNMENT.test(c.words[at])) at++;
    const words = c.words.slice(at);
    // a variable set for this command can make the same words run another program, unless it is a harmless one
    if (c.words.slice(0, at).some((w) => !SAFE_VAR.test(w))) {
      verdicts.push(v("unknown", say("kit.say.opaque")));
      return MOVES.has(programOf(words)) ? { lost: true } : {};
    }
    // a pipe into a shell or a runtime runs text nobody has read
    if (c.piped && words.length && (OPAQUE_PROGRAMS.has(words[0]) || RUNTIMES.has(words[0]) || ["python", "python3"].includes(words[0]))) {
      verdicts.push(v("unknown", say("kit.say.opaque")));
      return {};
    }
    // the branch was read in the project's folder: a push from any other, or after a step that may have moved it, names
    // none (item 120)
    const branch = !lineMoves && !unknownHere && samePath(cwd, where.root) ? where.branch : undefined;
    const classified = classify(words, { ...where, cwd, branch });
    // reaching another computer is not reading or changing the project, whatever the program
    const read = RANK[classified.action] < RANK.unknown && reachesOut(words, classified) ? { ...sends(), text: classified.text } : classified;
    // writing the output into a file changes the project, whatever the program is
    const writesFile = c.writes.some((w) => !NULL_DEVICES.has(w));
    let verdict: Verdict = writesFile && RANK[read.action] < RANK.change ? { ...read, action: "change" as const, say: say("kit.say.change"), head: undefined } : read;
    // From a folder that cannot be known, a relative path may be anywhere: only a command that names no file, or a `cd`
    // to a folder written in full, is read as it is. Anything else asks.
    const absCd = verdict.cd !== undefined && (isAbs(verdict.cd) || verdict.cd === "~" || verdict.cd.startsWith("~/"));
    const plain = NO_FILE.has(words[0] ?? "") && RANK[verdict.action] <= RANK.read && !c.redirects.length;
    if (unknownHere && !absCd && !plain && RANK[verdict.action] < RANK.unknown) verdict = { ...verdict, action: "unknown", say: say("kit.say.opaque"), head: undefined };
    verdicts.push(verdict);
    if (verdict.saves) saves = true;
    // an allowed folder is for reading: a step that changes anything stays inside the project itself
    const reads = verdict.action === "read" || verdict.action === "check";
    const mayUse = reads ? allowed : [];
    if (!reads && !within(cwd, where.root)) out(cwdWritten);

    const check = (written: string, maybeOutside: boolean) => {
      if (NULL_DEVICES.has(written)) return;
      const abs = resolve(written, cwd, where.home);
      // a bare name is wherever the command runs: a folder already said to be outside is not said again
      if (maybeOutside && (abs === null || !insideProject(abs, where.root, mayUse))) out(written);
      else if (verdict.action === "delete" && !verdict.filtered && abs !== null && (within(where.root, abs) || /^(\.\/)?\*$/.test(written))) wipes = true;
    };
    words.forEach((w, i) => {
      if (i === 0 || verdict.text?.has(i)) return;
      for (const value of valuesIn(w)) {
        // a file:// link is the path it names; any other link is not on this computer
        if (/^file:\/\//i.test(value)) check(value.replace(/^file:\/\/(localhost)?/i, ""), true);
        else if (value && !URL_LIKE.test(value) && !SCP_LIKE.test(value)) check(value, pathLike(value));
      }
    });
    for (const r of c.redirects) check(r, true);
    // git's own folder, the agents' settings, a hook a tool runs by itself and package.json can make a later step run a
    // program or let an agent do more (`guardedPath`): a step that changes anything there, by a word it names, a file
    // it writes its output into, or the folder it went into first, is not one the dial lets go alone. A short option's
    // joined value (`-o.npmrc`) may be its name from any letter on.
    const here = { cwd, root: where.root, home: where.home };
    const named = (w: string) => [...valuesIn(w), ...(/^-[^-]./.test(w) ? Array.from({ length: w.length - 2 }, (_, k) => w.slice(k + 2)) : [])];
    if (c.writes.some((w) => IN_GIT_DIR.test(w) || guardedPath(w, here))) gitOwn = true;
    // An option's value that is such a file asks even on a read or a check (item 116): an option this reading does not
    // know may write it (`--log CLAUDE.md`). An option that only leaves something out (`--exclude-dir=.git`) is not one.
    // A file named as an operand (`cat package.json`) stays a read.
    const leavesOut = (w: string) => /^-+(exclude|ignore|skip|prune)/i.test(w);
    if (reads && words.some((w, i) => i > 0 && w.startsWith("-") && !leavesOut(w) && !verdict.text?.has(i) && named(w).some((x) => x !== "" && (IN_GIT_DIR.test(x) || guardedPath(x, here)))))
      gitOwn = true;
    if (!reads && (guardedPath(cwd, here) || words.some((w, i) => i > 0 && !verdict.text?.has(i) && (IN_GIT_DIR.test(w) || named(w).some((x) => x !== "" && guardedPath(x, here)))))) gitOwn = true;

    if (verdict.cd !== undefined) {
      // from a folder that cannot be known, a relative `cd` goes nowhere that can be said: it asks, and is not outside
      const known = !unknownHere || absCd;
      const to = !known ? null : verdict.cd === "~" ? (where.home ?? null) : resolve(verdict.cd, cwd, where.home);
      if (known && (to === null || !insideProject(to, where.root, allowed))) out(verdict.cd);
      if (to !== null && !verdict.lost) return { to: { dir: to, written: verdict.cd } };
      return { lost: true };
    }
    return verdict.lost ? { lost: true } : {};
  };

  let flows: Flow[] = [{ dir: start, written: start ?? session, st: "any" }];
  for (let i = 0; i < cmds.length; ) {
    // a pipeline: each of its commands runs in a shell of its own, started where the pipeline starts
    let j = i + 1;
    while (j < cmds.length && cmds[j].sep === "|") j++;
    const pipe = cmds.slice(i, j);
    const sep = cmds[i].sep;
    // a `cd` moves the shell itself only alone, not in a pipeline or in the background
    const alone = pipe.length === 1 && pipe[0].after !== "&";
    const runs = (f: Flow) => !((sep === "&&" && f.st === "fail") || (sep === "||" && f.st === "ok"));
    // a command no way through runs is read all the same, from every folder: nothing goes unread
    const taken = flows.some(runs) ? flows : flows.map((f) => ({ ...f, st: "any" as const }));
    const next: Flow[] = [];
    for (const f of taken) {
      if (!runs(f)) {
        next.push(f);
        continue;
      }
      const moved: { dir: string; written: string }[] = [];
      let lost = false;
      for (const c of pipe) {
        const r = readOne(c, f);
        if (r.lost) lost = true;
        if (r.to) moved.push(r.to);
      }
      if (lost) next.push({ dir: null, written: session, st: "any" });
      else if (moved.length && alone) next.push({ ...moved[0], st: "ok" }, { ...f, st: "fail" });
      else next.push({ ...f, st: "any" }, ...moved.map((m) => ({ ...m, st: "any" as const })));
    }
    flows = next.filter((f, k) => next.findIndex((g) => g.st === f.st && (g.dir === null || f.dir === null ? g.dir === f.dir : samePath(g.dir, f.dir))) === k);
    if (flows.length > MAX_FOLDERS * 2) flows = [{ dir: null, written: session, st: "any" }];
    i = j;
  }
  // a line that cannot be read in advance and holds a command that may move the shell (a `cd` in a subshell or a brace
  // group, a `source`) leaves it where nobody can say
  const ends = opaque && cmds.some((c) => MOVES.has(programOf(c.words))) ? [null] : distinct(flows.map((f) => f.dir));

  const whole = verdicts.length ? strictest(verdicts) : v("unknown", say("kit.say.opaque"));
  let action: KitAction = whole.action;
  let s = whole.say;
  if (opaque) {
    action = RANK[action] > RANK.unknown ? action : "unknown";
    if (action === "unknown") s = say("kit.say.opaque");
  }
  if (wipes && action === "delete") {
    action = "unknown";
    s = say("kit.say.wipe");
  }
  if (gitOwn && RANK[action] < RANK.unknown) action = "unknown";

  // A rule is kept only for one simple command that changes, installs, deletes or pushes, read in full, with no
  // variable set before it and no redirect, and naming nothing outside.
  let rule: Rule | null = null;
  const only = cmds.length === 1 ? cmds[0] : null;
  const ruleable = action === "change" || action === "install" || action === "delete" || action === "push";
  if (only && ruleable && !opaque && !outside.length && !only.redirects.length && !ASSIGNMENT.test(only.words[0] ?? "") && whole.head !== undefined) {
    rule = whole.head === "exact" ? { words: [...only.words], exact: true, action } : { words: only.words.slice(0, whole.head), action };
  }
  // after it, the branch checked out may not be the one read before (item 120): a step that may move it, one nobody can
  // read, or a shell left in another folder
  const movesHead = lineMoves || RANK[action] >= RANK.unknown || ends.some((e) => e === null || !samePath(e, where.root));
  return { action, outside, saves, rule, say: s, ends, movesHead };
}

/** A package manager's own subcommands: none of them runs a script of the project's by its name. */
const PM_OWN = new Set([
  "add", "install", "i", "in", "ci", "remove", "rm", "uninstall", "un", "unlink", "update", "up", "upgrade", "dedupe", "prune", "audit", "dlx",
  "exec", "x", "publish", "deploy", "pack", "config", "ls", "list", "why", "outdated", "view", "info", "show", "root", "bin", "help", "doctor",
  "explain", "licenses", "create", "init", "link", "global", "store", "env", "setup", "import", "patch", "rebuild", "fetch", "server", "pkg",
]);

/** The name of the package.json script `line` runs, when it is one simple command that runs a script of the folder it runs
 *  in by its name (`pnpm run db:migrate`, `pnpm test`, `yarn dev`, `npm start`); null for anything else, a script of
 *  another folder (`--filter`, `-C`, `-r`) among them. The name says nothing of what the script does: its card shows that. */
export function scriptRun(line: string): string | null {
  const { cmds, opaque } = lex(line);
  if (opaque || cmds.length !== 1 || cmds[0].redirects.length) return null;
  const words = cmds[0].words;
  const pm = (words[0] ?? "").split(/[\\/]/).pop() ?? "";
  if (!["pnpm", "npm", "yarn", "bun"].includes(pm)) return null;
  if (has(words, "--filter", "-F", "-C", "--dir", "--prefix", "-r", "--recursive", "--workspace", "-w", "--cwd", "--workspaces")) return null;
  const ops = operands(words, 1, PM_VALUE);
  const sub = ops.length ? words[ops[0]] : undefined;
  if (sub === undefined) return null;
  if (sub === "run" || sub === "run-script") return ops.length > 1 ? words[ops[1]] : null;
  if (["test", "t", "tst"].includes(sub)) return pm === "bun" ? null : "test";
  if (pm === "npm") return ["start", "stop", "restart"].includes(sub) ? sub : null;
  return PM_OWN.has(sub) ? null : sub;
}

/** Whether a kept rule covers `line`: one simple command, read in full, whose first words are the rule's (all of them,
 *  and nothing more, for an exact rule). */
export function ruleMatches(rule: Rule, line: string): boolean {
  const { cmds, opaque } = lex(line);
  if (opaque || cmds.length !== 1 || cmds[0].redirects.length || !rule.words.length) return false;
  const words = cmds[0].words;
  if (ASSIGNMENT.test(words[0] ?? "")) return false;
  if (rule.exact && words.length !== rule.words.length) return false;
  return rule.words.every((w, i) => words[i] === w);
}

/** Options that make a command do more of what it does, or something harsher: force, delete, hard, clear, recursive. */
const HARSHER = /^--(force|force-with-lease|force-if-includes|delete|hard|clear|recursive|mirror|prune|discard-changes)(=|$)/;
/** The short ones, where the program reads its letters so (git's `-f`, `-d`, `-D`, `-r`; a package manager's `-f` and
 *  `-r`), counted inside a bundle (`-fu`). Elsewhere a letter means something else (`pnpm add -D` saves a tool). */
const HARSHER_SHORT: Record<string, RegExp> = { git: /^-[^-]*[fdDrR]/, pnpm: /^-[^-]*[fr]/, npm: /^-[^-]*[fr]/, yarn: /^-[^-]*[fr]/, bun: /^-[^-]*[fr]/ };

/** The step a kept rule covers: the one it was kept for, or, for a rule saved before rules named one, the least strict
 *  step its own words can mean (read as on a branch of Kit's own, so `git push` is a push). */
const ruleAction = (rule: Rule): KitAction => rule.action ?? readCommand(rule.words.join(" "), { cwd: "/rule", root: "/rule", branch: "kit/rule" }).action;

/** Whether a kept rule covers `line`, read as `action` (item 116): its words begin the line (`ruleMatches`), the line is
 *  the very step the rule was kept for, and no word after the rule's own is an option that makes it harsher. So a rule
 *  kept from a push never covers a forced push or a delete, nor one kept from a new branch a branch's delete. */
export function ruleCovers(rule: Rule, line: string, action: KitAction): boolean {
  if (!ruleMatches(rule, line) || ruleAction(rule) !== action) return false;
  const words = lex(line).cmds[0].words;
  const short = HARSHER_SHORT[words[0] ?? ""];
  return !words.slice(rule.words.length).some((w) => HARSHER.test(w) || short?.test(w));
}

/** A rule as the developer reads it: "pnpm add …", or the whole command. */
export function ruleText(rule: Rule): string {
  return rule.exact ? rule.words.join(" ") : `${rule.words.join(" ")} …`;
}
