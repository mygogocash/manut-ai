// The whole command: a line read as every simple command it holds, with the folders each runs in, what it writes and what it sends, and the reading of a package script's name.
// Its own file because it is the one that joins every family's reading into `readCommand`.
import type { KitAction } from "@manut/member-grants";
import { insideProject, isAbs, NULL_DEVICES, pathLike, resolve, samePath, SCP_LIKE, URL_LIKE, within } from "./paths";
import { has, operands, optName, RANK, say, sends, strictest, v, type Verdict } from "./verdict";
import { type ReadCommand, type Rule, type Where } from "./types";
import { lex, type Lexed, type Simple } from "./shell";
import { classify } from "./classify";
import { IN_GIT_DIR, OPAQUE_PROGRAMS, RUNTIMES, SAFE_VAR } from "./programs";
import { guardedPath } from "./protected";
import { PM_OWN, PM_VALUE } from "./packages";

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

export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

/** The same, and `trap`, as words anywhere in a simple command (item 120): behind a word that is no wrapper the reading
 *  follows (`! cd`, `command -p cd`, `noglob cd`, `repeat 1 cd`, `then cd`, `do cd`, a function's body) the shell still
 *  moves. `.` is left to where a program stands, since as a word it is mostly the folder it names (`git add .`). */
const MOVE_NAMES = new Set(["cd", "chdir", "pushd", "popd", "source", "eval", "trap"]);

/** Words the shell reads before the program of a simple command: `!`, the reserved words that open or go on with a
 *  compound command, and the wrappers and zsh's precommand modifiers (`repeat` takes a count). */
const SHELL_PREFIX = new Set(["!", "if", "then", "else", "elif", "while", "until", "do", "{", "time", "noglob", "nocorrect", "command", "builtin", "exec", "coproc", "repeat", "nohup", "nice", "stdbuf", "caffeinate", "timeout", "-"]);

/** Programs that define what a later command of the same shell runs (item 120), zsh's `setopt` and bash's `shopt` among them:
 *  with AUTO_CD (autocd) a folder's bare name is a `cd`. */
const DEFINES = new Set(["alias", "function", "trap", "eval", "source", ".", "setopt", "shopt"]);

/** Words before a program that only change how it runs (`builtin cd x` is a `cd`). */
const WRAPS = new Set(["time", "nohup", "command", "builtin", "exec", "stdbuf", "caffeinate", "nice", "timeout"]);

/** The most folders a session's shell is followed through. Past it, where it is cannot be known. */
const MAX_FOLDERS = 32;

/** The program a simple command runs, assignments and wrappers taken off, as written. */
const programOf = (words: readonly string[]) => words.find((w) => !ASSIGNMENT.test(w) && !WRAPS.has(w) && !w.startsWith("-") && !/^[0-9]+$/.test(w)) ?? "";

/** The same, past every word the shell reads before a program too (item 120). */
const programAt = (words: readonly string[]) => words.find((w) => !ASSIGNMENT.test(w) && !SHELL_PREFIX.has(w) && !w.startsWith("-") && !/^[0-9]+$/.test(w)) ?? "";

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
    unseen: reads.some((r) => r.unseen),
    sends: reads.some((r) => r.sends),
    tags: [...new Set(reads.flatMap((r) => r.tags))],
    defines: reads.some((r) => r.defines),
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
function readFrom({ cmds, opaque, defines: lexDefines }: Lexed, where: Where, start: string | null): Omit<ReadCommand, "resets"> {
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
  const pre = cmds.map((c) => {
    const at = c.words.findIndex((w) => !ASSIGNMENT.test(w));
    return at >= 0 ? classify(c.words.slice(at), { ...where, cwd: session }) : null;
  });
  const lineMoves = pre.some((r) => r?.moves === true);
  // the tags the line makes, which a push in it may send by their bare names (item 120)
  const lineTags = pre.flatMap((r) => r?.tags ?? []);
  const tags = [...(where.tags ?? []), ...lineTags];

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
    const classified = classify(words, { ...where, cwd, branch, tags });
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

    // a `cd` the reading did not take as one, behind a word it does not follow or in a compound command (item 120): once it
    // has run, where the shell is cannot be said
    if (verdict.cd === undefined && !verdict.lost && (words.some((w, i) => !verdict.text?.has(i) && MOVE_NAMES.has(w)) || programAt(words) === ".")) return { lost: true };
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
  // a function, an alias or a trap it defines, or text read into the shell, may move it whenever a later command runs (item 120)
  const defines = lexDefines || cmds.some((c) => DEFINES.has(programAt(c.words)));
  const ends = defines || (opaque && cmds.some((c) => MOVES.has(programOf(c.words)))) ? [null] : distinct(flows.map((f) => f.dir));

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
  // A save the read of the folder before the line cannot see (item 120): a message or a body from a file, or any step
  // beside the commit or the push that writes files (one that only reads, checks, stages what is there or saves is none).
  const unseen = verdicts.some((x) => x.fromFile) || (saves && verdicts.some((x) => !x.saves && !x.staged && RANK[x.action] >= RANK.edit));
  return { action, outside, saves, rule, say: s, ends, movesHead, unseen, sends: verdicts.some((x) => x.sends), tags: lineTags, defines };
}

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
