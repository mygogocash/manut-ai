// Source control (item 75): what the shell says about git, gh and glab (src-tauri/src/source_tools.rs), what a pull of a project's
// default branch did (git_pull.rs), and the asks that put a lane up for review and merge its pull request (review.rs). Each answer
// is read here before it is believed, as the lanes' answers are (laneBranch.ts): a field that is not what the shell sends reads as
// nothing, never as a guess.

/** One account a CLI is signed in to: its name, its host when it is not the usual one ("" for github.com and gitlab.com). */
export interface SourceAccount {
  name: string;
  host: string;
  active: boolean;
}

/** One program on Settings › Source control. `signedIn` is null for git, which has no sign-in. */
export interface SourceTool {
  installed: boolean;
  version: string;
  signedIn: boolean | null;
  accounts: SourceAccount[];
}

export interface SourceTools {
  git: SourceTool;
  github: SourceTool;
  gitlab: SourceTool;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const MISSING: SourceTool = { installed: false, version: "", signedIn: null, accounts: [] };

function readTool(v: unknown, cli: boolean): SourceTool {
  if (!isObj(v)) return { ...MISSING, signedIn: cli ? false : null };
  const accounts = Array.isArray(v.accounts)
    ? v.accounts.flatMap((a) => (isObj(a) && str(a.name) ? [{ name: str(a.name), host: str(a.host), active: a.active === true }] : []))
    : [];
  return {
    installed: v.installed === true,
    // only a version's digits and dots are shown
    version: /^\d+(\.\d+)+$/.test(str(v.version)) ? str(v.version) : "",
    signedIn: cli ? v.signed_in === true : null,
    accounts: cli ? accounts : [],
  };
}

/** The shell's `source_tools` answer, read field by field. */
export function readTools(v: unknown): SourceTools {
  const o = isObj(v) ? v : {};
  return { git: readTool(o.git, false), github: readTool(o.github, true), gitlab: readTool(o.gitlab, true) };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** What a pull of a project's default branch did (`source_pull`, src-tauri/src/git_pull.rs). `why` is the shell's code: `pulled`
 *  and `current` mean it is up to date; every other one says why nothing was done. */
export interface Pulled {
  done: boolean;
  why: PullCode;
  branch: string;
  remote: string;
  /** Short commit ids before and after, and how many commits came. */
  from: string;
  to: string;
  count: number;
  /** `config`'s own: the setting of the project's own git config that stopped it, as git names it. */
  setting: string;
}

/** The codes `source_pull` answers, each with words of its own (`pull.why.<code>`). */
export const PULL_CODES = ["pulled", "current", "not_a_repository", "lane", "git_missing", "config", "busy", "detached", "no_upstream", "not_default", "submodules", "unread", "changes", "ahead", "fetch_failed", "diverged", "failed"] as const;
export type PullCode = (typeof PULL_CODES)[number];

/** The shell's answer, or null for one that is not a pull's. */
export function readPulled(v: unknown): Pulled | null {
  if (!isObj(v)) return null;
  const why = PULL_CODES.find((c) => c === v.why);
  if (!why) return null;
  return { done: v.done === true && why === "pulled", why, branch: str(v.branch), remote: str(v.remote), from: str(v.from), to: str(v.to), count: num(v.count), setting: str(v.setting) };
}

/** What a lane would be put up with (`review_draft`): its branch, base, and its commits' subjects, newest first. */
export interface ReviewDraft {
  branch: string;
  base: string;
  commits: string[];
  count: number;
}

export function readDraft(v: unknown): ReviewDraft | null {
  if (!isObj(v) || !str(v.branch)) return null;
  return { branch: str(v.branch), base: str(v.base), commits: Array.isArray(v.commits) ? v.commits.filter((c): c is string => typeof c === "string") : [], count: num(v.count) };
}

/** How a pull request is merged: a merge commit, one squashed commit, or the commits rebased onto the base. */
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The shell's ask (src-tauri/src/review.rs `Ask`): to push a lane's branch and open its pull request (`open`), or to merge it
 *  (`merge`). Every text in it is what will be sent; the page shows it as it is. */
export interface ReviewAsk {
  id: string;
  kind: "open" | "merge";
  source: "github" | "gitlab";
  repo: string;
  remote: string;
  /** A merge's own: the repository the pull request's branch is in, as the host says it (the shell asks only for this
   *  repository's own branch, never a fork's with the same name). */
  from: string;
  branch: string;
  base: string;
  head: string;
  commits: number;
  uncommitted: number;
  title: string;
  body: string;
  /** A merge's own: the pull request, the method, and the message's subject and body exactly as they will be sent ("" for a
   *  rebase, which makes none). */
  number: number;
  url: string;
  method: MergeMethod | "";
  subject: string;
  message: string;
  /** How many agent credit lines were taken out of the message (Settings › Source control › Remove agent credits). */
  dropped: number;
}

export function readAsk(v: unknown): ReviewAsk | null {
  if (!isObj(v) || !/^[0-9a-f]{32}$/.test(str(v.id)) || (v.kind !== "open" && v.kind !== "merge")) return null;
  const source = v.source === "github" || v.source === "gitlab" ? v.source : null;
  if (!source || !str(v.repo) || !str(v.branch) || !str(v.base) || typeof v.title !== "string" || typeof v.body !== "string") return null;
  const method = MERGE_METHODS.find((m) => m === v.method) ?? "";
  // a merge's ask always says where the pull request comes from and at which commit; one that does not is not shown
  if (v.kind === "merge" && (!method || num(v.number) === 0 || !str(v.from) || !/^[0-9a-f]{40,64}$/.test(str(v.head)))) return null;
  const url = str(v.url);
  return {
    id: str(v.id),
    kind: v.kind,
    source,
    repo: str(v.repo),
    remote: str(v.remote),
    from: str(v.from),
    branch: str(v.branch),
    base: str(v.base),
    head: str(v.head),
    commits: num(v.commits),
    uncommitted: num(v.uncommitted),
    title: v.title,
    body: v.body,
    number: num(v.number),
    url: /^https:\/\/\S+$/.test(url) ? url : "",
    method,
    subject: str(v.subject),
    message: str(v.message),
    dropped: num(v.dropped),
  };
}

/** What a settled ask did (`review_settle`): `declined` (nothing ran), `opened`, `merged`, or `failed` at `step` (`check`, `push`,
 *  `create`, `merge`) with the CLI's own line. `pushed`: the branch reached the remote. */
export interface ReviewDone {
  outcome: "declined" | "opened" | "merged" | "failed";
  pushed: boolean;
  url: string;
  number: number;
  step: string;
  error: string;
}

export function readDone(v: unknown): ReviewDone | null {
  if (!isObj(v)) return null;
  const outcome = v.outcome === "declined" || v.outcome === "opened" || v.outcome === "merged" || v.outcome === "failed" ? v.outcome : null;
  if (!outcome) return null;
  const url = str(v.url);
  return { outcome, pushed: v.pushed === true, url: /^https:\/\/\S+$/.test(url) ? url : "", number: num(v.number), step: str(v.step), error: str(v.error) };
}
