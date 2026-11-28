// The pull request on a lane's row (item 76). A lane's branch is matched to the open pull / merge requests the app already lists
// for its repository, so a row can say "#12 Open" quietly and open it in Tasks, where pull requests already are.
//
// Where the list comes from, and why it costs nothing per row:
//  - The Tasks page notes every pull request list it reads (`notePulls`), so what a person has looked at there is known here.
//  - The Code page reads the repository's open pull requests itself only when the cache holds none for it or the last read is older
//    than `PULLS_MAX_AGE`: one call for the whole repository (`pulls_board`, the Pull requests list's own read, since item 167e;
//    `tasks_list` where the host has no such read), never one for a lane, and never on a timer (it runs when the page shows a lane
//    with a branch of its own and the cache is stale; a failed read is not tried again within the same time). Nothing is written
//    to GitHub or GitLab; the call is one Tasks makes.
// The cache lives in memory: a pull request's state is not something to show from last week.
//
// A request is known by the repository its branch is in and the branch's name, never the name alone (item 86): anyone can open a
// pull request from a fork on a branch named like a lane's (`kit/<words>`, public once pushed), and that request must never stand
// for the lane's, on its row or behind its Merge. Only a request the host says is from this very repository (`same`) is kept under
// this repository; any other is kept under its own, which no lane looks up.
import { useEffect, useState, useSyncExternalStore } from "react";
import { taskHost, type TaskHost } from "./host";
import type { CliSource, PullRow, TaskChecks, TaskItem, TaskRemote } from "./types";
import { changes } from "../lib/changes";

/** A pull request as a lane's row shows it. Only open and draft ones are listed: the list is of open requests. Its checks, its review
 *  and whether it conflicts are what the list it came from said (item 167e: the lane's top bar says them beside its Merge, as a row of
 *  Tasks › Pull requests does). Every list carries the checks; only the Pull requests list's own read (`board`, src-tauri/src/pulls.rs)
 *  carries the review and the conflict, so they are absent when the list did not say, never guessed. */
export interface LanePull {
  source: CliSource;
  repo: string;
  number: number;
  state: "open" | "draft";
  title: string;
  /** null: the list said nothing of its checks (a request the app noted itself as it opened it). */
  checks?: TaskChecks | null;
  review?: PullRow["review"];
  conflict?: boolean;
}

/** A list's row as `notePulls` reads it: Tasks' row, with the review and the conflict when it is the Pull requests list's. */
type ListedPull = TaskItem & Partial<Pick<PullRow, "review" | "conflict">>;

/** How long a read of a repository's pull requests is good for. */
export const PULLS_MAX_AGE = 5 * 60_000;

interface Known {
  at: number;
  /** By `<repository the branch is in>\n<branch>`. */
  byBranch: Map<string, LanePull>;
}
const known = new Map<string, Known>();
/** The branches of each repository whose pull request the host said merged (item 94): a list the app read showed it merged, or the
 *  app's own Merge finished. Only this repository's own branches: a fork's request on a branch of the same name never counts. Never
 *  guessed from a request that is simply no longer listed as open, which may have been closed. Of this run, as the cache is. */
const merged = new Map<string, Set<string>>();
/** When each repository was last asked for, by this module, whether it answered or not. */
const asked = new Map<string, number>();
const listeners = changes();
let version = 0;
const bump = () => {
  version++;
  listeners.emit();
};

const keyOf = (source: CliSource, repo: string) => `${source}:${repo}`;
/** Where a request's branch is, with its name: this repository's own only when the host said so. */
const branchKey = (repo: string, i: Pick<TaskItem, "same" | "from">, branch: string) => `${i.same === true ? repo : `other:${i.from ?? ""}`}\n${branch}`;

/** `items` (a list of pull requests the app just read for `repo`) into the cache. `whole`: the list is every open request of the
 *  repository's first page, so what it leaves out is no longer open; otherwise it is only added to what is known. */
export function notePulls(source: CliSource, repo: string, items: readonly ListedPull[], now: number, whole = false): void {
  const prev = known.get(keyOf(source, repo));
  const byBranch = whole || !prev ? new Map<string, LanePull>() : new Map(prev.byBranch);
  for (const i of items) {
    if (i.head && i.state === "merged" && i.same === true) noteMerged(source, repo, i.head);
    if (!i.head || (i.state !== "open" && i.state !== "draft")) continue;
    // two open requests from one branch of one repository: the newer (higher number) is the one the person means
    const key = branchKey(repo, i, i.head);
    const was = byBranch.get(key);
    if (!was || was.number < i.number)
      byBranch.set(key, {
        source,
        repo,
        number: i.number,
        state: i.state,
        title: i.title,
        checks: i.checks ?? null,
        ...(i.review !== undefined ? { review: i.review } : {}),
        ...(i.conflict !== undefined ? { conflict: i.conflict } : {}),
      });
  }
  known.set(keyOf(source, repo), { at: now, byBranch });
  bump();
}

