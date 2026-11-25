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
}

/** The codes `source_pull` answers, each with words of its own (`pull.why.<code>`). */
export const PULL_CODES = ["pulled", "current", "not_a_repository", "lane", "git_missing", "busy", "detached", "no_upstream", "not_default", "unread", "changes", "ahead", "fetch_failed", "diverged", "failed"] as const;
export type PullCode = (typeof PULL_CODES)[number];

/** The shell's answer, or null for one that is not a pull's. */
export function readPulled(v: unknown): Pulled | null {
  if (!isObj(v)) return null;
  const why = PULL_CODES.find((c) => c === v.why);
  if (!why) return null;
  return { done: v.done === true && why === "pulled", why, branch: str(v.branch), remote: str(v.remote), from: str(v.from), to: str(v.to), count: num(v.count) };
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

/** The shell's ask (src-tauri/src/review.rs `Ask`): to push a lane's branch and open its pull request (`open`). Every text in it
 *  is what will be sent; the page shows it as it is. */
export interface ReviewAsk {
  id: string;
  kind: "open";
  source: "github" | "gitlab";
  repo: string;
  remote: string;
  branch: string;
  base: string;
  head: string;
  commits: number;
  uncommitted: number;
  title: string;
  body: string;
}

export function readAsk(v: unknown): ReviewAsk | null {
  if (!isObj(v) || !/^[0-9a-f]{32}$/.test(str(v.id)) || v.kind !== "open") return null;
  const source = v.source === "github" || v.source === "gitlab" ? v.source : null;
  if (!source || !str(v.repo) || !str(v.branch) || !str(v.base) || typeof v.title !== "string" || typeof v.body !== "string") return null;
  return { id: str(v.id), kind: "open", source, repo: str(v.repo), remote: str(v.remote), branch: str(v.branch), base: str(v.base), head: str(v.head), commits: num(v.commits), uncommitted: num(v.uncommitted), title: v.title, body: v.body };
}

/** What a settled ask did (`review_settle`): `declined` (nothing ran), `opened`, or `failed` at `step` (`check`, `push`,
 *  `create`) with the CLI's own line. `pushed`: the branch reached the remote. */
export interface ReviewDone {
  outcome: "declined" | "opened" | "failed";
  pushed: boolean;
  url: string;
  number: number;
  step: string;
  error: string;
}

export function readDone(v: unknown): ReviewDone | null {
  if (!isObj(v)) return null;
  const outcome = v.outcome === "declined" || v.outcome === "opened" || v.outcome === "failed" ? v.outcome : null;
  if (!outcome) return null;
  const url = str(v.url);
  return { outcome, pushed: v.pushed === true, url: /^https:\/\/\S+$/.test(url) ? url : "", number: num(v.number), step: str(v.step), error: str(v.error) };
}
