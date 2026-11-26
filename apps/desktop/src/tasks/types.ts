// Tasks (the sidebar's Tasks row and the Tasks page): the shapes the desktop shell's `tasks_*` commands answer
// (src-tauri/src/tasks.rs), and the words the page sends. Read-only (BOUNDARY rule 33).
//
// The idea and the page's shape come from Orca's Tasks (stablyai/orca, MIT License, Copyright (c) 2026 Lovecast Inc.).

export type TaskSource = "github" | "gitlab" | "linear";
/** The sources the shell lists through a CLI. */
export type CliSource = Exclude<TaskSource, "linear">;
export type TaskKind = "issues" | "prs";
export type TaskFilter = "assigned" | "created" | "mentioned" | "open";

/** The sources the page offers. Linear is not among them: Oh My Hermes reached it through a Linear MCP server set
 *  up in a bot's Hermes (`hermes mcp install linear`), which Manut AI does not have. Its type and view stay for a
 *  runtime that brings its own Linear link. */
export const SOURCES: readonly TaskSource[] = ["github", "gitlab"];
export const FILTERS: readonly TaskFilter[] = ["open", "assigned", "created", "mentioned"];
export const KINDS: readonly TaskKind[] = ["issues", "prs"];
/** Rows a page shows (tasks.rs PAGE). */
export const PAGE = 25;

export interface TaskLabel {
  name: string;
  /** `rrggbb`, or "" */
  color: string;
}

export interface TaskChecks {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export interface TaskItem {
  number: number;
  title: string;
  state: "open" | "closed" | "merged" | "draft";
  url: string;
  labels: TaskLabel[];
  author: string;
  /** seconds since the epoch (0: unknown) */
  created: number;
  updated: number;
  checks: TaskChecks | null;
  /** The branch a pull / merge request is made from ("" or absent for an issue and for a shell older than this field). */
  head?: string;
  /** Whether the host says that branch is in this very repository: false or absent for a fork's request (anyone can open one on
   *  a branch named like a lane's) and when it did not say. Only a request with this true can stand for a lane's. */
  same?: boolean;
  /** The repository the branch is in, `owner/repo`, when the host named it. */
  from?: string;
}

export interface TaskComment {
  author: string;
  body: string;
  created: number;
}

export interface TaskCheck {
  name: string;
  state: "passed" | "failed" | "pending" | "skipped";
  url: string;
}

export interface TaskDetail {
  item: TaskItem;
  body: string;
  comments: TaskComment[];
  checks: TaskCheck[];
}

export interface TaskPage {
  items: TaskItem[];
  more: boolean;
}

export interface CliStatus {
  installed: boolean;
  signed_in: boolean;
}

export interface TaskRemote {
  source: CliSource;
  repo: string;
}

/** The same check the shell makes (tasks.rs check_repo), so the page refuses a name before it asks. */
export function repoOk(source: CliSource, repo: string): boolean {
  const parts = repo.split("/");
  const n = source === "github" ? parts.length === 2 : parts.length >= 2 && parts.length <= 6;
  return n && parts.every((p) => /^[A-Za-z0-9._-]{1,100}$/.test(p) && !p.startsWith("-") && !p.startsWith("."));
}

// ---- Tasks › Pull requests (item 100): the open requests of the person's projects, by how ready each is to merge ----------
// (src-tauri/src/pulls.rs)

/** A request as the Pull requests list shows it: Tasks' row and what its readiness is read from. */
export interface PullRow extends TaskItem {
  /** `approved`, `changes` (changes asked), `required` (a review is still needed), or "" (none asked, or the host did not say) */
  review: "approved" | "changes" | "required" | "";
  /** the host says the branch conflicts with its base */
  conflict: boolean;
  /** the branch it would merge into */
  base: string;
}

export interface PullBoard {
  items: PullRow[];
  more: boolean;
  /** when the list was last read or confirmed by the host, in seconds since 1970 */
  at: number;
}

export interface FileCount {
  path: string;
  additions: number;
  deletions: number;
}

/** One request opened in the app: its description as plain text, its checks, and its changed files and counts (null: the
 *  host did not say). */
export interface PullDetail {
  pull: PullRow;
  body: string;
  checks: TaskCheck[];
  files: FileCount[];
  additions: number | null;
  deletions: number | null;
  changed: number | null;
}

/** A host listed read only (item 100b, src-tauri/src/pulls_other.rs): Azure DevOps through `az`, a Gitea or Forgejo server through
 *  `gt`. Nothing is merged or written there from the app. */
export type OtherHost = "azure" | "gitea";

/** A project's repository on such a host: what the row calls the host ("Azure DevOps", or the server's own name) and the repository
 *  as a person reads it. */
export interface OtherRemote {
  host: OtherHost;
  name: string;
  repo: string;
}

/** Such a repository's open requests, read through the host's own CLI. */
export interface OtherBoard extends OtherRemote, PullBoard {}

/** The merge methods a repository allows; `read`: the host said (else all three, and the host refuses one it does not allow). */
export interface MergeMethods {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
  read: boolean;
}

// ---- Tasks › 나 (Me): my pull requests, reviews, issues and mentions across repositories, per GitHub account --------
// (src-tauri/src/gh_me.rs)

/** A GitHub account gh is signed in to (`gh auth status --json hosts`: these fields only, never a token). */
export interface GhAccount {
  host: string;
  login: string;
  /** gh's active account on its host */
  active: boolean;
  /** `success`, else it must sign in again */
  state: string;
  scopes: string[];
}

export interface GhAccounts {
  installed: boolean;
  accounts: GhAccount[];
}

/** A GitHub account the person chose in manut (Settings › Accounts › GitHub): its host, login and colour. */
export interface ChosenAccount {
  host: string;
  login: string;
  /** one of ACCOUNT_COLORS */
  color: string;
}

export type MeSection = "review" | "authored" | "assigned" | "mentions";
/** The sections, in the order the page shows them. */
export const ME_SECTIONS: readonly MeSection[] = ["review", "authored", "assigned", "mentions"];

export interface MeItem {
  /** `owner/repo` */
  repo: string;
  number: number;
  title: string;
  url: string;
  pr: boolean;
  draft: boolean;
  state: "open" | "closed" | "merged" | "draft";
  author: string;
  labels: TaskLabel[];
  created: number;
  updated: number;
  /** my review is asked for */
  asked: boolean;
  ci: "" | "passed" | "failed" | "pending";
  review: "" | "approved" | "changes" | "required";
  conflict: boolean;
  /** when my review was asked for (0: unknown) */
  requested: number;
}

export interface MePage {
  items: MeItem[];
  more: boolean;
}

/** Why an account's list failed: `rate` (GitHub's rate limit: try again soon), `auth` (sign in again), `other`. */
export type MeFailKind = "rate" | "auth" | "other";

/** `<login>@<host>`: the id the page sends for an account. */
export const accountId = (a: { login: string; host: string }) => `${a.login}@${a.host}`;

/** The same check the shell makes (gh_me.rs parse_account_id). */
export function accountIdOk(id: string): boolean {
  const at = id.indexOf("@");
  if (at < 1 || id.indexOf("@", at + 1) >= 0) return false;
  const login = id.slice(0, at);
  const host = id.slice(at + 1);
  const hostOk = host.length <= 253 && host.split(".").length >= 2 && host.split(".").every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p));
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(login) && hostOk;
}
