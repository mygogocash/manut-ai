// Settings › Worktrees' saved choices (src/lib/worktrees.ts): the defaults, what a damaged or hand-edited value becomes, and when
// a merged clean-up is due.
import { beforeEach, describe, expect, it } from "vitest";
import { CLEAN_EVERY_MS, cleanupDue, lastCleanup, markCleanup, parseWorktrees, prefixProblem, setWorktreeSettings, startOf, WORKTREE_DEFAULTS, worktreeSettings } from "./worktrees";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
});

describe("the choices", () => {
  it("default to the folder under the app's data, no remote start, kit/, remove for a deleted chat, and no merged clean-up", () => {
    expect(worktreeSettings()).toEqual({ root: "", remote: false, prefix: "kit/", cleanDeleted: true, cleanMerged: false });
    expect(startOf(worktreeSettings())).toEqual({ root: "", remote: false });
  });

  it("are kept, and a changed one reaches the next read", () => {
    setWorktreeSettings({ remote: true, prefix: "team/ana/", root: "/Users/fon/lanes", cleanMerged: true });
    expect(worktreeSettings()).toEqual({ root: "/Users/fon/lanes", remote: true, prefix: "team/ana/", cleanDeleted: true, cleanMerged: true });
    setWorktreeSettings({ cleanDeleted: false });
    expect(worktreeSettings()).toMatchObject({ cleanDeleted: false, remote: true });
  });

  it("never keep a prefix the check refuses, or a folder that is not absolute", () => {
    setWorktreeSettings({ prefix: "Bad Prefix", root: "relative/lanes" });
    expect(worktreeSettings()).toMatchObject({ prefix: "kit/", root: "" });
    expect(parseWorktrees('{"prefix":"--x/","root":"/a\\nb","remote":"yes"}')).toEqual(WORKTREE_DEFAULTS);
    for (const damaged of [null, "", "not json", "[]", "null", "42"]) expect(parseWorktrees(damaged), String(damaged)).toEqual(WORKTREE_DEFAULTS);
  });

  it("explain a refused prefix", () => {
    expect(prefixProblem("")).toBe("empty");
    expect(prefixProblem("kit")).toBe("slash");
    expect(prefixProblem("Kit/")).toBe("form");
    expect(prefixProblem("a/b/c/")).toBe("form");
    expect(prefixProblem("team/ana/")).toBeNull();
  });
});

describe("when a merged clean-up runs", () => {
  it("is due the first time and then once an hour, never sooner", () => {
    expect(cleanupDue(1000, undefined)).toBe(true);
    expect(cleanupDue(1000 + CLEAN_EVERY_MS - 1, 1000)).toBe(false);
    expect(cleanupDue(1000 + CLEAN_EVERY_MS, 1000)).toBe(true);
    // a clock set back is not a reason to wait for ever
    expect(cleanupDue(500, 1000)).toBe(true);
  });

  it("remembers the last run for each project", () => {
    expect(lastCleanup("/w/a")).toBeUndefined();
    markCleanup("/w/a", 10);
    markCleanup("/w/b", 20);
    expect([lastCleanup("/w/a"), lastCleanup("/w/b")]).toEqual([10, 20]);
  });
});
