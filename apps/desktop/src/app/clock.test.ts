// The shared clock (clock.ts) stops drawing while the window is hidden and catches up the moment it shows again (item 136).
import { afterEach, describe, expect, it, vi } from "vitest";

type Doc = { visibilityState: "visible" | "hidden"; addEventListener: (t: string, f: () => void) => void };

async function withDoc() {
  const listeners: (() => void)[] = [];
  const doc: Doc = { visibilityState: "visible", addEventListener: (t, f) => void (t === "visibilitychange" && listeners.push(f)) };
  (globalThis as { document?: unknown }).document = doc;
  vi.resetModules();
  const clock = await import("./clock");
  return { clock, doc, show: (s: Doc["visibilityState"]) => ((doc.visibilityState = s), listeners.forEach((f) => f())) };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe("the shared clock", () => {
  it("ticks four times a second while shown, not at all while hidden, and once at once when shown again", async () => {
    vi.useFakeTimers();
    const { clock, show } = await withDoc();
    let ticks = 0;
    const stop = clock.onClockTick(() => ticks++);
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(4);
    show("hidden");
    vi.advanceTimersByTime(5_000);
    expect(ticks).toBe(4);
    show("visible");
    expect(ticks).toBe(5);
    vi.advanceTimersByTime(250);
    expect(ticks).toBe(6);
    stop();
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(6);
  });
});
