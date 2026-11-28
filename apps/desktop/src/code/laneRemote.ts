// How far a lane's branch is from its remote, for the line under the lane's row (item 146; the shell's `lane_remote`,
// src-tauri/src/lane_remote.rs). The shell counts the commits the branch has that its remote branch lacks (ahead) and the commits
// the remote branch has that it lacks (behind), from what git already holds in the lane's folder: it fetches nothing, so behind is
// as of the last fetch or push. A branch with no copy on a remote has only the commits no remote branch holds. This turns the
// shell's answer into words; it reads nothing itself.
import type { Say } from "./command";

/** `upstream` is the remote branch the counts are against (`origin/kit/x`); none when the branch has no copy on a remote, and then
 *  `ahead` is the commits no remote branch holds and `behind` is 0. */
export interface LaneRemote {
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** The part of the sessions host this reads (`SessionHost.laneRemote`), so a test can stand in for it. null: this host cannot read a
 *  folder. A folder the app did not make, or one git cannot read, rejects. */
export interface ReadsLaneRemote {
  laneRemote(worktree: string): Promise<LaneRemote | null>;
}

/** The shell stops counting at 1,000 commits, so a count over this is shown as `999+`. */
export const COUNT_SHOWN = 999;

export const countText = (n: number): string => (n > COUNT_SHOWN ? `${COUNT_SHOWN}+` : String(n));

/** The shell's answer as a `LaneRemote`, or null when it is not one. A count that is not a whole number above zero is 0. */
export function readLaneRemote(raw: unknown): LaneRemote | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), COUNT_SHOWN + 1) : 0);
  return { upstream: typeof r.upstream === "string" && r.upstream ? r.upstream : null, ahead: count(r.ahead), behind: count(r.behind) };
}

/** What the row says, or null when there is nothing to say: a branch with no copy on a remote that holds nothing the remote
 *  lacks (a lane just made, or a repository with no remote). */
export function syncWords(r: LaneRemote): Say | null {
  if (!r.upstream) return r.ahead > 0 ? { key: "lane.sync.unpushed", vars: { n: countText(r.ahead) } } : null;
  const remote = r.upstream;
  if (r.ahead > 0 && r.behind > 0) return { key: "lane.sync.both", vars: { ahead: countText(r.ahead), behind: countText(r.behind), remote } };
  if (r.ahead > 0) return { key: "lane.sync.ahead", vars: { n: countText(r.ahead), remote } };
  if (r.behind > 0) return { key: "lane.sync.behind", vars: { n: countText(r.behind), remote } };
  return { key: "lane.sync.level", vars: { remote } };
}
