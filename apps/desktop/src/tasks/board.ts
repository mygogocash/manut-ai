// Tasks › Pull requests (item 100): the open requests of every project the person has, one list, sorted by how ready each is
// to merge. The shell reads each repository's list (src-tauri/src/pulls.rs) through the person's own `gh` or `glab`; this file
// knows which repositories (each project folder's remote, once), the order, and when to read again.
//
// The order, readiest first: approved (or asking for no review) with its checks green and no conflict; then checks still
// running; then a review still needed; then changes asked; then checks failing; then a conflict with its base; then drafts. In
// each, the most recently changed first. A request that is several of these is put by the first that holds of: draft, conflict,
// changes asked, checks failing, checks running, review needed.
//
// When it reads: once when the list is shown, then at most once a minute while it is shown and the window is in front, and never
// while it is hidden; coming back reads at once only when the last read is a minute old. The shell answers a list it read within
// the minute without asking the host, and (item 100's part 3) asks GitHub whether a list changed before reading it again.
//
// Whatever is read is also noted for the lanes' rows (pulls.ts `notePulls`), so a lane's pull request shows from the same read.
//
// A project on Azure DevOps, or on a Gitea or Forgejo server (item 100b), is listed too, read only, when its host's CLI is here: the
// shell reads the folder's remote and the list (src-tauri/src/pulls_other.rs); a host whose CLI is not here gives nothing.
import { t, type Key } from "../i18n";
import type { TaskHost } from "./host";
import { notePulls, remoteOf } from "./pulls";
import type { CliSource, OtherHost, OtherRemote, PullRow, TaskChecks } from "./types";

export type Readiness = "ready" | "checks" | "review" | "changes" | "failing" | "conflict" | "draft";
/** The order the list shows them in. */
export const READINESS: readonly Readiness[] = ["ready", "checks", "review", "changes", "failing", "conflict", "draft"];

/** How ready request `p` is to merge (see the top of this file). */
export function readiness(p: Pick<PullRow, "state" | "conflict" | "review" | "checks">): Readiness {
  if (p.state === "draft") return "draft";
  if (p.conflict) return "conflict";
  if (p.review === "changes") return "changes";
  if (p.checks && p.checks.failed > 0) return "failing";
  if (p.checks && p.checks.pending > 0) return "checks";
  if (p.review === "required") return "review";
  return "ready";
}

/** The checks of a request in words, and the meaning its colour carries: a row of the list, and the lane's top bar beside its Merge
 *  (item 167e), say them alike. */
export function checksWord(p: { checks?: TaskChecks | null }): { text: string; tone: "ok" | "fail" | "run" | "none" } {
  const c = p.checks;
  if (!c || c.total === 0) return { text: t("prs.checks.none"), tone: "none" };
  if (c.failed > 0) return { text: t("prs.checks.failing", { n: c.failed }), tone: "fail" };
  if (c.pending > 0) return { text: t("prs.checks.running", { n: c.pending }), tone: "run" };
  return { text: t("prs.checks.passed"), tone: "ok" };
}

/** The review of a request in words ("" when none is asked, or the list did not say). */
export const reviewWord = (p: { review?: PullRow["review"] }): string => (p.review ? t(`prs.review.${p.review}` as Key) : "");

/** A request on the list, with the repository it is in and the project folder it was listed for. */
export interface BoardRow {
  source: CliSource;
  repo: string;
  folder: string;
  pull: PullRow;
}

/** A request on another host's list (item 100b): read only, with the host as the row names it and the project folder it is of. */
export interface OtherRow extends OtherRemote {
  folder: string;
  pull: PullRow;
}

/** `rows` readiest first, then the most recently changed, then by repository and number so the order never jumps. */
export function sortRows<T extends Pick<BoardRow, "repo" | "pull">>(rows: readonly T[]): T[] {
  const rank = (r: Pick<BoardRow, "pull">) => READINESS.indexOf(readiness(r.pull));
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.pull.updated || b.pull.created) - (a.pull.updated || a.pull.created) || a.repo.localeCompare(b.repo) || a.pull.number - b.pull.number);
}

/** A list is read again no sooner than this. */
export const REFRESH_MS = 60_000;

/** Whether to read again now: shown, and never read or last read a minute ago. */
export const due = (last: number | null, now: number, visible: boolean): boolean => visible && (last === null || now - last >= REFRESH_MS);

export interface BoardState {
  rows: BoardRow[];
  /** Other hosts' requests (item 100b), read only, in the same order. */
  others: OtherRow[];
  /** The repositories whose list failed, with the shell's line. */
  errors: { source: CliSource | OtherHost; repo: string; error: string }[];
  /** The projects' repositories, once read (null: not yet). */
  repos: { source: CliSource; repo: string; folder: string }[] | null;
  /** The projects' repositories on other hosts whose CLI is here (none until read). */
  otherRepos: (OtherRemote & { folder: string })[];
  /** Each project folder's repository, `<source>:<repo>` (lower case), for telling a lane's request by its folder. */
  folders: Record<string, string>;
  loading: boolean;
  /** When the lists were last read (ms), or null. */
  at: number | null;
}

