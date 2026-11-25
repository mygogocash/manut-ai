// The lane's folder as the Diff beside the lane reads it (laneFolder.ts): read when the lane opens, so the pane is not empty after a
// restart, when the chat's events say something may have changed (a change, a subagent's step, the turn's end), at most once a
// second, and never on a timer. null while nothing was read, and always for a session in the developer's own folder or a host that
// cannot read one: the pane then shows what the chat's events say.
import { useEffect, useRef, useState } from "react";
import { getHost } from "../sessions/host";
import { folderReader, type LaneFolder, type ReadsLaneFolder } from "./laneFolder";

export function useLaneFolder(dir: string | null, mark: string, host: ReadsLaneFolder = getHost()): LaneFolder | null {
  const [got, setGot] = useState<{ dir: string; folder: LaneFolder } | null>(null);
  const reader = useRef<ReturnType<typeof folderReader> | null>(null);
  useEffect(() => {
    setGot(null);
    reader.current = null;
    if (!dir) return;
    const r = folderReader(
      () => host.laneDiff(dir),
      (folder) => setGot({ dir, folder }),
    );
    reader.current = r;
    r.poke();
    return () => {
      r.stop();
      reader.current = null;
    };
  }, [dir, host]);
  // the events moved: read again (the first run of this effect is the open, which the one above already poked)
  useEffect(() => {
    reader.current?.poke();
  }, [mark]);
  return got && got.dir === dir ? got.folder : null;
}
