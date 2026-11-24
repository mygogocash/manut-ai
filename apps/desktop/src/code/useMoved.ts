// A project's main branch, read again while the Code page is open: whether it moved under the lane Kit works on, and which
// files need both changes (src/code/moved.ts). One read is a few `git` calls in the person's folder (git_moved.rs), so it
// is made when the page opens a project, when the window is looked at again, and once a minute: not on every keystroke
// of a session, and never while a read is still running.
import { useEffect, useState } from "react";
import { getHost } from "../sessions/host";
import { movedOf, type Moved, type ReadsGit } from "./moved";

/** How often a project's git is read again while the page stays open. */
export const POLL_MS = 60_000;

/** The state project `root` is in, or null while the main branch has not moved under its lane (and before the first read).
 *  A read that fails keeps what was shown: git not answering is not a reason to say the branch is fine, or that it is not. */
export function useMoved(root: string, host: ReadsGit = getHost()): Moved | null {
  const [moved, setMoved] = useState<Moved | null>(null);
  useEffect(() => {
    let live = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const v = await host.mainMoved(root);
        if (live) setMoved(movedOf(v));
      } catch {
        /* keep what was shown */
      } finally {
        busy = false;
      }
    };
    setMoved(null);
    void read();
    const timer = setInterval(read, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [root, host]);
  return moved;
}
