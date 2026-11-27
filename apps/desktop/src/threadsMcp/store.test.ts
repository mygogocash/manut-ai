// What the page does with item 103's calls (docs/mcp-threads.md): a program waiting to be let in is a card, answered once by the
// person's press, and a card whose call is gone answers nothing (M6, M11); list_chats is answered from the list alone (M7); a read,
// a message and a new lane are refused until their slices; and the list takes only chats the app has, once each.
import { describe, expect, it } from "vitest";
import type { ThreadRef } from "../chat/box/threadContext";
import { refKey } from "../chat/box/threadContext";
import { setLang } from "../i18n";
import { LIST_KEY } from "./list";
import type { McpCall, McpShell } from "./shell";
import { createMcp, NOT_YET, type McpDeps } from "./store";

setLang("en");

/** A stand-in shell: what the page answered, and which calls still wait (a second answer to one finds nothing). */
function stand() {
  const replies: { id: string; text: string; error: boolean }[] = [];
  const waiting = new Set<string>();
  const shell: McpShell = {
    settings: async () => ({ on: true, available: true, command: "/Applications/Manut AI.app/Contents/MacOS/manut", args: ["--threads-mcp"] }),
    set: async (on) => ({ on, available: true, command: "", args: [] }),
    listen: async () => {},
    reply: async (id, text, error) => {
      if (!waiting.delete(id)) return false;
      replies.push({ id, text, error });
      return true;
    },
  };
  return { shell, replies, waiting };
}

