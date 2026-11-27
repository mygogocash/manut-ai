// The side menu's width and whether it shows (sideState.ts, the owner's ask of 27 Nov 2026): kept on this Mac, checked as it
// is read, a width held between the narrowest and widest, and the canvas's width back on a reset.
import { beforeEach, describe, expect, it } from "vitest";
import { forgetSide, parseSide, setSideHidden, setSideWidth, sideState, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, toggleSide } from "./sideState";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  forgetSide();
});

describe("the side menu", () => {
  it("is the canvas's width and shown by default, and reads back only what can be used", () => {
    expect(sideState()).toEqual({ width: SIDE_DEFAULT, hidden: false });
    expect(parseSide("abc", "yes")).toEqual({ width: SIDE_DEFAULT, hidden: false });
    expect(parseSide("9999", "1")).toEqual({ width: SIDE_MAX, hidden: true });
    expect(parseSide("10", null)).toEqual({ width: SIDE_MIN, hidden: false });
  });

  it("keeps a width set and whether it shows, and a reset forgets the width", () => {
    setSideWidth(280.4);
    toggleSide();
    expect(sideState()).toEqual({ width: 280, hidden: true });
    forgetSide();
    expect(sideState()).toEqual({ width: 280, hidden: true });
    setSideHidden(false);
    setSideWidth(null);
    expect(sideState()).toEqual({ width: SIDE_DEFAULT, hidden: false });
    expect(store.size).toBe(0);
  });
});