const EMPTY: BoardState = { rows: [], others: [], errors: [], repos: null, otherRepos: [], folders: {}, loading: false, at: null };

/** A repository as `BoardState.folders` names it. */
export const repoKey = (source: CliSource, repo: string): string => `${source}:${repo.toLowerCase()}`;

/** The list of every project's open requests, and when to read it again. It uses the host it is given and keeps nothing on disk. */
export class BoardWatch {
  private state: BoardState = EMPTY;
  private listeners = new Set<() => void>();
  private projects: string[] = [];
  private reading: Promise<void> | null = null;
  private gen = 0;

  constructor(
    private host: TaskHost,
    private visible: () => boolean,
    private now: () => number = Date.now,
  ) {}

  get = (): BoardState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  private set(patch: Partial<BoardState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** The projects shown changed: their repositories are found again and the list read. */
  async setProjects(projects: readonly string[]): Promise<void> {
    const next = [...new Set(projects.filter(Boolean))];
    if (next.join("\n") === this.projects.join("\n") && this.state.repos !== null) return;
    this.projects = next;
    const gen = ++this.gen;
    // a folder whose remote is not on GitHub or GitLab is asked of the other hosts' reader, which answers only when that host's CLI
    // is here
    const otherOf = this.host.otherRemote?.bind(this.host);
    const found = await Promise.all(
      next.map(async (folder) => {
        const remote = await remoteOf(this.host, folder);
        const other = remote || !otherOf ? null : await otherOf(folder).catch(() => null);
        return { folder, remote, other };
      }),
    );
    if (gen !== this.gen) return;
    const seen = new Set<string>();
    const repos: BoardState["repos"] = [];
    const otherRepos: BoardState["otherRepos"] = [];
    const folders: Record<string, string> = {};
    for (const { folder, remote, other } of found) {
      if (other) {
        const key = `${other.host}:${other.name}:${other.repo}`.toLowerCase();
        if (!seen.has(key)) otherRepos.push({ ...other, folder });
        seen.add(key);
      }
      if (!remote) continue;
      const key = repoKey(remote.source, remote.repo);
      folders[folder] = key;
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push({ source: remote.source, repo: remote.repo, folder });
    }
    this.set({ repos, otherRepos, folders });
    await this.read();
  }

  /** Reads now when it is due (the minute's timer, the window coming back). */
  tick(): Promise<void> {
    return due(this.state.at, this.now(), this.visible()) ? this.read() : Promise.resolve();
  }

  /** Reads every repository's list now (one read at a time: a second ask while one runs waits for it). */
  read(): Promise<void> {
    if (this.reading) return this.reading;
    const repos = this.state.repos ?? [];
    const board = this.host.board?.bind(this.host);
    if (!board) return Promise.resolve();
    const otherBoard = this.host.otherBoard?.bind(this.host);
    this.set({ loading: true });
    this.reading = (async () => {
      const at = this.now();
      const rows: BoardRow[] = [];
      const others: OtherRow[] = [];
      const errors: BoardState["errors"] = [];
      await Promise.all([
        ...repos.map(async (r) => {
          try {
            const b = await board(r.source, r.repo);
            for (const pull of b.items) rows.push({ ...r, pull });
            notePulls(r.source, r.repo, b.items, at, !b.more);
          } catch (e) {
            errors.push({ source: r.source, repo: r.repo, error: e instanceof Error ? e.message : String(e) });
          }
        }),
        ...(otherBoard ? this.state.otherRepos : []).map(async (r) => {
          try {
            const b = await otherBoard!(r.folder);
            // the shell reads the folder again: a list of another repository than the one found is not shown
            if (b && b.host === r.host && b.repo === r.repo) for (const pull of b.items) others.push({ host: r.host, name: r.name, repo: r.repo, folder: r.folder, pull });
          } catch (e) {
            errors.push({ source: r.host, repo: r.repo, error: e instanceof Error ? e.message : String(e) });
          }
        }),
      ]);
      this.set({ rows: sortRows(rows), others: sortRows(others), errors, loading: false, at });
    })().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }
}

/** The row of request `number` of `repo`, if the list has it. */
export const rowOf = (rows: readonly BoardRow[], source: CliSource, repo: string, number: number): BoardRow | undefined =>
  rows.find((r) => r.source === source && r.repo.toLowerCase() === repo.toLowerCase() && r.pull.number === number);
