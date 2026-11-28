// The lane's folder as the Diff beside the lane reads it (laneFolder.ts): read when the lane opens, so the pane is not empty after a
// restart, when the chat's events say something may have changed (a change, a subagent's step, the turn's end), at most once a
// second, and never on a timer. null while nothing was read, and always for a session in the developer's own folder or a host that
// cannot read one: the pane then shows what the chat's events say.
//
// The review (item 146) is the same folder read as sections, by the same rule, and only while `on` says the pane shows one: a
// read that goes through every commit of a lane costs more than the one list, so it is not made for a person who looks at the list.
import { useEffect, useRef, useState } from "react";
import { getHost } from "../sessions/host";
import { folderReader, type LaneFolder, type LaneReview, type ReadsLaneFolder, type ReadsLaneReview } from "./laneFolder";

/** What a read of the folder gave: the newest answer, and whether the newest try failed (so a person is told it could not be read
 *  rather than left waiting). A failed try keeps the answer before it. */
export interface FolderRead<T> {
  got: T | null;
  failed: boolean;
}

function useFolderRead<T>(dir: string | null, mark: string, read: (dir: string) => Promise<T | null>, on: boolean, dependsOn: unknown): FolderRead<T> {
  const [state, setState] = useState<{ dir: string; got: T | null; failed: boolean } | null>(null);
  const reader = useRef<ReturnType<typeof folderReader> | null>(null);
  useEffect(() => {
    setState(null);
    reader.current = null;
    if (!dir || !on) return;
    const r = folderReader(
      () => read(dir),
      (got) => setState({ dir, got, failed: false }),
      {
        fail: () => setState((was) => ({ dir, got: was && was.dir === dir ? was.got : null, failed: true })),
      },
    );
    reader.current = r;
    r.poke();
    return () => {
      r.stop();
      reader.current = null;
    };
    // `read` is made from `dependsOn` (the host) on each render; it is the host's change that reads again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, on, dependsOn]);
  // the events moved: read again (the first run of this effect is the open, which the one above already poked)
  useEffect(() => {
    reader.current?.poke();
  }, [mark]);
  const here = state && state.dir === dir;
  return { got: here ? state.got : null, failed: here ? state.failed : false };
}

export function useLaneFolder(dir: string | null, mark: string, host: ReadsLaneFolder = getHost()): LaneFolder | null {
  return useFolderRead(dir, mark, (d) => host.laneDiff(d), true, host).got;
}

/** The review of the lane's folder (the work not committed yet, and each commit), read while `on`. */
export function useLaneReview(dir: string | null, mark: string, on: boolean, host: Partial<ReadsLaneReview> = getHost()): FolderRead<LaneReview> {
  return useFolderRead(dir, mark, async (d) => (await host.laneReview?.(d)) ?? null, on, host);
}
