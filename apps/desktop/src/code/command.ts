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
}

/** What a step does, in words: a dictionary key and its slots. */
export interface Say {
  key: Key;
  vars?: Record<string, string | number>;
}

/** What "Always allow in this project" keeps: a command's first words, or the whole command (`exact`). */
export interface Rule {
  words: string[];
  exact?: true;
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

interface Simple {
  words: string[];
  /** Where its output or input goes: each target as written. */
  redirects: string[];
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
  let cur: Simple = { words: [], redirects: [], piped: false };
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let redirect = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirect) {
      // `>&2`, `2>&1`: a copy of another stream, not a file
      if (!/^&?[0-9-]$/.test(word)) cur.redirects.push(word);
      redirect = false;
    } else cur.words.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = (piped: boolean) => {
    endWord();
    if (redirect) opaque = true; // a redirect with no target
    if (cur.words.length || cur.redirects.length) cmds.push(cur);
    cur = { words: [], redirects: [], piped };
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
      endCmd(false);
      continue;
    }
    if (c === "&" && next === "&") {
      endCmd(false);
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        endCmd(false);
        i++;
      } else {
        if (next === "&") i++;
        endCmd(true);
      }
      continue;
    }
    if (c === "&" && next === ">") {
      endWord();
      redirect = true;
      i += line[i + 2] === ">" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endCmd(false);
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
      if (line[i + 1] === "&") {
        i++;
        // `>&2` copies a stream; `>&file` is not a form a command writes
        redirect = true;
        word = "&";
        inWord = true;
        continue;
      }
      redirect = true;
      continue;
    }
    if (c === "`" || (c === "$" && next !== undefined && /[A-Za-z_({0-9?@*#!$-]/.test(next))) {
      opaque = true;
      word += c;
      inWord = true;
      continue;
    }
    if (c === "(" || c === ")" || ((c === "{" || c === "}") && !inWord && (next === undefined || next === " " || next === "\n"))) {
      opaque = true;
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) opaque = true;
  endCmd(false);
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

const has = (words: string[], ...opts: string[]) => words.some((w) => opts.includes(w) || opts.some((o) => o.startsWith("--") && w.startsWith(`${o}=`)));

/** A package.json script, a make target or a task, by its name. Known names only: any other may do anything. */
function script(name: string, head: number): Verdict {
  const n = name.toLowerCase();
  if (/deploy|release|publish|ship|(^|[:._-])prod(uction)?($|[:._-])/.test(n)) return live();
  if (/fix|write|format|fmt|prettier/.test(n) && !/check|lint$/.test(n)) return v("change", say("kit.say.format"), head);
  if (/^(test|tests|spec|e2e|coverage|cover)([:._-].*)?$/.test(n) || /[:._-](test|tests|spec|e2e)$/.test(n)) return v("check", say("kit.say.test"));
  if (/^(check|checks|lint|typecheck|type-check|types|tsc|verify|validate|ci)([:._-].*)?$/.test(n) || /[:._-](check|lint|typecheck)$/.test(n))
    return v("check", say("kit.say.check"));
  if (/^(build|compile|bundle|generate|gen|codegen|prepare)([:._-].*)?$/.test(n)) return v("change", say("kit.say.build"), head);
  if (/^(dev|start|serve|preview|watch|storybook)([:._-].*)?$/.test(n)) return v("change", say("kit.say.run"), head);
  return v("unknown", say("kit.say.script", { name }));
}

const PM_VALUE = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--cwd", "--reporter", "--loglevel", "--workspace-dir"]);

/** pnpm, npm, yarn and bun. */
function packageManager(words: string[], where: Where): Verdict {
  const pm = words[0];
  if (has(words, "-g", "--global", "--location=global")) return thisMac();
  const ops = operands(words, 1, PM_VALUE);
  if (!ops.length) return pm === "yarn" ? v("install", say("kit.say.installAll"), 1) : v("read", say("kit.say.read"));
  const at = ops[0];
  const sub = words[at];
  const head = at + 1;
  const rest = ops.slice(1).map((i) => words[i]);
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
  if (["test", "t", "tst"].includes(sub)) return v("check", say("kit.say.test"));
  if (sub === "run" || sub === "run-script") {
    const name = rest[0];
    return name ? script(name, head + 1) : v("read", say("kit.say.read"));
  }
  if (["exec", "dlx", "x"].includes(sub)) return at$(tool(words.slice(head), where), head);
  if (["publish", "deploy"].includes(sub)) return live();
  if (sub === "pack") return v("change", say("kit.say.build"), head);
  if (["ls", "list", "why", "outdated", "view", "info", "show", "root", "bin", "help", "doctor", "explain", "licenses", "config", "--version", "-v"].includes(sub))
    return v("read", say("kit.say.read"));
  if (["create", "init", "link"].includes(sub)) return unknownProgram(pm);
  if (pm === "bun" && /[./]/.test(sub)) return unknownProgram(pm);
  if (pm === "npm" && !["start", "stop", "restart"].includes(sub)) return unknownProgram(pm);
  // pnpm, yarn and bun run a tool of the project's by its name when no script has that name
  const asTool = classify(words.slice(at), where);
  if (!(asTool.action === "unknown" && asTool.say.key === "kit.say.unknown")) return at$(asTool, at);
  return script(sub, head);
}

/** The main branch's usual names: a push to one goes live. */
const MAIN = new Set(["main", "master", "trunk", "production", "prod", "release", "live", "stable", "gh-pages"]);
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function git(words: string[], where: Where): Verdict {
  const ops = operands(words, 1, GIT_VALUE);
  if (!ops.length) return v("read", say("kit.say.read"));
  const at = ops[0];
  const sub = words[at];
  const head = at + 1;
  const args = words.slice(head);
  const rest = ops.slice(1).map((i) => words[i]);
  const history = () => v("read", say("kit.say.history"));
  const change = () => v("change", say("kit.say.change"), head);
  const del = (s: Say = say("kit.say.delete")) => v("delete", s, "exact");
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
    case "var":
      return history();
    case "grep":
      return { ...history(), text: new Set(ops.slice(1, 2)) };
    case "fetch":
      return v("read", say("kit.say.fetch"));
    case "reflog":
      return has(args, "expire", "delete") ? del() : history();
    case "commit":
      return v("change", say("kit.say.commit"), head, { saves: true, text: textAfter(words, ["-m", "--message", "-F", "--file", "--author", "--date", "-C", "-c", "--fixup", "--squash", "--template", "-t"]) });
    case "add":
    case "mv":
    case "switch":
    case "merge":
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "am":
    case "apply":
    case "pull":
    case "init":
    case "notes":
    case "clone":
      return { ...change(), text: textAfter(words, ["-m", "--message", "-b", "--branch", "-c", "--config", "--origin", "-o"]) };
    case "checkout": {
      if (has(args, "-b", "-B", "--orphan")) return change();
      const discards = args.includes("--") || rest.some((w) => w === "." || /\.[^./\\]+$/.test(w.split(/[\\/]/).pop() ?? ""));
      return discards ? del(say("kit.say.discard")) : change();
    }
    case "restore":
      return has(args, "--staged", "-S") && !has(args, "--worktree", "-W") ? change() : del(say("kit.say.discard"));
    case "reset":
      return has(args, "--hard", "--keep", "--merge") ? del(say("kit.say.discard")) : change();
    case "clean":
      return has(args, "-n", "--dry-run") ? history() : del();
    case "rm":
      return has(args, "--cached") ? change() : del();
    case "gc":
    case "prune":
    case "filter-branch":
    case "filter-repo":
      return del();
    case "update-ref":
      return has(args, "-d") ? del() : change();
    case "branch":
      if (has(args, "-d", "-D", "--delete")) return del();
      if (!rest.length || has(args, "-a", "-r", "--list", "-l", "-v", "-vv", "--show-current", "--contains", "--merged", "--no-merged")) return history();
      return change();
    case "tag":
      if (has(args, "-d", "--delete")) return del();
      if (!rest.length || has(args, "-l", "--list", "-n")) return history();
      return { ...change(), text: textAfter(words, ["-m", "--message"]) };
    case "stash":
      if (["drop", "clear"].includes(rest[0] ?? "")) return del();
      if (["list", "show"].includes(rest[0] ?? "")) return history();
      return { ...change(), text: textAfter(words, ["-m", "--message"]) };
    case "worktree":
      if (["remove", "prune"].includes(rest[0] ?? "")) return del();
      return rest[0] === "list" ? history() : change();
    case "submodule":
      return rest[0] === "status" || !rest.length ? history() : change();
    case "remote":
      if (["remove", "rm"].includes(rest[0] ?? "")) return del();
      return !rest.length || ["show", "get-url"].includes(rest[0] ?? "") ? history() : change();
    case "config":
      if (has(args, "--global", "--system")) return thisMac();
      return has(args, "--get", "--list", "-l", "--get-all", "--get-regexp") || rest.length <= 1 ? history() : change();
    case "push":
      return push(words, head, where);
    default:
      return unknownProgram("git");
  }
}

function push(words: string[], head: number, where: Where): Verdict {
  const args = words.slice(head);
  const ops = operands(words, head, new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]));
  const refs = ops.slice(1).map((i) => words[i]);
  const target = (ref: string) => {
    const r = ref.replace(/^\+/, "");
    const dst = r.includes(":") ? r.slice(r.indexOf(":") + 1) : r;
    const name = dst === "HEAD" || dst === "" ? (where.branch ?? "") : dst;
    return name.replace(/^refs\/heads\//, "");
  };
  // a push that names no branch sends the one checked out: live when that is the main branch, or not known
  const names = refs.length ? refs.map(target) : [where.branch ?? ""];
  if (has(args, "--tags", "--follow-tags", "--mirror", "--all") || names.some((n) => !n || MAIN.has(n))) return { ...live(), saves: true };
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

function gh(words: string[]): Verdict {
  const [, area, act] = words;
  const head = 3;
  const text = textAfter(words, ["-t", "--title", "-b", "--body", "-m", "--message", "--subject", "-q", "--jq", "--template"]);
  const reads = ["list", "view", "status", "checks", "diff"];
  switch (area) {
    case "pr":
      if (act === "create") return v("push", say("kit.say.pr"), head, { saves: true, text });
      if (act === "merge") return live();
      if (act === "checkout") return v("change", say("kit.say.change"), head);
      return reads.includes(act ?? "") ? v("read", say("kit.say.history")) : sends();
    case "repo":
      if (act === "clone") return v("change", say("kit.say.change"), head);
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
    case "api": {
      const method = words.find((_, i) => /^(-X|--method)$/.test(words[i - 1] ?? ""));
      const fields = has(words, "-f", "-F", "--field", "--raw-field", "--input");
      return fields || (method && !/^get$/i.test(method)) ? sends() : v("read", say("kit.say.web"));
    }
    default:
      return unknownProgram("gh");
  }
}

const SEARCH_VALUE: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--label", "--binary-files"]),
  rg: new Set(["-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-j", "-M", "-r", "-E", "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--replace", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--max-depth", "--maxdepth", "--sort", "--sortr", "--encoding", "--pre", "--pre-glob", "--ignore-file", "--type-add", "--type-clear"]),
};

/** grep, rg and the like: the first word that is not an option is the pattern, unless one came with `-e` or `-f`. */
function search(words: string[], kind: "grep" | "rg"): Verdict {
  const takes = SEARCH_VALUE[kind];
  const ops = operands(words, 1, takes);
  const text = new Set<number>();
  words.forEach((w, i) => {
    if (takes.has(w) && !["-f", "--file", "--ignore-file"].includes(w) && i + 1 < words.length) text.add(i + 1);
  });
  if (!has(words, "-e", "--regexp", "-f", "--file") && ops.length) text.add(ops[0]);
  return v("read", say("kit.say.read"), undefined, { text });
}

const READS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "file", "stat", "du", "df", "ls", "tree", "pwd", "realpath", "readlink",
  "basename", "dirname", "diff", "cmp", "comm", "uniq", "cut", "tr", "nl", "od", "hexdump", "xxd", "strings", "column",
  "fold", "rev", "tac", "which", "type", "whereis", "true", "false", "test", "[", "date", "sleep", "whoami", "uname", "id",
  "hostname", "sw_vers", "fd", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "ps", "lsof", "uptime", "history",
  "export", "unset", "set", "alias", "exit", "wait",
]);
const ONLY_TEXT = new Set(["echo", "printf", "export", "unset", "set", "alias"]);
const CHANGES = new Set(["mkdir", "touch", "cp", "mv", "ln", "chmod", "install", "patch", "tar", "unzip", "zip", "gzip", "gunzip", "dos2unix", "truncate"]);
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
const THIS_MAC = new Set(["brew", "port", "apt", "apt-get", "yum", "dnf", "pacman", "snap", "choco", "winget", "scoop", "softwareupdate", "defaults", "launchctl", "systemctl", "crontab", "mas", "sudo", "doas", "su", "chown", "nvm", "fnm", "volta", "asdf", "mise", "pyenv", "rbenv"]);
const SENDS = new Set(["ssh", "scp", "sftp", "nc", "ncat", "telnet", "ftp", "mosh"]);
const OPAQUE_PROGRAMS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "source", ".", "eval", "open", "xdg-open", "osascript", "kill", "pkill", "killall", "printenv", "env"]);
const RUNTIMES = new Set(["node", "deno", "ts-node", "tsx", "ruby", "perl", "php", "java", "lua", "Rscript", "swift"]);

