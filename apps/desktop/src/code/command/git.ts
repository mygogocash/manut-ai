// What git does: the read-only and changing subcommands, fetch, branch and tag listings, config reads, and the push that goes live.
// Its own file because it is the largest family and shares nothing with the others beyond the verdict helpers.
import { resolve, samePath, SCP_LIKE, URL_LIKE, WIN_ABS } from "./paths";
import { has, hasExactly, hasIn, isOpt, live, operands, say, sends, takesWord, textAfter, thisMac, unknownProgram, v, type Verdict } from "./verdict";
import { type Say, type Where } from "./types";

/** The main branch's usual names: a push to one goes live. */
const MAIN = new Set(["main", "master", "trunk", "production", "prod", "release", "live", "stable", "gh-pages"]);

/** Names git reads as the branch checked out: HEAD, `@`, and `head` in any letter case, which a disk that ignores letter case
 *  (macOS's) finds as HEAD (item 120; tried with git 2.54). */
const HEAD_NAME = /^(head|@)$/i;

/** A name that reads as a version, as release tags are named (`v2`, `v2.0.0`, `1.4.2`, `desktop-v0.1.1`). */
const TAG_LIKE = /(^|[-_/])v\d+$|(^|[-_/])v?\d+\.\d+/i;

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

const CONFIG_GET_FLAGS = new Set(["--all", "--regexp", "--fixed-value", "-z", "--null", "--name-only", "--show-origin", "--show-scope", "--show-names", "--bool", "--int", "--bool-or-int", "--bool-or-str", "--path", "--expiry-date", "--includes", "--no-includes", "--local", "--worktree"]);

const CONFIG_GET_VALUES = new Set(["--value", "--url", "--type", "-t", "--default", "--file", "-f", "--blob"]);

/** Whether a git config only reads: every option is one that reads, and it asks for a setting (`--get`, a name alone, or
 *  git's own `get` and `list`). `--edit`, `--unset`, `--remove-section` and the like change the settings, which can name a
 *  program git runs later. */
function configReads(args: string[], rest: string[]): boolean {
  // git's own `get` (2.46 and later) has options of its own, read from `git config get -h` (2.54): `--regexp` takes no value
  // there, the name it reads is a pattern (item 120)
  if (rest[0] === "get") {
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (!w.startsWith("-") || w === "-") continue;
      if (CONFIG_GET_FLAGS.has(w)) continue;
      if (CONFIG_GET_VALUES.has(w.split("=")[0])) {
        if (!w.includes("=") && takesWord(args[i + 1])) i++;
        continue;
      }
      return false;
    }
    return true;
  }
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

/** A commit named from another, as git reads a word before `--`: `HEAD~5`, `main^`, `@~2`, `kit/x~1^2`, `HEAD@{1}~2`. It is no
 *  path, so it is not read as a Windows short file name (item 120); a short name (`PACKAG~1.JSO`) has more of the name after
 *  its `~1`, and a path from a root, the home folder or a dot is never one. */
const GIT_REV = /^[A-Za-z0-9@][\w@{}./-]*?(?:[~^]\d*)+$/;

export function git(words: string[], where: Where): Verdict {
  const r = gitStep(words, where);
  const end = words.indexOf("--");
  const revs = words.flatMap((w, i) => (i > 0 && (end < 0 || i < end) && GIT_REV.test(w) ? [i] : []));
  return revs.length ? { ...r, text: new Set([...(r.text ?? []), ...revs]) } : r;
}

function gitStep(words: string[], where: Where): Verdict {
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
    case "commit": {
      // the file a message or a template is read from (`-F`, `--file`, `-t`) is a path like any other: a key read into a
      // message would leave with the next push, and no read of the folder sees it (item 120)
      const text = textAfter(words, ["-m", "--message", "--author", "--date", "-C", "-c", "--fixup", "--squash"]);
      const fromFile = args.some((w, k) => !text.has(head + k) && ["-F", "-t", "--file", "--template"].some((o) => isOpt(w, o, "mFCct")));
      return v("change", say("kit.say.commit"), head, { saves: true, text, ...(fromFile ? { fromFile: true as const } : {}) });
    }
    case "switch":
      // `-C` makes a branch of that name again where it is told, its commits lost as a reset loses them (item 120)
      if (has(args, "--force", "-f", "--discard-changes", "-C", "--force-create")) return moving(del(say("kit.say.discard")));
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
      if (["rebase", "init", "clone"].includes(sub)) return moving(r);
      // staging what the folder holds, or moving a tracked file, saves nothing a read of the folder does not see; with
      // `--force` git adds a file it ignores, which no read of the folder shows (item 120)
      if ((sub === "add" && !has(args, "-f", "--force")) || sub === "mv") return { ...r, staged: true };
      return r;
    }
    case "checkout": {
      if (has(args, "--force", "-f", "-B")) return moving(del(say("kit.say.discard")));
      if (hasExactly(args, "-b", "--orphan")) return moving(change());
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
      return { ...(hasExactly(args, "--cached") ? change() : del()), staged: true };
    case "gc":
    case "prune":
    case "filter-branch":
    case "filter-repo":
      return del();
    case "update-ref": {
      // it sets a ref to any commit: the branch checked out, or another, moved back as `reset --hard` would (item 120)
      if (has(args, "-d")) return moving(del());
      const ref = rest[0] ?? "";
      return { ...moving(del(say("kit.say.discard"))), ...(ref.startsWith("refs/tags/") ? { tags: [ref.slice("refs/tags/".length)] } : {}) };
    }
    case "branch":
      if (has(args, "-d", "-D", "--delete")) return del();
      // a branch moved to another commit, or another renamed or copied over it, loses its commits as a reset does (item 120)
      if (has(args, "-f", "--force", "-M", "-C")) return moving(del(say("kit.say.discard")));
      // a branch made, moved, renamed or given another upstream: a rename of the one checked out is what HEAD then names
      return onlyLists(args, "branch") ? history() : moving(change());
    case "tag": {
      if (has(args, "-d", "--delete")) return del();
      if (onlyLists(args, "tag")) return history();
      // the tag it makes, by its name, for a push of it later (item 120)
      const name = operands(words, head, new Set(["-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup"])).map((i) => words[i])[0];
      return { ...change(), text: textAfter(words, ["-m", "--message"]), ...(name ? { tags: [name] } : {}) };
    }
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
      // `add -B` makes the branch again where it is told, and `--force` checks out one already checked out elsewhere (item 120)
      if (rest[0] === "add" && has(args, "-B", "-f", "--force")) return moving(del(say("kit.say.discard")));
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
      // git's own `get` lists every setting a pattern matches with `--regexp`, and those for a link with `--url` (item 120)
      const lists =
        args.some((w) => ["--list", "-l", "--get-regexp", "--get-urlmatch"].includes(w)) || ["list", "get-regexp"].includes(rest[0] ?? "") || (rest[0] === "get" && has(args, "--regexp", "--url"));
      if (!scoped && (lists || rest.some((w) => /token|passw|secret|auth|credential|cookie|private|extraheader/i.test(w)))) return thisMac();
      // a setting can name a program git runs later (an alias, a pager, a hook folder), so changing one is never a safe step
      return configReads(args, rest) ? history() : unknownProgram("git");
    }
    case "push":
      return { ...push(words, head, where), sends: true };
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
  const tags = where.tags ?? [];
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
    // a tag (item 120): by its namespace, by a name that reads as a version (`v2.0.0`, `desktop-v0.1.1`), or one the line
    // or the session made; a tag's push commonly starts a release
    if (name.startsWith("tags/") || TAG_LIKE.test(name) || tags.includes(name)) return "";
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
