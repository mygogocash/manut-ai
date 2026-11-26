// Noticing that the Mac slept, from the page: timers stand still while the Mac sleeps, so the first tick after waking finds
// the clock far ahead of the last one. A gap of two minutes is taken for sleep (a page held back by App Nap or a hidden
// window is late by seconds, a little more at worst, and a nap that short has nothing worth saying about it). What waited is
// what was working at the last tick before the gap. Pure: the caller passes the clock and says what is working.

/** How often the page looks at the clock. */
export const WAKE_TICK_MS = 5_000;
/** A tick this much after the last one means the Mac slept in between. */
export const WAKE_GAP_MS = 120_000;

export interface WakeInfo {
  /** How many jobs were working when the Mac went to sleep: what had to wait. */
  count: number;
  /** When the page noticed (ms). */
  wokeAt: number;
  /** The last tick before the gap (ms). */
  sleptAt: number;
}

export function createWakeWatch(opts: { gapMs?: number; working: () => number; onWake: (info: WakeInfo) => void }) {
  const gap = opts.gapMs ?? WAKE_GAP_MS;
  let last: number | null = null;
  let workingAtLast = 0;
  return {
    /** Call every `WAKE_TICK_MS`. */
    tick(now: number): void {
      // a clock set back gives a negative gap, which is never sleep
      if (last !== null && now - last >= gap) opts.onWake({ count: workingAtLast, wokeAt: now, sleptAt: last });
      last = now;
      workingAtLast = opts.working();
    },
  };
}