/** Checks that only report, and tools that report unless told to fix. */
const CHECKERS = new Set(["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test", "mypy", "pyright", "flake8", "pylint", "shellcheck", "hadolint", "actionlint", "knip", "depcheck", "cspell", "stylelint", "markdownlint", "eslint", "biome", "ruff", "black", "isort", "prettier", "tsc", "vue-tsc", "playwright", "cypress"]);
const FIXES = ["--fix", "--write", "-w", "--apply", "--apply-unsafe", "-u", "--update", "--updateSnapshot", "--update-snapshots"];
const FRAMEWORKS = new Set(["vite", "next", "nuxt", "astro", "remix", "webpack", "rollup", "esbuild", "tsup", "parcel", "turbo", "nx"]);

/** A tool run by name, through npx or a package manager's exec as much as directly. */
function tool(words: string[], where: Where): Verdict {
  // npx's own options come before the tool
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += ["-p", "--package"].includes(words[i]) ? 2 : 1;
  return i < words.length ? at$(classify(words.slice(i), where), i) : v("unknown", say("kit.say.opaque"));
}

function checker(name: string, words: string[]): Verdict {
  const args = words.slice(1);
  if (name === "playwright") return args[0] === "test" ? v("check", say("kit.say.test")) : args[0] === "install" ? thisMac() : unknownProgram(name);
  if (name === "cypress") return args[0] === "run" ? v("check", say("kit.say.test")) : unknownProgram(name);
  if (name === "tsc" || name === "vue-tsc") return has(args, "--noEmit") ? v("check", say("kit.say.check")) : v("change", say("kit.say.build"), 1);
  if (name === "prettier") return has(args, "--write", "-w") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (name === "black" || name === "isort") return has(args, "--check", "--check-only", "-c", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 1);
  if (name === "ruff" && args[0] === "format") return has(args, "--check", "--diff") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
  if (name === "biome" && args[0] === "format" && !has(args, "--write", "--apply")) return v("check", say("kit.say.check"));
  if (has(args, ...FIXES)) return v("change", say("kit.say.format"), 2);
  return ["vitest", "jest", "mocha", "ava", "tap", "pytest", "py.test"].includes(name) ? v("check", say("kit.say.test")) : v("check", say("kit.say.check"));
}

