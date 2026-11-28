// How far a lane's branch is from its remote, read again while the Code page is open (item 146; laneSync.ts). One read is a few
// `git` calls in the lane's own folder (src-tauri/src/lane_remote.rs) that only look at what git already holds, so it is made when
// the row appears, when the window is looked at again, when `mark` says the lane did something (its turn ended, it was settled) and
// once a minute, as the main-moved note is (useMoved.ts), and never while one is still running. A read that fails keeps what was
// shown: git not answering is no reason to say a branch is level with its remote.
import { useEffect, useRef, useState } from "react";
import { getHost } from "../sessions/host";
import type { LaneRemote, ReadsLaneRemote } from "./laneRemote";

/** How often a lane's remote is read again while the page stays open. */
export const SYNC_POLL_MS = 60_000;

/** The lane `worktree`'s counts against its remote, or null before the first read and on a host that cannot read a folder. */
export function useLaneRemote(worktree: string | null, mark: string, host: Partial<ReadsLaneRemote> = getHost()): LaneRemote | null {
  const [got, setGot] = useState<{ worktree: string; remote: LaneRemote } | null>(null);
  const poke = useRef<() => void>(() => undefined);
  useEffect(() => {
    setGot(null);
    poke.current = () => undefined;
    if (!worktree || !host.laneRemote) return;
    let live = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const remote = await host.laneRemote?.(worktree);
        if (live && remote) setGot({ worktree, remote });
      } catch {
        /* keep what was shown */
      } finally {
        busy = false;
      }
    };
    // `read` keeps its own errors; the timer and the focus only start it
    const again = () => void read();
    poke.current = again;
    again();
    const timer = setInterval(again, SYNC_POLL_MS);
    window.addEventListener("focus", again);
    return () => {
      live = false;
      poke.current = () => undefined;
      clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [worktree, host]);
  // the lane did something: read again (the first run of this effect is the open, which the one above already started)
  useEffect(() => {
    poke.current();
  }, [mark]);
  return got && got.worktree === worktree ? got.remote : null;
}
