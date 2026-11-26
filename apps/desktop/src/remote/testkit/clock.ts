// A clock and timers a test moves by hand, so a two-minute code, a 60-second challenge, a 50-second ping and a capped
// retry are each reached exactly, without real waiting and without faking the runtime's own timers.
import type { Timers } from "../link";

export class ManualClock implements Timers {
  now: number;
  readonly #timers = new Map<number, { at: number; run: () => void }>();
  #next = 1;

  constructor(start = 1_800_000_000_000) {
    this.now = start;
  }

  set(run: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, run });
    return id;
  }

  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** The waits set now, soonest first, as milliseconds from now. */
  pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Moves time on by `ms`, running each timer that comes due, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].run();
    }
    this.now = end;
  }
}

/** Lets every promise and microtask that is ready run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
