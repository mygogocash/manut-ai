import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./reducedMotion";

describe("prefersReducedMotion", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is false when the page cannot ask", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
  it("reads the system setting", () => {
    const mm = vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }));
    vi.stubGlobal("matchMedia", mm);
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});