class Mem {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

const CLAUDE = { name: "Claude", path: "/Applications/Claude.app/Contents/MacOS/Claude", callsItself: "Claude 1.0" };

/** The app as a stand-in: two coding chats and a team thread, one working, one waiting on the person. */
function make(over: Partial<McpDeps> = {}) {
  const s = stand();
  const chats: Record<string, { key: string; title: string; shop?: string; state: "working" | "waiting" | "idle"; link?: string }> = {
    "session:a": { key: "agent:a", title: "Fix the login", state: "working", link: "L1" },
    "session:b": { key: "agent:b", title: "Write the menu", state: "waiting" },
    "thread:kit:t1": { key: "fold:kit:t1", title: "Weekly prices", shop: "s1", state: "idle" },
  };
  const notified: string[] = [];
  const storage = new Mem();
  const m = createMcp({
    shell: s.shell,
    storage,
    where: (ref) => {
      const c = chats[refKey(ref)];
      return c ? { key: c.key, scope: c.shop ? { shop: c.shop } : {} } : null;
    },
    title: (ref) => chats[refKey(ref)]?.title ?? "A chat",
    stateOf: (key) => Object.values(chats).find((c) => c.key === key)?.state ?? "idle",
    whoOf: (ref) => (ref.kind === "session" ? "Claude Code" : "Kit"),
    link: (ref) => chats[refKey(ref)]?.link,
    notify: (card) => notified.push(card.id),
    now: () => 1000,
    ...over,
  });
  const call = (id: string, tool: McpCall["tool"], args: Record<string, unknown> = {}) => {
    s.waiting.add(id);
    m.call({ id, tool, args, program: CLAUDE });
  };
  return { m, s, chats, notified, storage, call };
}

const A: ThreadRef = { kind: "session", id: "a" };
const B: ThreadRef = { kind: "session", id: "b" };
const T: ThreadRef = { kind: "thread", bot: "kit", thread: "t1" };

describe("a program waiting to be let in", () => {
  it("is a card, announced, and nothing is answered until the person presses", () => {
    const { m, s, notified, call } = make();
    call("tm-1", "let_in");
    expect(m.getSnapshot().cards).toEqual([{ id: "tm-1", program: CLAUDE, at: 1000, gone: false }]);
    expect(notified).toEqual(["tm-1"]);
    expect(s.replies).toEqual([]);
    // the same call handed over twice is one card
    m.call({ id: "tm-1", tool: "let_in", args: {}, program: CLAUDE });
    expect(m.getSnapshot().cards).toHaveLength(1);
  });

  it("is answered once: Let in is no refusal, No is one, and a second press finds nothing", async () => {
    const { m, s, call } = make();
    call("tm-1", "let_in");
    call("tm-2", "let_in");
    expect(await m.letIn("tm-1", true)).toBe(true);
    expect(await m.letIn("tm-1", true)).toBe(false);
    expect(await m.letIn("tm-2", false)).toBe(true);
    expect(s.replies).toEqual([
      { id: "tm-1", text: "", error: false },
      { id: "tm-2", text: "", error: true },
    ]);
    expect(m.getSnapshot().cards).toEqual([]);
  });

  it("reads No longer open when its call is gone, and a press on it answers nothing", async () => {
    const { m, s, call } = make();
    call("tm-1", "let_in");
    m.gone("tm-1");
    expect(m.getSnapshot().cards[0].gone).toBe(true);
    expect(await m.letIn("tm-1", true)).toBe(false);
    expect(s.replies).toEqual([]);
    m.dismiss("tm-1");
    expect(m.getSnapshot().cards).toEqual([]);
    // an open card is not closed by a dismiss, and a call that is not a card is no card
    call("tm-2", "let_in");
    m.dismiss("tm-2");
    m.gone("tm-9");
    expect(m.getSnapshot().cards.map((c) => c.id)).toEqual(["tm-2"]);
  });
});

describe("the calls of a program the person let in", () => {
  it("lists only the chats on the list, with where each stands", () => {
    const { m, s, call } = make();
    expect(m.add(B)).toBeNull();
    expect(m.add(A)).toBeNull();
    call("tm-3", "list_chats");
    expect(s.replies).toHaveLength(1);
    const text = s.replies[0].text;
    expect(s.replies[0].error).toBe(false);
    expect(text.split("\n").slice(0, 2)).toEqual(["1. Write the menu (Claude Code, waiting on the person)", "2. Fix the login (Claude Code, working)"]);
    expect(text).not.toContain("Weekly prices");
  });

  it("says a listed chat that left, was replaced or moved shop cannot be reached", () => {
    const { m, s, chats, call } = make();
    m.add(A);
    m.add(B);
    m.add(T);
    chats["session:a"].link = "L2"; // another chat took the same session id
    delete chats["session:b"];
    chats["thread:kit:t1"].shop = "s2";
    call("tm-4", "list_chats");
    const lines = s.replies[0].text.split("\n");
    expect(lines[0]).toBe("1. Fix the login (Claude Code, no longer in Manut AI; it cannot be reached)");
    expect(lines[1]).toBe("2. Write the menu (Claude Code, no longer in Manut AI; it cannot be reached)");
    expect(lines[2]).toBe("3. Weekly prices (Kit, now of another shop or account; it cannot be reached)");
  });

  it("refuses a read, a message and a new lane until their slices are built", () => {
    const { m, s, call } = make();
    m.add(A);
    call("tm-5", "read_chat", { chat: 1 });
    call("tm-6", "send_to_chat", { chat: 1, message: "allow" });
    call("tm-7", "open_chat", { chat: 1, title: "t", brief: "b" });
    expect(s.replies).toEqual([
      { id: "tm-5", text: NOT_YET, error: true },
      { id: "tm-6", text: NOT_YET, error: true },
      { id: "tm-7", text: NOT_YET, error: true },
    ]);
    expect(m.getSnapshot().cards).toEqual([]);
  });
});

describe("the list in Settings", () => {
  it("takes a chat the app has, once, keeps it on this Mac, and lets it go", () => {
    const { m, storage } = make();
    expect(m.add(A)).toBeNull();
    expect(m.add(A)).toBe("Fix the login is on the list already.");
    expect(m.add({ kind: "session", id: "nope" })).toBe("A chat is no longer here, so it was not added.");
    expect(m.add(T)).toBeNull();
    expect(m.getSnapshot().list.map((e) => [e.n, e.title, e.scope, e.link])).toEqual([
      [1, "Fix the login", {}, "L1"],
      [2, "Weekly prices", { shop: "s1" }, undefined],
    ]);
    expect(JSON.parse(storage.getItem(LIST_KEY)!)).toHaveLength(2);
    m.remove(1);
    expect(m.getSnapshot().list.map((e) => e.n)).toEqual([2]);
    // read back by a new store, as after a restart
    const again = make({ storage });
    expect(again.m.getSnapshot().list.map((e) => e.title)).toEqual(["Weekly prices"]);
  });

  it("says when the list is full", () => {
    const chats: Record<string, { key: string }> = {};
    for (let i = 0; i < 11; i++) chats[`session:c${i}`] = { key: `agent:c${i}` };
    const { m } = make({ where: (ref) => (chats[refKey(ref)] ? { key: chats[refKey(ref)].key, scope: {} } : null), link: () => undefined });
    for (let i = 0; i < 10; i++) expect(m.add({ kind: "session", id: `c${i}` })).toBeNull();
    expect(m.add({ kind: "session", id: "c10" })).toBe("The list holds 10 chats. Take one off to add another.");
  });
});