function lang(name: string, words: string[]): Verdict {
  const [, sub, third] = words;
  if (name === "go") {
    if (["test", "vet"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
    if (["build", "generate"].includes(sub)) return v("change", say("kit.say.build"), 2);
    if (sub === "fmt") return v("change", say("kit.say.format"), 2);
    if (sub === "get" || (sub === "mod" && ["tidy", "download", "vendor"].includes(third))) return v("install", say("kit.say.update"), sub === "mod" ? 3 : 2);
    if (sub === "install") return thisMac();
    if (["version", "env", "list", "doc"].includes(sub)) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }
  // cargo
  if (["test", "check", "bench"].includes(sub)) return v("check", sub === "test" ? say("kit.say.test") : say("kit.say.check"));
  if (sub === "clippy") return has(words, "--fix") ? v("change", say("kit.say.format"), 2) : v("check", say("kit.say.check"));
  if (sub === "fmt") return has(words, "--check") ? v("check", say("kit.say.check")) : v("change", say("kit.say.format"), 2);
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
  if (["pytest", "unittest"].includes(mod)) return v("check", say("kit.say.test"));
  if (["mypy", "black", "isort", "ruff", "flake8", "pylint"].includes(mod)) return checker(mod, words.slice(2));
  if (mod === "pip") return pip(words.slice(2));
  if (mod === "venv") return v("change", say("kit.say.change"), 3);
  return unknownProgram(words[0]);
}

function pip(words: string[]): Verdict {
  const sub = words[1];
  if (["list", "show", "freeze", "check", "--version"].includes(sub)) return v("read", say("kit.say.read"));
  if (["install", "uninstall"].includes(sub)) return thisMac();
  return unknownProgram(words[0]);
}

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
      if (["get", "describe", "logs", "explain", "version", "diff"].includes(sub)) return look();
      return ["apply", "create", "delete", "replace", "patch", "rollout", "scale", "set", "edit", "run"].includes(sub) ? live() : unknownProgram(name);
    case "terraform":
    case "tofu":
      if (["plan", "validate", "show", "output"].includes(sub)) return look();
      if (["apply", "destroy", "import"].includes(sub)) return live();
      return sub === "init" ? v("install", say("kit.say.update"), 2) : sub === "fmt" ? v("change", say("kit.say.format"), 2) : unknownProgram(name);
    case "pulumi":
      return sub === "preview" ? look() : ["up", "destroy", "refresh"].includes(sub) ? live() : unknownProgram(name);
    case "helm":
      return ["list", "status", "template", "lint"].includes(sub) ? look() : ["install", "upgrade", "uninstall", "rollback"].includes(sub) ? live() : unknownProgram(name);
    case "serverless":
    case "sls":
    case "cdk":
      return ["deploy", "remove", "destroy"].includes(sub) ? live() : ["synth", "diff"].includes(sub) ? look() : unknownProgram(name);
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
    const act = words.find((w, i) => i > 1 && !w.startsWith("-")) ?? "";
    if (["ps", "logs", "config", "ls"].includes(act)) return v("read", say("kit.say.read"));
    if (["up", "down", "build", "start", "stop", "restart"].includes(act)) return v("change", say("kit.say.run"), 3);
    return unknownProgram("docker");
  }
  if (["ps", "images", "logs", "inspect", "version", "info"].includes(sub)) return v("read", say("kit.say.read"));
  if (["rm", "rmi", "prune"].includes(sub) || (["system", "volume", "image", "container"].includes(sub) && ["prune", "rm"].includes(words[2] ?? ""))) return v("delete", say("kit.say.delete"), "exact");
  return unknownProgram("docker");
}

