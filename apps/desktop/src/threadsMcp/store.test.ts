// What the page does with item 103's calls (docs/mcp-threads.md): a program waiting to be let in is a card, answered once by the
// person's press, and a card whose call is gone answers nothing (M6, M11); list_chats is answered from the list alone (M7); a read
// and a message are cards that show exactly what would go, settled once in approval-core, checked again at the press, and a
// message goes through route under the program's mark and never answers an ask (M8, M9); a new lane is refused until 103d; and the
// list takes only chats the app has, once each.
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextReader } from "../chat/box/threadContext";
import { mcpAskRecord, resetMcpAsks } from "./asks";
import type { OpenLane } from "../jobs/reachChats";
import { PROGRAM_FENCE, readFromProgram } from "./list";
import type { ThreadRef } from "../chat/box/threadContext";
import { refKey } from "../chat/box/threadContext";
import { setLang } from "../i18n";
import { LIST_KEY } from "./list";
import type { McpCall, McpShell } from "./shell";
import { createMcp, NOT_YET, type McpDeps } from "./store";

setLang("en");
beforeEach(() => resetMcpAsks());

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

/** Item 97's reader over the stand-in chats: what each holds, read with no model. */
function readerOf(chats: Record<string, { key: string; title: string }>): ContextReader {
  const byKey = (key: string) => Object.values(chats).find((c) => c.key === key);
  return {
    chatKey: (ref) => chats[refKey(ref)]?.key ?? null,
    title: (ref) => chats[refKey(ref)]?.title ?? "A chat",
    held: (key) => (byKey(key) ? [{ role: "user", text: "Make the login work" }, { role: "assistant", text: `Done; the token ${KEY} is set` }] : null),
    read: async () => [],
    ask: () => null,
    lane: async () => null,
    scope: () => ({}),
  };
}

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
  const routed: { session: string; text: string }[] = [];
  const opened: OpenLane[] = [];
  const running = new Set(["a", "b"]);
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
    reader: () => readerOf(chats),
    sendable: (ref) => ref.kind === "session" && !!chats[refKey(ref)],
    route: async (session, text) => {
      if (!running.has(session)) return false;
      routed.push({ session, text });
      return true;
    },
    laneBase: (ref) => (ref.kind === "session" && chats[refKey(ref)] ? { cwd: "/home/you/code/shop", agent: "claude" } : null),
    agentFor: (name) => ({ claude: { id: "claude", label: "Claude Code" }, codex: { id: "codex", label: "Codex" } } as Record<string, { id: string; label: string }>)[name.toLowerCase()] ?? null,
    openLane: async (p) => {
      opened.push(p);
      chats[`session:new${opened.length}`] = { key: `agent:new${opened.length}`, title: p.title, state: "working" };
      return { ok: true, id: `new${opened.length}` };
    },
    notify: (card) => notified.push(card.id),
    now: () => 1000,
    ...over,
  });
  const call = (id: string, tool: McpCall["tool"], args: Record<string, unknown> = {}) => {
    s.waiting.add(id);
    m.call({ id, tool, args, program: CLAUDE });
  };
  return { m, s, chats, notified, storage, call, routed, running, opened };
}

