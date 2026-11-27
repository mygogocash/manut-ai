// One clock for the live times on screen: every component that counts a running time reads the same `now`, ticked
// four times a second by one timer, so two times of the same moment never stand a tick apart (the activity line's
// elapsed and a subagent row's time read the same instant). While the window is hidden (minimised, or behind another
// app's full screen) nothing on screen can move, so the ticks stop drawing and the times catch up the moment it shows
// again (item 136): four renders a second for a window nobody sees cost battery and nothing else.
import { useEffect, useState } from "react";

let now = Date.now();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function tick() {
  if (hidden()) return;
  now = Date.now();
  subs.forEach((f) => f());
}

// shown again: the times are right at once, not a quarter of a second late
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => void (subs.size && tick()));

/** Hears each tick of the shared clock until the returned call; the one timer runs while anyone listens. */
export function onClockTick(f: () => void): () => void {
  if (!subs.size) {
    now = Date.now();
    timer = setInterval(tick, 250);
  }
  subs.add(f);
  return () => {
    subs.delete(f);
    if (!subs.size && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** The shared `now` (ms) while `on`, re-rendering on each tick; `Date.now()` when off. */
export function useClock(on: boolean): number {
  const [, set] = useState(0);
  useEffect(() => (on ? onClockTick(() => set((n) => n + 1)) : undefined), [on]);
  return on && timer !== undefined ? now : Date.now();
}
