// An overlay that leaves faster than it came (the Motion board, docs/motion.md): once closed it stays on the page for
// the Leave move, marked as leaving, so it can fade where it stands, and is then gone. The Dock does the same by hand
// (Dock.tsx, DOCK_FADE_MS). Only the popover and the palette use this: an overlay its parent removes goes at once.
import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/reducedMotion";

/** The Leave move's time, motion.css's `--move-leave` (motion.test.ts holds the two together). */
export const LEAVE_MS = 150;


export interface Leaving {
  /** Draw the overlay: it is open, or it is leaving. */
  drawn: boolean;
  /** It is closed and fading: draw it inert, with `data-leaving`, so nothing in it can be pressed or focused. */
  leaving: boolean;
  /** How many times it has opened: a key that gives a reopened overlay a fresh start rather than the leaving one. */
  opened: number;
}

/** Whether to draw an overlay that is `open`, and whether it is on its way out. With reduced motion on it goes at once. */
export function useLeaving(open: boolean): Leaving {
  const [was, setWas] = useState(open);
  const [kept, setKept] = useState(open);
  const [opened, setOpened] = useState(open ? 1 : 0);
  // an opening or a closing is seen in the render that has it: a reopened overlay never draws one frame as leaving,
  // and with reduced motion a closed one never draws one at all
  if (open !== was) {
    setWas(open);
    if (open) {
      setKept(true);
      setOpened((n) => n + 1);
    } else if (prefersReducedMotion()) setKept(false);
  }
  useEffect(() => {
    if (open || !kept) return;
    const h = setTimeout(() => setKept(false), LEAVE_MS);
    return () => clearTimeout(h);
  }, [open, kept]);
  return { drawn: open || kept, leaving: !open && kept, opened };
}
