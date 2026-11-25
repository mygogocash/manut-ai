import { afterEach, describe, expect, it } from "vitest";
import { closePalette, openPalette, paletteOpen, restoreFocus, togglePalette } from "./state";

const el = (connected = true) => ({ calls: 0, isConnected: connected, focus() { this.calls += 1; } });

describe("the palette's open state and the focus it gives back", () => {
  afterEach(() => closePalette({ restore: false }));

  it("opens, closes and toggles", () => {
    expect(paletteOpen()).toBe(false);
    openPalette(null);
    expect(paletteOpen()).toBe(true);
    togglePalette();
    expect(paletteOpen()).toBe(false);
    togglePalette();
    expect(paletteOpen()).toBe(true);
  });

  it("gives the focus back to what had it when it opened, on Esc and on a pick alike", () => {
    const a = el();
    openPalette(a);
    closePalette();
    expect(a.calls).toBe(1);
    // a second close is nothing
    closePalette();
    expect(a.calls).toBe(1);
  });

  it("keeps the first element when asked to open again, and gives back to it once", () => {
    const a = el();
    const b = el();
    openPalette(a);
    openPalette(b);
    closePalette();
    expect([a.calls, b.calls]).toEqual([1, 0]);
  });

  it("does not focus an element that left the page, or when told not to", () => {
    const gone = el(false);
    openPalette(gone);
    closePalette();
    expect(gone.calls).toBe(0);
    const a = el();
    openPalette(a);
    closePalette({ restore: false });
    expect(a.calls).toBe(0);
    expect(restoreFocus(null)).toBe(false);
  });
});
