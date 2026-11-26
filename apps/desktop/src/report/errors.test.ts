// The kept problems: memory only, one masked line each, the newest 50.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearErrors, KEEP, LINE_MAX, onErrors, recentErrors, recordError, watchPageErrors } from "./errors";

const KEY = ["ghp", "_", "b".repeat(36)].join("");
afterEach(() => {
  clearErrors();
  vi.unstubAllGlobals();
});

describe("recordError", () => {
  it("keeps the first line only, masked and cut, newest first", () => {
    recordError("chat", `first ${KEY}\nsecond line is a transcript`, 10);
    recordError("session", "x".repeat(500), 20);
    const [a, b] = recentErrors();
    expect(a.source).toBe("session");
    expect(a.text.length).toBe(LINE_MAX);
    expect(b.text).not.toContain(KEY);
    expect(b.text).not.toContain("transcript");
  });

  it("drops empty text and a repeat in the same second", () => {
    recordError("chat", "  ", 1);
    recordError("chat", "same", 1000);
    recordError("chat", "same", 1500);
    recordError("chat", "same", 2600);
    expect(recentErrors()).toHaveLength(2);
  });

  it("keeps the newest 50 and never writes to storage", () => {
    const set = vi.fn();
    vi.stubGlobal("localStorage", { setItem: set, getItem: () => null });
    for (let i = 0; i < KEEP + 10; i++) recordError("chat", `problem ${i}`, i * 5000);
    expect(recentErrors()).toHaveLength(KEEP);
    expect(recentErrors()[0].text).toBe(`problem ${KEEP + 9}`);
    expect(set).not.toHaveBeenCalled();
  });

  it("hears the page's uncaught errors and refused promises", () => {
    const fns: Record<string, (e: unknown) => void> = {};
    watchPageErrors({ addEventListener: (n: string, f: unknown) => void (fns[n] = f as (e: unknown) => void) } as never);
    fns.error({ message: "boom" });
    fns.unhandledrejection({ reason: new Error("refused") });
    expect(recentErrors().map((e) => e.text)).toEqual(["refused", "boom"]);
  });
});

describe("onErrors", () => {
  // Told through lib/changes.ts since item 125d, from a copy of the listeners taken first, as the module's own Set was.
  it("tells each listener of a problem kept, from a copy taken first, and not after it unsubscribed", () => {
    const told: string[] = [];
    let offB = () => {};
    let first = true;
    const offA = onErrors(() => {
      told.push("a");
      if (!first) return;
      first = false;
      offB();
    });
    offB = onErrors(() => told.push("b"));
    recordError("chat", "one", 10_000);
    expect(told).toEqual(["a", "b"]);
    recordError("chat", "two", 20_000);
    expect(told).toEqual(["a", "b", "a"]);
    offA();
    recordError("chat", "three", 30_000);
    recordError("chat", "", 40_000);
    expect(told).toEqual(["a", "b", "a"]);
  });
});
