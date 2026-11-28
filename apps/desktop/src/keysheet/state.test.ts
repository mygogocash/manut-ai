import { afterEach, describe, expect, it } from "vitest";
import { closeKeySheet, keySheetOpen, openKeySheet, toggleKeySheet } from "./state";

const el = (connected = true) => ({ calls: 0, isConnected: connected, focus() { this.calls += 1; } });

describe("the key sheet's open state and the focus it gives back", () => {
  afterEach(() => closeKeySheet({ restore: false }));

  it("opens, closes and toggles", () => {
    expect(keySheetOpen()).toBe(false);
    openKeySheet(null);
    expect(keySheetOpen()).toBe(true);
    toggleKeySheet();
    expect(keySheetOpen()).toBe(false);
    toggleKeySheet();
    expect(keySheetOpen()).toBe(true);
  });

  it("gives the focus back to what had it when it opened, once", () => {
    const a = el();
    openKeySheet(a);
    closeKeySheet();
    expect(a.calls).toBe(1);
    closeKeySheet();
    expect(a.calls).toBe(1);
  });

  it("keeps the first element when asked to open again", () => {
    const a = el();
    const b = el();
    openKeySheet(a);
    openKeySheet(b);
    closeKeySheet();
    expect([a.calls, b.calls]).toEqual([1, 0]);
  });

  it("gives nothing back when told not to (Settings has the focus now) or when the element left the page", () => {
    const a = el();
    openKeySheet(a);
    closeKeySheet({ restore: false });
    expect(a.calls).toBe(0);
    const gone = el(false);
    openKeySheet(gone);
    closeKeySheet();
    expect(gone.calls).toBe(0);
  });
});
