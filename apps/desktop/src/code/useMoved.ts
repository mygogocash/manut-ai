// A branch's main moving, read again while the Code page is open: whether the branch Kit works on was made from a branch that
// has since changed the files it changed, and which files need both changes (src/code/moved.ts). One read is a few `git` calls
// in the person's folder (git_moved.rs), so it is made when the page opens a project, when the window is looked at again, and
// once a minute: not on every keystroke of a session, and never while a read is still running.
//
// A lane reads it for itself: its own `base`, the branch it was made from, and only while the folder is on its branch (the
// shell answers for the checked-out one). The project reads it for the folder's default base, for the folder that no lane's row
// covers (KitPanel.tsx).
import { useEffect, useState } from "react";
import { getHost } from "../sessions/host";
import { readMoved, type Moved, type MovedAsk, type ReadsGit } from "./moved";

/** How often a project's git is read again while the page stays open. */
export const POLL_MS = 60_000;

/** What a read is for (`MovedAsk`), and `off`: another row already shows it, so nothing is read and nothing is shown. */
export interface MovedOptions extends MovedAsk {
  off?: boolean;
}

/** The state folder `root` is in, or null while the main branch has not moved under the branch (and before the first read).
 *  A read that fails keeps what was shown: git not answering is not a reason to say the branch is fine, or that it is not. */
export function useMoved(root: string, host: ReadsGit = getHost(), opts: MovedOptions = {}): Moved | null {
  const [moved, setMoved] = useState<Moved | null>(null);
  const { base, branch, off } = opts;
  useEffect(() => {
    setMoved(null);
    if (off) return;
    let live = true;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        const m = await readMoved(host, root, { base, branch });
        if (live) setMoved(m);
      } catch {
        /* keep what was shown */
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(read, POLL_MS);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [root, host, base, branch, off]);
  return off ? null : moved;
}
