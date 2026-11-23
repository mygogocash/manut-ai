// ⌘N opens the terminals' + menu. That menu lives on the Code page now, so a press made elsewhere opens the Code page
// and the menu opens as the page's header mounts.
import { describe, expect, it } from "vitest";
import { onOpenNewSessionMenu, openNewSessionMenu } from "./newMenu";

describe("the + menu's opener", () => {
  it("opens every + menu on screen", () => {
    const seen: string[] = [];
    const off = onOpenNewSessionMenu(() => seen.push("a"));
    openNewSessionMenu();
    expect(seen).toEqual(["a"]);
    off();
  });

  it("keeps a press made while no + menu is on screen for the next one to mount, once", () => {
    const seen: string[] = [];
    openNewSessionMenu();
    const off = onOpenNewSessionMenu(() => seen.push("first"));
    expect(seen).toEqual(["first"]);
    off();
    // the press was used: a menu mounted later does not open by itself
    const off2 = onOpenNewSessionMenu(() => seen.push("second"));
    expect(seen).toEqual(["first"]);
    off2();
  });
});
