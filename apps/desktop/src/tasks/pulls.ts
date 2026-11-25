// The pull request on a lane's row (item 76). A lane's branch is matched to the open pull / merge requests the app already lists
// for its repository, so a row can say "#12 Open" quietly and open it in Tasks, where pull requests already are.
//
// Where the list comes from, and why it costs nothing per row:
//  - The Tasks page notes every pull request list it reads (`notePulls`), so what a person has looked at there is known here.
//  - The Code page reads the repository's open pull requests itself only when the cache holds none for it or the last read is older
//    than `PULLS_MAX_AGE`: one `tasks_list` call for the whole repository, never one for a lane, and never on a timer (it runs
//    when the page shows a lane with a branch of its own and the cache is stale; a failed read is not tried again within the
//    same time). Nothing is written to GitHub or GitLab; the call is the one Tasks makes.
// The cache lives in memory: a pull request's state is not something to show from last week.
import { useEffect, useState, useSyncExternalStore } from "react";
import { taskHost, type TaskHost } from "./host";
import type { CliSource, TaskItem, TaskRemote } from "./types";

/** A pull request as a lane's row shows it. Only open and draft ones are listed: the list is of open requests. */
export interface LanePull {
  source: CliSource;
  repo: string;
  number: number;
  state: "open" | "draft";
  title: string;
}

/** How long a read of a repository's pull requests is good for. */
export const PULLS_MAX_AGE = 5 * 60_000;

interface Known {
  at: number;
  byBranch: Map<string, LanePull>;
}
const known = new Map<string, Known>();
/** When each repository was last asked for, by this module, whether it answered or not. */
const asked = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

const keyOf = (source: CliSource, repo: string) => `${source}:${repo}`;

/** `items` (a list of pull requests the app just read for `repo`) into the cache. `whole`: the list is every open request of the
 *  repository's first page, so what it leaves out is no longer open; otherwise it is only added to what is known. */
export function notePulls(source: CliSource, repo: string, items: readonly TaskItem[], now: number, whole = false): void {
  const prev = known.get(keyOf(source, repo));
  const byBranch = whole || !prev ? new Map<string, LanePull>() : new Map(prev.byBranch);
  for (const i of items) {
    if (!i.head || (i.state !== "open" && i.state !== "draft")) continue;
    // two open requests from one branch: the newer (higher number) is the one the person means
    const was = byBranch.get(i.head);
    if (!was || was.number < i.number) byBranch.set(i.head, { source, repo, number: i.number, state: i.state, title: i.title });
  }
  known.set(keyOf(source, repo), { at: now, byBranch });
  bump();
}

/** Forgets pull request `number` of `repo` once the app merged it: it is no longer open, so the lane's row stops offering it before
 *  the next read of the list says so. */
export function dropPull(source: CliSource, repo: string, number: number): void {
  const k = known.get(keyOf(source, repo));
  if (!k) return;
  for (const [branch, p] of k.byBranch) if (p.number === number) k.byBranch.delete(branch);
  bump();
}

/** The open pull request made from `branch` in `repo`, or null. */
export function pullFor(source: CliSource, repo: string, branch: string): LanePull | null {
  return known.get(keyOf(source, repo))?.byBranch.get(branch) ?? null;
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
    const page = await host.list(source, repo, "prs", "open", 0);
    notePulls(source, repo, page.items, now, !page.more);
  } catch {
    /* gh or glab missing, signed out, offline: no pull request on the row */
  }
}

const remotes = new Map<string, Promise<TaskRemote | null>>();
/** The repository the folder `cwd` is a clone of (its `.git/config`), asked once per folder. */
export function remoteOf(host: TaskHost, cwd: string): Promise<TaskRemote | null> {
  let p = remotes.get(cwd);
  if (!p) {
    p = host.remote(cwd).catch(() => null);
    remotes.set(cwd, p);
  }
  return p;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The pull request for each of `branches` of the project at `root`, by branch name. It reads the repository once when its cache is
 *  stale (see the top of this file) and follows the cache as the Tasks page fills it. */
export function usePullRequests(root: string, branches: readonly string[]): ReadonlyMap<string, LanePull> {
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
  if (remote) for (const b of branches) {
    const p = pullFor(remote.source, remote.repo, b);
    if (p) out.set(b, p);
  }
  return out;
}

/** Tests: start from nothing. */
export function resetPulls(): void {
  known.clear();
  asked.clear();
  remotes.clear();
  bump();
}
