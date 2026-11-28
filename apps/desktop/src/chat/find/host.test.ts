// Find in a chat (item 150): which chat a ⌘F reaches, and the places that keep the key for themselves.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepsFind, openChatFind, OWN_FIND, pickHost, registerFindHost, usedFindHost, type FindHost } from "./host";

/** A chat on the page, as a host: the nodes it holds are the strings it was made with. */
function host(name: string, holds: string[] = [], shown = true) {
  const calls: string[] = [];
  let open = false;
  const h: FindHost & { name: string; calls: string[] } = {
    name,
    calls,
    holds: (n) => !!n && holds.includes(n as unknown as string),
    shown: () => shown,
    open: () => void (calls.push("open"), (open = true)),
    close: () => void (calls.push("close"), (open = false)),
    isOpen: () => open,
  };
  return h;
}
const node = (s: string) => s as unknown as Node;

describe("which chat a ⌘F reaches", () => {
  const a = host("a", ["a-box", "a-line"]);
  const b = host("b", ["b-box"]);

  it("the chat that holds the key's target", () => {
    expect(pickHost([a, b], node("b-box"), node("a-line"), a)).toBe(b);
  });

  it("else the chat that holds the focus", () => {
    expect(pickHost([a, b], node("body"), node("b-box"), a)).toBe(b);
  });

  it("else the one used last, while it is on screen", () => {
    expect(pickHost([a, b], node("body"), node("body"), b)).toBe(b);
    expect(pickHost([a, host("b", ["b-box"], false)], node("body"), node("body"), host("b", [], false))).toBe(a);
  });

  it("else the first on screen; a chat that is not on screen is never reached", () => {
    expect(pickHost([a, b], null, null, null)).toBe(a);
    expect(pickHost([host("off", ["x"], false), b], node("x"), null, null)).toBe(b);
  });

  it("none when no chat is on screen", () => {
    expect(pickHost([], null, null, null)).toBeNull();
    expect(pickHost([host("off", [], false)], null, null, null)).toBeNull();
  });
});

describe("opening the bar", () => {
  it("opens the chat that was picked, shuts another chat's bar, and says a chat took the key", () => {
    const a = host("a", ["a-box"]);
    const b = host("b", ["b-box"]);
    const off = [registerFindHost(a), registerFindHost(b)];
    expect(openChatFind(node("a-box"), null)).toBe(true);
    expect(a.calls).toEqual(["open"]);
    expect(openChatFind(node("b-box"), null)).toBe(true);
    expect(a.calls).toEqual(["open", "close"]);
    expect(b.calls).toEqual(["open"]);
    off.forEach((f) => f());
  });

  it("goes to the chat the person last used when the key comes from nowhere in particular", () => {
    const a = host("a", []);
    const b = host("b", []);
    const off = [registerFindHost(a), registerFindHost(b)];
    usedFindHost(b);
    expect(openChatFind(null, null)).toBe(true);
    expect(b.calls).toEqual(["open"]);
    expect(a.calls).toEqual([]);
    off.forEach((f) => f());
  });

  it("says no chat took the key when none is on screen, and after the last one has left", () => {
    expect(openChatFind(null, null)).toBe(false);
    const a = host("a");
    const off = registerFindHost(a);
    off();
    expect(openChatFind(null, null)).toBe(false);
    expect(a.calls).toEqual([]);
  });
});

describe("the places that keep ⌘F", () => {
  /** A target that is inside whatever the selectors named are (an element's `closest` answers for its ancestors). */
  const inside = (...kept: string[]) => ({ closest: (sel: string) => (sel.split(/\s*,\s*/).some((s) => kept.includes(s)) ? {} : null) }) as unknown as EventTarget;

  it("keeps it for a terminal, its find bar, this bar, a pane that marks itself, and a menu, list or dialog", () => {
    for (const s of [".xterm", ".tfind", ".cfind", "[data-own-find]", "[role=dialog]", "[role=menu]", "[role=listbox]"]) expect(keepsFind(inside(s)), s).toBe(true);
    expect(OWN_FIND.split(/\s*,\s*/).sort()).toEqual([".cfind", ".tfind", ".xterm", "[data-own-find]", "[role=dialog]", "[role=listbox]", "[role=menu]"]);
  });

  it("leaves it to the chat anywhere else: its box, its timeline, the page", () => {
    expect(keepsFind(inside())).toBe(false);
    expect(keepsFind(null)).toBe(false);
    expect(keepsFind({} as EventTarget)).toBe(false);
  });
});

describe("the pane beside a lane", () => {
  it("marks itself as the place of a find of its own, in the markup the lane draws, so the chat beside it does not take the key", () => {
    const src = readFileSync(join(__dirname, "../../code/LanePane.tsx"), "utf8");
    expect(src).toMatch(/<aside className="lpane"[^>]*\bdata-own-find\b/);
    expect(OWN_FIND).toContain("[data-own-find]");
  });
});
