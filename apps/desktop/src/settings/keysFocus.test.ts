// The ask Settings › General › Keyboard hears from the key sheet (item 167d): it waits for the list, once, and goes stale.
import { describe, expect, it, vi } from "vitest";
import { askKeysFocus, onKeysFocus, takeKeysFocus } from "./keysFocus";

describe("the ask for the Keyboard list", () => {
  it("waits for the list until it is taken, and is taken once", () => {
    askKeysFocus("details", 1_000);
    expect(takeKeysFocus(1_500)).toBe("details");
    expect(takeKeysFocus(1_500)).toBeNull();
    askKeysFocus("list", 1_000);
    expect(takeKeysFocus(1_001)).toBe("list");
  });

  it("goes stale after a few seconds, so a later visit to Settings is never moved by it", () => {
    askKeysFocus("search", 1_000);
    expect(takeKeysFocus(1_000 + 3_001)).toBeNull();
    askKeysFocus("search", 1_000);
    expect(takeKeysFocus(1_000 + 3_000)).toBe("search");
  });

  it("tells a list that is already on screen at once, and a list that left no more", () => {
    const heard = vi.fn();
    const stop = onKeysFocus(heard);
    askKeysFocus("terminal");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeKeysFocus()).toBe("terminal");
    stop();
    askKeysFocus("terminal");
    expect(heard).toHaveBeenCalledTimes(1);
    takeKeysFocus();
  });
});