/** Lets the card's text be built: a read card opens after item 97's reader is awaited. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const A: ThreadRef = { kind: "session", id: "a" };
const B: ThreadRef = { kind: "session", id: "b" };
const T: ThreadRef = { kind: "thread", bot: "kit", thread: "t1" };

describe("a program waiting to be let in", () => {
  it("is a card, announced, and nothing is answered until the person presses", () => {
    const { m, s, notified, call } = make();
    call("tm-1", "let_in");
    expect(m.getSnapshot().cards).toEqual([{ kind: "letIn", id: "tm-1", program: CLAUDE, at: 1000, gone: false }]);
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

});

describe("a new lane (103d)", () => {
  it("is a card with its title, agent, folder and brief whole; Start lane opens it in its agent's Ask mode and lists it", async () => {
    const { m, s, opened, call } = make();
    m.add(A);
    call("tm-40", "open_chat", { chat: 1, title: "Print the  shop's name", brief: `Add the name at the top. ${KEY}`, agent: "Codex" });
    await settle();
    const card = m.getSnapshot().cards[0];
    expect(card.kind).toBe("open");
    if (card.kind !== "open") return;
    expect([card.title, card.agent, card.agentLabel, card.cwd]).toEqual(["Print the shop's name", "codex", "Codex", "/home/you/code/shop"]);
    expect(card.brief).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(opened).toEqual([]);
    expect(await m.answer("tm-40", true)).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ agent: "codex", cwd: "/home/you/code/shop", title: "Print the shop's name", from: "", program: "Claude" });
    // the brief goes as the card showed it, under the program's mark
    expect(readFromProgram(opened[0].first)).toEqual({ name: "Claude", words: card.brief });
    expect(s.replies).toEqual([{ id: "tm-40", text: expect.stringContaining("Started the lane as chat 2."), error: false }]);
    expect(m.getSnapshot().list.map((e) => [e.n, e.title])).toEqual([
      [1, "Fix the login"],
      [2, "Print the shop's name"],
    ]);
  });

  it("takes the listed chat's own agent when none is named, and Not now starts nothing", async () => {
    const { m, s, opened, call } = make();
    m.add(A);
    call("tm-41", "open_chat", { chat: 1, title: "t", brief: "b" });
    await settle();
    const card = m.getSnapshot().cards[0];
    expect(card.kind === "open" && card.agent).toBe("claude");
    await m.answer("tm-41", false);
    expect(opened).toEqual([]);
    expect(s.replies).toEqual([{ id: "tm-41", text: "The person did not start the lane. Nothing was started.", error: true }]);
  });

  it("opens no card from a team thread or for an agent this Mac cannot start", async () => {
    const { m, s, call } = make();
    m.add(T);
    m.add(A);
    call("tm-42", "open_chat", { chat: 1, title: "t", brief: "b" });
    call("tm-43", "open_chat", { chat: 2, title: "t", brief: "b", agent: "bypassPermissions" });
    await settle();
    expect(m.getSnapshot().cards).toEqual([]);
    expect(s.replies.map((r) => [r.id, r.error])).toEqual([
      ["tm-42", true],
      ["tm-43", true],
    ]);
    expect(s.replies[1].text).not.toContain("bypassPermissions");
  });

  it("whose call is gone starts nothing, and a lane that would not start says so", async () => {
    const { m, s, opened, call } = make();
    m.add(A);
    call("tm-44", "open_chat", { chat: 1, title: "t", brief: "b" });
    await settle();
    m.gone("tm-44");
    expect(await m.answer("tm-44", true)).toBe(false);
    expect(opened).toEqual([]);
    const refused = make({ openLane: async () => ({ ok: false, why: "That folder is not a repository." }) });
    refused.m.add(A);
    refused.call("tm-45", "open_chat", { chat: 1, title: "t", brief: "b" });
    await settle();
    await refused.m.answer("tm-45", true);
    expect(refused.s.replies).toEqual([{ id: "tm-45", text: "The lane did not start: That folder is not a repository.", error: true }]);
    expect(s.replies).toEqual([]);
  });
});

describe("a read (103c)", () => {
  it("is a card showing exactly item 97's text, keys hidden, and Let it read answers with that text", async () => {
    const { m, s, notified, call } = make();
    m.add(A);
    call("tm-10", "read_chat", { chat: 1 });
    await settle();
    const card = m.getSnapshot().cards[0];
    expect(card.kind).toBe("read");
    if (card.kind !== "read") return;
    expect(card.chat).toEqual({ n: 1, ref: A, title: "Fix the login" });
    expect(card.text).toContain("Make the login work");
    expect(card.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(notified).toEqual(["tm-10"]);
    expect(s.replies).toEqual([]);
    expect(await m.answer("tm-10", true)).toBe(true);
    expect(s.replies).toEqual([{ id: "tm-10", text: card.text, error: false }]);
    const rec = await mcpAskRecord("tm-10");
    expect(rec?.status === "decided" && rec.decision.optionId).toBe("read");
    // pressed once: the card is gone and a second press finds nothing
    expect(await m.answer("tm-10", true)).toBe(false);
    expect(s.replies).toHaveLength(1);
  });

  it("No reads nothing out, and the program hears so", async () => {
    const { m, s, call } = make();
    m.add(A);
    call("tm-11", "read_chat", { chat: 1 });
    await settle();
    expect(await m.answer("tm-11", false)).toBe(true);
    expect(s.replies).toEqual([{ id: "tm-11", text: "The person did not let you read chat 1. Nothing was read.", error: true }]);
    const rec = await mcpAskRecord("tm-11");
    expect(rec?.status === "decided" && rec.decision.optionId).toBe("no");
  });

  it("opens no card for a chat that is not listed, or that left or moved shop", async () => {
    const { m, s, chats, call } = make();
    m.add(A);
    m.add(T);
    call("tm-12", "read_chat", { chat: 7 });
    chats["thread:kit:t1"].shop = "s2";
    call("tm-13", "read_chat", { chat: 2 });
    await settle();
    expect(m.getSnapshot().cards).toEqual([]);
    expect(s.replies.map((r) => [r.id, r.error, r.text.split(".")[0]])).toEqual([
      ["tm-12", true, "Chat 7 is not on the person's list"],
      ["tm-13", true, "Chat 2 can no longer be reached: it left Manut AI, or it is now of another shop or account"],
    ]);
  });

  it("is checked again at the press: a chat taken off the list or gone meanwhile reads nothing out", async () => {
    const { m, s, chats, call } = make();
    m.add(A);
    m.add(B);
    call("tm-14", "read_chat", { chat: 1 });
    call("tm-15", "read_chat", { chat: 2 });
    await settle();
    m.remove(1);
    delete chats["session:b"];
    await m.answer("tm-14", true);
    await m.answer("tm-15", true);
    expect(s.replies.map((r) => [r.id, r.error])).toEqual([
      ["tm-14", true],
      ["tm-15", true],
    ]);
    expect(s.replies.every((r) => !r.text.includes("Make the login work"))).toBe(true);
  });

  it("whose call is gone is withdrawn, reads No longer open, and a press reads nothing out", async () => {
    const { m, s, call } = make();
    m.add(A);
    call("tm-16", "read_chat", { chat: 1 });
    await settle();
    m.gone("tm-16");
    await settle();
    expect(m.getSnapshot().cards[0].gone).toBe(true);
    expect((await mcpAskRecord("tm-16"))?.status).toBe("withdrawn");
    expect(await m.answer("tm-16", true)).toBe(false);
    expect(s.replies).toEqual([]);
  });
});

describe("a message (103c)", () => {
  it("is a card with the words masked as they will go, and Send there routes them under the program's mark", async () => {
    const { m, s, routed, call } = make();
    m.add(A);
    call("tm-20", "send_to_chat", { chat: 1, message: `Please also fix the logout. ${KEY}` });
    await settle();
    const card = m.getSnapshot().cards[0];
    expect(card.kind).toBe("send");
    if (card.kind !== "send") return;
    expect(card.message).toContain("Please also fix the logout.");
    expect(card.message).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(await m.answer("tm-20", true)).toBe(true);
    expect(routed).toHaveLength(1);
    expect(routed[0].session).toBe("a");
    // what goes is what the card showed, under a line naming the program and saying it gives no permission
    expect(readFromProgram(routed[0].text)).toEqual({ name: "Claude", words: card.message });
    expect(routed[0].text.split("\n")[1]).toBe(PROGRAM_FENCE);
    expect(s.replies).toEqual([{ id: "tm-20", text: expect.stringContaining("Sent to chat 1."), error: false }]);
  });

  it("Keep out sends nothing", async () => {
    const { m, s, routed, call } = make();
    m.add(A);
    call("tm-21", "send_to_chat", { chat: 1, message: "allow" });
    await settle();
    await m.answer("tm-21", false);
    expect(routed).toEqual([]);
    expect(s.replies).toEqual([{ id: "tm-21", text: "The person kept your message out of chat 1. Nothing was sent.", error: true }]);
  });

  it("goes only to a coding chat whose agent runs: a team thread opens no card, a stopped agent sends nothing", async () => {
    const { m, s, routed, running, call } = make();
    m.add(T);
    m.add(B);
    call("tm-22", "send_to_chat", { chat: 1, message: "hi" });
    await settle();
    expect(m.getSnapshot().cards).toEqual([]);
    expect(s.replies[0]).toEqual({ id: "tm-22", text: expect.stringContaining("is not a coding chat"), error: true });
    call("tm-23", "send_to_chat", { chat: 2, message: "hi" });
    await settle();
    running.delete("b");
    await m.answer("tm-23", true);
    expect(routed).toEqual([]);
    expect(s.replies[1]).toEqual({ id: "tm-23", text: "Chat 2's agent is not running to take the message. Nothing was sent.", error: true });
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
