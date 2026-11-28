// The line under a lane's row that says how far its branch is from its remote (item 146): "2 ahead of origin/kit/x", "1 behind",
// both, "Level with", or for a branch no remote has "3 not pushed yet". It is quiet text with the way it was counted in its tooltip
// (nothing is fetched, so the remote's side is as of the last fetch or push), and says nothing when there is nothing to say.
// `LaneSyncView` takes the counts as props and uses no hooks, so a test can draw it; `LaneSync` reads them (useLaneRemote.ts).
import { t } from "../i18n";
import { syncWords, type LaneRemote } from "./laneRemote";
import { useLaneRemote } from "./useLaneRemote";

export function LaneSyncView({ remote }: { remote: LaneRemote }) {
  const say = syncWords(remote);
  if (!say) return null;
  return (
    <p className="mut lline lsync" title={t("lane.sync.tip")} data-testid="lane-sync" data-ahead={remote.ahead} data-behind={remote.behind} data-remote={remote.upstream ?? ""}>
      {t(say.key, say.vars)}
    </p>
  );
}

/** `worktree`: the lane's own folder, where the counts are read. `mark`: a short text that changes when the lane did something, so
 *  its commits are counted again. */
export function LaneSync({ worktree, mark }: { worktree: string; mark: string }) {
  const remote = useLaneRemote(worktree, mark);
  return remote ? <LaneSyncView remote={remote} /> : null;
}