/** Forgets pull request `number` of `repo` once the app merged it: it is no longer open, so the lane's row stops offering it before
 *  the next read of the list says so. */
export function dropPull(source: CliSource, repo: string, number: number): void {
  const k = known.get(keyOf(source, repo));
  if (!k) return;
  for (const [branch, p] of k.byBranch)
    if (p.number === number) {
      k.byBranch.delete(branch);
      // the app merged it, and the host said so: a branch of this repository's own is merged (item 94)
      if (branch.startsWith(`${repo}\n`)) noteMerged(source, repo, branch.slice(repo.length + 1));
    }
  bump();
}

function noteMerged(source: CliSource, repo: string, branch: string): void {
  const k = keyOf(source, repo);
  const set = merged.get(k) ?? new Set<string>();
  set.add(branch);
  merged.set(k, set);
}

/** Whether the host said a pull request from `branch` of `repo` itself merged (item 94). */
export const mergedFor = (source: CliSource, repo: string, branch: string): boolean => merged.get(keyOf(source, repo))?.has(branch) ?? false;

/** The open pull request made from `branch` of `repo` itself (never a fork's branch of the same name), or null. */
export function pullFor(source: CliSource, repo: string, branch: string): LanePull | null {
  return known.get(keyOf(source, repo))?.byBranch.get(branchKey(repo, { same: true }, branch)) ?? null;
}

/** Whether the Code page should read `repo`'s pull requests now: none are known (or they are old) and it has not asked within the
 *  same time. */
export function shouldRead(source: CliSource, repo: string, now: number): boolean {
  const k = keyOf(source, repo);
  const at = known.get(k)?.at ?? -Infinity;
  const tried = asked.get(k) ?? -Infinity;
  return now - at >= PULLS_MAX_AGE && now - tried >= PULLS_MAX_AGE;
}

/** Read the first page of `repo`'s open pull requests if `shouldRead` says so, and note them. Errors are not shown: a lane with no
 *  pull request on its row is what the person sees when gh is missing or signed out (Tasks says why). */
export async function readPulls(host: TaskHost, source: CliSource, repo: string, now: number): Promise<void> {
  if (!shouldRead(source, repo, now)) return;
  asked.set(keyOf(source, repo), now);
  try {
    // The Pull requests list's own read where the host has one (item 167e): the same open requests, each with its review and whether
    // it conflicts, which the lane's top bar says beside its Merge. One call for the repository either way, and GitHub answers an
    // unchanged list without counting it (pulls.rs). A host without it (an older stand-in) is read as before.
    const page = host.board ? await host.board(source, repo) : await host.list(source, repo, "prs", "open", 0);
    notePulls(source, repo, page.items, now, !page.more);
  } catch {
    /* gh or glab missing, signed out, offline: no pull request on the row */
  }
}

const remotes = new Map<string, Promise<TaskRemote | null>>();
/** The repository the folder `cwd` is a clone of (its `.git/config`), asked once per folder. */
export function remoteOf(host: Pick<TaskHost, "remote">, cwd: string): Promise<TaskRemote | null> {
  let p = remotes.get(cwd);
  if (!p) {
    p = host.remote(cwd).catch(() => null);
    remotes.set(cwd, p);
  }
  return p;
}

const subscribe = (l: () => void) => {
  return listeners.subscribe(l);
};

/** Re-renders when the cache learns anything (a chat's linked request reads its state from it, code/chatPull.ts). */
export function usePullsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** The pull request for each of `branches` of the project at `root`, by branch name. It reads the repository once when its cache is
 *  stale (see the top of this file) and follows the cache as the Tasks page fills it. */
export function usePullRequests(root: string, branches: readonly string[]): ReadonlyMap<string, LanePull> {
  return useLanePulls(root, branches).open;
}

/** `usePullRequests`, and which of `branches` the host said merged (item 94: a lane settles when its pull request merged). */
export function useLanePulls(root: string, branches: readonly string[]): { open: ReadonlyMap<string, LanePull>; merged: ReadonlySet<string> } {
  useSyncExternalStore(subscribe, () => version, () => version);
  const [remote, setRemote] = useState<TaskRemote | null>(null);
  const wanted = branches.length > 0;
  useEffect(() => {
    if (!root || !wanted) return;
    let live = true;
    const host = taskHost();
    void remoteOf(host, root).then(async (r) => {
      if (!live) return;
      setRemote(r);
      if (r) await readPulls(host, r.source, r.repo, Date.now());
    });
    return () => {
      live = false;
    };
  }, [root, wanted]);
  const out = new Map<string, LanePull>();
  const done = new Set<string>();
  if (remote)
    for (const b of branches) {
      const p = pullFor(remote.source, remote.repo, b);
      if (p) out.set(b, p);
      if (mergedFor(remote.source, remote.repo, b)) done.add(b);
    }
  return { open: out, merged: done };
}

/** Tests: start from nothing. */
export function resetPulls(): void {
  known.clear();
  merged.clear();
  asked.clear();
  remotes.clear();
  bump();
}
