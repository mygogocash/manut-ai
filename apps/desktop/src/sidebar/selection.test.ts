// Several rows at once (item 94): what Shift-click, Cmd-click and Shift with an arrow select, and which rows a menu acts on.
import { describe, expect, it } from "vitest";
import { actsOn, clickSelect, NONE, stepSelect, toggleKey, type Selection } from "./selection";

const ORDER = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };
const cmd = { toggle: true, range: false };
const shift = { toggle: false, range: true };

describe("selecting several rows", () => {
  it("leaves a plain click to open its row", () => {
    expect(clickSelect(NONE, "recent", ORDER, "b", plain)).toBeNull();
  });

  it("adds and removes one row with Cmd-click, which becomes where Shift counts from", () => {
    const one = clickSelect(NONE, "recent", ORDER, "b", cmd)!;
    expect(one).toEqual({ scope: "recent", keys: ["b"], anchor: "b" });
    const two = clickSelect(one, "recent", ORDER, "d", cmd)!;
    expect(two.keys).toEqual(["b", "d"]);
    expect(clickSelect(two, "recent", ORDER, "b", cmd)!.keys).toEqual(["d"]);
  });

  it("selects every row from the last one picked to this one with Shift-click, either way", () => {
    const from = clickSelect(NONE, "recent", ORDER, "b", cmd)!;
    expect(clickSelect(from, "recent", ORDER, "d", shift)!.keys).toEqual(["b", "c", "d"]);
    expect(clickSelect(from, "recent", ORDER, "a", shift)!.keys).toEqual(["a", "b"]);
    // with nothing picked yet, Shift-click selects the one row
    expect(clickSelect(NONE, "recent", ORDER, "c", shift)!.keys).toEqual(["c"]);
    // Cmd-Shift-click adds the span to what is selected
    const two: Selection = { scope: "recent", keys: ["a", "e"], anchor: "e" };
    expect(clickSelect(two, "recent", ORDER, "c", { toggle: true, range: true })!.keys).toEqual(["a", "e", "c", "d"]);
  });

  it("starts again in another list", () => {
    const here: Selection = { scope: "history", keys: ["x", "y"], anchor: "y" };
    expect(clickSelect(here, "recent", ORDER, "c", cmd)).toEqual({ scope: "recent", keys: ["c"], anchor: "c" });
  });

  it("reaches the next row up or down with Shift and an arrow, from the keyboard alone", () => {
    const down = stepSelect(NONE, "recent", ORDER, "b", 1)!;
    expect(down).toEqual({ sel: { scope: "recent", keys: ["b", "c"], anchor: "b" }, focus: "c" });
    const more = stepSelect(down.sel, "recent", ORDER, "c", 1)!;
    expect(more.sel.keys).toEqual(["b", "c", "d"]);
    // back up shrinks it toward the anchor
    expect(stepSelect(more.sel, "recent", ORDER, "d", -1)!.sel.keys).toEqual(["b", "c"]);
    // nothing past either end
    expect(stepSelect(NONE, "recent", ORDER, "e", 1)).toBeNull();
    expect(stepSelect(NONE, "recent", ORDER, "a", -1)).toBeNull();
  });

  it("acts on the whole selection from a selected row's menu, and on the row alone from any other", () => {
    const sel: Selection = { scope: "recent", keys: ["a", "c"], anchor: "c" };
    expect(actsOn(sel, "recent", "a")).toEqual(["a", "c"]);
    expect(actsOn(sel, "recent", "b")).toEqual(["b"]);
    expect(actsOn(sel, "history", "a")).toEqual(["a"]);
    expect(actsOn({ scope: "recent", keys: ["a"], anchor: "a" }, "recent", "a")).toEqual(["a"]);
  });

  it("adds one row with Cmd on macOS and Ctrl elsewhere", () => {
    expect(toggleKey({ metaKey: true, ctrlKey: false }, true)).toBe(true);
    expect(toggleKey({ metaKey: false, ctrlKey: true }, true)).toBe(false);
    expect(toggleKey({ metaKey: false, ctrlKey: true }, false)).toBe(true);
  });
});
