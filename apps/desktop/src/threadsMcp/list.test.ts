// Item 103's list of chats other programs may reach (docs/mcp-threads.md, rule M7): at most ten, numbered as 102k's list is, kept
// on this Mac and read back defensively, and what list_chats answers: each chat's number, title (masked), who answers there and
// where it stands, a chat that is gone or moved said plainly.
import { describe, expect, it } from "vitest";
import { addEntry, REACH_MAX, type ReachEntry } from "../jobs/reachList";
import { EMPTY_LIST, LIST_KEY, listLines, loadList, movedScope, OUTSIDE_MAX, saveList, type ChatState } from "./list";

const entry = (n: number, title = `Chat ${n}`, over: Partial<ReachEntry> = {}): ReachEntry => ({ n, ref: { kind: "session", id: `s${n}` }, title, scope: {}, ...over });

class Mem {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("the list other programs may reach", () => {
  it("holds ten chats, more than a chat's own list, each under a number that is not reused", () => {
    let list: ReachEntry[] = [];
    for (let i = 1; i <= OUTSIDE_MAX + 1; i++) {
      const r = addEntry(list, { ref: { kind: "session", id: `s${i}` }, title: `Chat ${i}`, scope: {} }, OUTSIDE_MAX);
      if (i <= OUTSIDE_MAX) expect(r.refused).toBeNull();
      else expect(r.refused).toBe("full");
      list = r.list;
    }
    expect(OUTSIDE_MAX).toBeGreaterThan(REACH_MAX);
    expect(list.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // a chat's own list keeps its cap when no cap is given
    expect(addEntry(list.slice(0, REACH_MAX), { ref: { kind: "session", id: "x" }, title: "x", scope: {} }).refused).toBe("full");
  });

  it("is kept on this Mac and read back defensively, the cap holding", () => {
    const mem = new Mem();
    const list = [entry(1), entry(3, "Fix the login", { ref: { kind: "thread", bot: "kit", thread: "t1" }, scope: { shop: "s1" }, link: undefined })];
    expect(saveList(mem, list)).toBe(true);
    expect(loadList(mem)).toEqual(list);
    mem.setItem(LIST_KEY, "not json");
    expect(loadList(mem)).toEqual([]);
    mem.setItem(LIST_KEY, JSON.stringify(Array.from({ length: 14 }, (_, i) => entry(i + 1))));
    expect(loadList(mem)).toHaveLength(OUTSIDE_MAX);
    expect(loadList(null)).toEqual([]);
    const throws = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(loadList(throws)).toEqual([]);
    expect(saveList(throws, list)).toBe(false);
  });

  it("tells a chat now of another shop or account from one that is not", () => {
    expect(movedScope({ shop: "a" }, { shop: "a" })).toBe(false);
    expect(movedScope({}, {})).toBe(false);
    expect(movedScope({ shop: "a" }, { shop: "b" })).toBe(true);
    expect(movedScope({ account: "claude:me" }, { account: "claude:work" })).toBe(true);
    expect(movedScope({}, { shop: "a" })).toBe(true);
  });
});

describe("what list_chats answers", () => {
  const states: Record<number, ChatState> = { 1: "working", 2: "waiting", 3: "idle", 4: "gone", 5: "moved" };

  it("names each chat by its number with its title, who answers and where it stands", () => {
    const text = listLines([entry(2, "Fix the login"), entry(1, "Write the menu"), entry(3), entry(4), entry(5)], (e) => states[e.n], (e) => (e.n === 4 ? "" : "Claude Code"));
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "1. Write the menu (Claude Code, working)",
      "2. Fix the login (Claude Code, waiting on the person)",
      "3. Chat 3 (Claude Code, idle)",
      "4. Chat 4 (no longer in Manut AI; it cannot be reached)",
      "5. Chat 5 (Claude Code, now of another shop or account; it cannot be reached)",
    ]);
    expect(text).toContain("Every read, message and new lane asks the person first.");
  });

  it("masks a key in a title and keeps each chat to one line", () => {
    const text = listLines([entry(1, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\nsecond line")], () => "idle", () => "Codex");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text.split("\n")[0]).toMatch(/^1\. token .* second line \(Codex, idle\)$/);
  });

  it("says where to list chats when none are", () => {
    expect(listLines([], () => "idle", () => "")).toBe(EMPTY_LIST);
  });
});