function web(name: string, words: string[]): Verdict {
  if (has(words, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--json", "--post-data", "--post-file", "--body-data", "--body-file")) return sends();
  const x = words.findIndex((w) => w === "-X" || w === "--request" || w === "--method");
  if (x >= 0 && !/^(get|head)$/i.test(words[x + 1] ?? "")) return sends();
  const writes = name === "wget" ? !has(words, "-O-", "--spider") && !(words.includes("-O") && words[words.indexOf("-O") + 1] === "-") : has(words, "-o", "-O", "--output", "--remote-name", "--output-dir", "--remote-name-all");
  return writes ? v("change", say("kit.say.change"), 1) : v("read", say("kit.say.web"));
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
  if (name === "xargs") {
    const ops = operands(words, 1, new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a", "--max-args", "--replace", "--max-procs", "--delimiter", "--arg-file"]));
    return ops.length ? from(ops[0]) : v("read", say("kit.say.read"));
  }
  if (["npx", "bunx", "pnpx"].includes(name)) {
    return at$(tool(words.slice(1), where), 1);
  }
  if (name === "uv" || name === "poetry" || name === "pipenv" || name === "bundle") {
    const sub = words[1];
    if ((sub === "run" || sub === "exec") && words.length > 2) return from(2);
    if (name === "uv" && sub === "pip") return words[2] === "install" || words[2] === "uninstall" ? v("install", say("kit.say.update"), 3) : v("read", say("kit.say.read"));
    if (name === "uv" && sub === "tool") return thisMac();
    if (["add", "remove", "sync", "lock", "install", "update"].includes(sub ?? "")) return v("install", say("kit.say.update"), 2);
    if (sub === "publish") return live();
    if (sub === "build") return v("change", say("kit.say.build"), 2);
    if (["show", "check", "tree", "list"].includes(sub ?? "")) return v("read", say("kit.say.read"));
    return unknownProgram(name);
  }

  if (/(^|[\\/])node_modules[\\/]\.bin[\\/]/.test(raw)) return classify([name, ...words.slice(1)], where);
  if (raw.includes("/") || raw.includes("\\")) {
    // a script of the project's own, run by its path: known by name only when it deploys
    const base = name.replace(/\.[A-Za-z0-9]+$/, "");
    return /deploy|release|publish/i.test(base) ? live() : unknownProgram(raw);
  }
  if (["pnpm", "npm", "yarn", "bun"].includes(name)) return packageManager(words, where);
  if (name === "git") return (git(words, where));
  if (name === "gh") return (gh(words));
  if (["grep", "egrep", "fgrep"].includes(name)) return (search(words, "grep"));
  if (["rg", "ag", "ack"].includes(name)) return (search(words, "rg"));
  if (name === "find") return find(words, where);
  if (name === "sed") {
    const inPlace = words.some((w) => w === "-i" || w.startsWith("-i") || w === "--in-place" || w.startsWith("--in-place="));
    const ops = operands(words, 1, new Set(["-e", "-f", "--expression", "--file"]));
    const text = new Set(words.flatMap((w, i) => (["-e", "--expression"].includes(w) ? [i + 1] : [])));
    if (!has(words, "-e", "--expression", "-f", "--file") && ops.length) text.add(ops[0]);
    // macOS's `sed -i ''`: the empty word is the backup's suffix, not the script
    if (words.includes("-i") && words[words.indexOf("-i") + 1] === "") text.add(words.indexOf("-i") + 1);
    return (inPlace ? v("change", say("kit.say.change"), 1, { text }) : v("read", say("kit.say.read"), undefined, { text }));
  }
  if (name === "awk" || name === "gawk") {
    const ops = operands(words, 1, new Set(["-F", "-v", "-f"]));
    const prog = ops.length ? words[ops[0]] : "";
    if (/system\s*\(|\|\s*"|>\s*"|getline/.test(prog) || words.includes("-i")) return unknownProgram(name);
    return (v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) }));
  }
  if (name === "jq" || name === "yq") {
    if (has(words, "-i", "--inplace")) return (v("change", say("kit.say.change"), 1));
    const ops = operands(words, 1, new Set(["--arg", "--argjson", "-f", "--from-file", "--indent"]));
    return (v("read", say("kit.say.read"), undefined, { text: new Set(ops.slice(0, 1)) }));
  }
  if (name === "sort") return (has(words, "-o", "--output") ? v("change", say("kit.say.change"), 1) : v("read", say("kit.say.read")));
  if (name === "tee") return (v("change", say("kit.say.change"), 1));
  if (name === "cd") {
    const ops = operands(words, 1);
    const to = ops.length ? words[ops[0]] : "~";
    return to === "-" ? v("unknown", say("kit.say.opaque")) : v("read", say("kit.say.read"), undefined, { cd: to });
  }
  if (ONLY_TEXT.has(name)) return v("read", say("kit.say.read"), undefined, { text: new Set(words.map((_, i) => i).slice(1)) });
  if (READS.has(name)) return v("read", say("kit.say.read"));
  if (DELETES.has(name)) return v("delete", say("kit.say.delete"), "exact");
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
    const targets = operands(words, 1, new Set(["-C", "-f", "--file", "-j", "--jobs", "-d", "--directory"])).filter((i) => !words[i].includes("="));
    if (!targets.length) return unknownProgram(name);
    return (strictest(targets.map((i) => script(words[i], i + 1))));
  }
  if (FRAMEWORKS.has(name)) {
    const sub = words[1] && !words[1].startsWith("-") ? words[1] : "";
    if (name === "turbo" || name === "nx") return sub === "run" && words[2] ? (script(words[2], 3)) : sub ? (script(sub, 2)) : unknownProgram(name);
    if (sub === "build" || ["webpack", "rollup", "esbuild", "tsup", "parcel"].includes(name)) return (v("change", say("kit.say.build"), sub ? 2 : 1));
    if (sub === "lint") return v("check", say("kit.say.check"));
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

function find(words: string[], where: Where): Verdict {
  const text = textAfter(words, ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-lname", "-ilname", "-type", "-newer", "-perm", "-user", "-group", "-size", "-mtime", "-mmin", "-atime", "-ctime", "-maxdepth", "-mindepth"]);
  const filtered = words.some((w) => ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-wholename", "-iwholename", "-newer", "-mtime", "-mmin", "-size"].includes(w));
  if (words.includes("-delete")) return v("delete", say("kit.say.delete"), "exact", { text, ...(filtered ? { filtered: true as const } : {}) });
  const exec = words.findIndex((w) => ["-exec", "-execdir", "-ok", "-okdir"].includes(w));
  if (exec >= 0) {
    const end = words.findIndex((w, i) => i > exec && (w === ";" || w === "+"));
    const inner = at$(classify(words.slice(exec + 1, end < 0 ? undefined : end), where), exec + 1);
    return strictest([v("read", say("kit.say.read"), undefined, { text }), { ...inner, head: inner.action === "read" || inner.action === "check" ? undefined : "exact" }]);
  }
  if (words.some((w) => ["-fprint", "-fprint0", "-fprintf", "-fls"].includes(w))) return v("change", say("kit.say.change"), "exact", { text });
  return v("read", say("kit.say.read"), undefined, { text });
}

function strictest(list: Verdict[]): Verdict {
  return list.reduce((a, b) => (RANK[b.action] > RANK[a.action] ? b : a));
}

// ---- the whole command --------------------------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** What `line` does when it runs at `where`. */
export function readCommand(line: string, where: Where): ReadCommand {
  const { cmds, opaque } = lex(line);
  const allowed = where.allowed ?? [];
  const outside: string[] = [];
  const out = (written: string) => {
    if (!outside.includes(written)) outside.push(written);
  };
  let cwd = where.cwd || where.root;
  // where the commands run so far, as written: the folder they started in, or the last `cd`
  let cwdWritten = cwd;
  if (!insideProject(cwd, where.root, allowed)) out(cwd);

  const verdicts: Verdict[] = [];
  let saves = false;
  let wipes = false;
  for (const c of cmds) {
    let at = 0;
    while (at < c.words.length && ASSIGNMENT.test(c.words[at])) at++;
    const words = c.words.slice(at);
    // a pipe into a shell or a runtime runs text nobody has read
    if (c.piped && words.length && (OPAQUE_PROGRAMS.has(words[0]) || RUNTIMES.has(words[0]) || ["python", "python3"].includes(words[0]))) {
      verdicts.push(v("unknown", say("kit.say.opaque")));
      continue;
    }
    const verdict = classify(words, { ...where, cwd });
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
      const value = w.startsWith("-") ? (w.includes("=") ? w.slice(w.indexOf("=") + 1) : "") : w;
      if (value && !URL_LIKE.test(value) && !SCP_LIKE.test(value)) check(value, pathLike(value));
    });
    for (const r of c.redirects) check(r, true);

    if (verdict.cd !== undefined) {
      const to = verdict.cd === "~" ? (where.home ?? null) : resolve(verdict.cd, cwd, where.home);
      if (to === null || !insideProject(to, where.root, allowed)) out(verdict.cd);
      if (to) {
        cwd = to;
        cwdWritten = verdict.cd;
      }
    }
  }

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

  // A rule is kept only for one simple command that changes, installs, deletes or pushes, read in full, with no
  // variable set before it and no redirect, and naming nothing outside.
  let rule: Rule | null = null;
  const only = cmds.length === 1 ? cmds[0] : null;
  const ruleable = action === "change" || action === "install" || action === "delete" || action === "push";
  if (only && ruleable && !opaque && !outside.length && !only.redirects.length && !ASSIGNMENT.test(only.words[0] ?? "") && whole.head !== undefined) {
    rule = whole.head === "exact" ? { words: [...only.words], exact: true } : { words: only.words.slice(0, whole.head) };
  }
  return { action, outside, saves, rule, say: s };
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

/** A rule as the developer reads it: "pnpm add …", or the whole command. */
export function ruleText(rule: Rule): string {
  return rule.exact ? rule.words.join(" ") : `${rule.words.join(" ")} …`;
}
