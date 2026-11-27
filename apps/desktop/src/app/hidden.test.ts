// The page is marked while its window is hidden, so motion.css holds every loop still (item 136).
import { describe, expect, it } from "vitest";
import { startHiddenMark } from "./hidden";

describe("the hidden mark", () => {
  it("follows the window: on while hidden, off when shown, and stops following when asked", () => {
    const attrs = new Set<string>();
    let listener: (() => void) | null = null;
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      documentElement: { toggleAttribute: (n: string, on: boolean) => (on ? attrs.add(n) : attrs.delete(n), on) } as unknown as HTMLElement,
      addEventListener: (_t: string, f: () => void) => void (listener = f),
      removeEventListener: () => void (listener = null),
    };
    const stop = startHiddenMark(doc as never);
    expect(attrs.has("data-hidden")).toBe(false);
    doc.visibilityState = "hidden";
    listener!();
    expect(attrs.has("data-hidden")).toBe(true);
    doc.visibilityState = "visible";
    listener!();
    expect(attrs.has("data-hidden")).toBe(false);
    stop();
    expect(listener).toBeNull();
  });
});
