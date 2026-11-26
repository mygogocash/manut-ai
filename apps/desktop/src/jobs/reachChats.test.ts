// Item 102k's chats that reach other chats (docs/several-agents.md, "5. What an agent may do to other chats", rule R10). Two halves:
// the cards' rules against a stand-in reader whose every call is counted (a chat that is not listed, or of another shop, is refused
// before anything of it is read), and the sessions store against a fake shell, where a read, a send and an open each happen only on
// their card's press, a message that arrives in another chat never answers its waiting ask whatever its words, and an opened lane is
// an ordinary lane in its agent's asking mode.
import { beforeEach, describe, expect, it } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { answerSoFar, createStore, selectAsks, type BridgeLike, type ReachAskItem } from "../state/store";
import { createSessions } from "../sessions/sessions";
import { ASK_MODE } from "../sessions/controls";
import type { ChatEvent, SessionHost } from "../sessions/host";
import type { SessionRec } from "../sessions/agents";
import type { ContextReader, ReadMsg, ThreadRef } from "../chat/box/threadContext";
import type { Scope } from "../chat/box/carry";
import { setCarryStorage, throughOf } from "../chat/box/carry";
import { createReach, crossing, type OpenLane } from "./reachChats";
import { reachAskRecord, resetReachAsks } from "./reachAsks";
import { addEntry, readFromChat, REACH_HEAD, withoutReachNote, type ReachEntry } from "./reachList";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const tick = () => new Promise((r) => setTimeout(r, 0));
const block = (word: string, o: Record<string, unknown>) => `\`\`\`manut-${word}\n${JSON.stringify(o)}\n\`\`\``;
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

beforeEach(() => {
  resetLanes();
  resetReachAsks();
  setCarryStorage(memory());
});

describe("which way content may pass (item 97, item 121)", () => {
  it.each([
    { name: "two coding chats on no account", listed: {}, now: {}, asker: {}, why: null },
    { name: "a team chat read into a coding chat", listed: { shop: "a" }, now: { shop: "a" }, asker: { account: "claude:work" }, why: null },
    { name: "a team chat listed under one shop, now of another", listed: { shop: "a" }, now: { shop: "b" }, asker: {}, why: "shop" },
    { name: "a coding chat that took in another shop", listed: { shop: "a" }, now: { shop: "a" }, asker: { through: ["b"] }, why: "shop" },
    { name: "another account of the same agent", listed: { account: "claude:work" }, now: { account: "claude:work" }, asker: { account: "claude:home" }, why: "account" },
    { name: "an account that changed since it was listed", listed: { account: "claude:work" }, now: { account: "claude:home" }, asker: {}, why: "account" },
    { name: "accounts of two agents", listed: { account: "codex:me" }, now: { account: "codex:me" }, asker: { account: "claude:work" }, why: null },
  ])("$name: $why", ({ listed, now, asker, why }) => {
    expect(crossing(listed as Scope, now as Scope, asker as Scope)).toBe(why);
  });
});

// ---- the cards' rules, against a counted stand-in reader ------------------------------------------------------------------

/** A chat to ask from (`s1`), a stand-in reader that counts every call by name, and the actions counted too. */
function rig(over: { scopes?: Record<string, Scope>; titles?: Record<string, string> } = {}) {
  const store = createStore(bridge);
  const recs = new Map<string, SessionRec>([["s1", { id: "s1", agent: "claude", cwd: "/w/app", startedAt: 0, status: "running", view: "chat", linkId: "l1" }]]);
  const scopes: Record<string, Scope> = { "agent:s1": {}, ...over.scopes };
  const calls: string[] = [];
  const keyOf = (ref: ThreadRef) => (ref.kind === "session" ? `agent:${ref.id}` : `fold:${ref.bot}:${ref.thread}`);
  const msgs: Record<string, ReadMsg[]> = {};
  const reader: ContextReader = {
    chatKey: (ref) => (calls.push("chatKey"), keyOf(ref)),
    title: (ref) => (calls.push("title"), over.titles?.[keyOf(ref)] ?? keyOf(ref)),
    held: (key) => (calls.push("held"), msgs[key] ?? []),
    read: async () => (calls.push("read"), []),
    ask: () => (calls.push("ask"), null),
    lane: async () => (calls.push("lane"), null),
    scope: (key) => (calls.push("scope"), scopes[key] ?? {}),
  };
  const did: { sendTo: string[]; route: string[]; open: OpenLane[] } = { sendTo: [], route: [], open: [] };
  const reach = createReach({
    rec: (id) => recs.get(id),
    chatKey: (id) => (recs.has(id) ? `agent:${id}` : undefined),
    store: () => store,
    agents: () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    models: () => [],
    efforts: () => [],
    reader: () => reader,
    setList: (id, list) => recs.set(id, { ...recs.get(id)!, reach: list.length ? [...list] : undefined }),
    sendTo: async (_id, text) => (did.sendTo.push(text), true),
    route: async (id, text) => (did.route.push(`${id}:${text}`), true),
    running: () => true,
    openLane: async (p) => (did.open.push(p), { ok: true, id: "s9" }),
    laneScope: () => ({}),
  });
  const list = (entries: Omit<ReachEntry, "n">[]) => recs.set("s1", { ...recs.get("s1")!, reach: entries.reduce<ReachEntry[]>((l, e) => addEntry(l, e).list, []) });
  /** A whole turn of the asking chat's agent, through the reach cards' before and after, as the sessions store hands them over. */
  const turn = async (text: string, outcome = "done") => {
    const send = (ev: ChatEvent) => store.dispatch({ type: "event", ev: { ...ev, bot: "agent:s1" } as never, now: Date.now() });
    send(reach.before("s1", { event: "turn.start" }));
    send(reach.before("s1", { event: "message", id: `m${Math.random()}`, text }));
    const end = { event: "turn.end", outcome };
    send(reach.before("s1", end));
    await reach.after("s1", end);
  };
  const chat = () => store.getState().chats["agent:s1"];
  const cards = () => (chat()?.items ?? []).filter((i): i is ReachAskItem => i.kind === "reachAsk");
  const lines = () => (chat()?.items ?? []).flatMap((i) => (i.kind === "system" ? [i.text] : []));
  return { store, recs, scopes, calls, msgs, did, reach, list, turn, chat, cards, lines };
}

const read = (chat: string) => `Let me look at the other chat.\n\n${block("read", { chat })}`;

describe("a read (R10)", () => {
  it("of a chat that is not listed is refused before the reader is called at all", async () => {
    const r = rig();
    r.list([{ ref: { kind: "session", id: "s2" }, title: "Receipt layout", scope: {} }]);
    r.calls.length = 0;
    await r.turn(read("Payments"));
    expect(r.calls).toEqual([]);
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toBe("Kit asked to read “Payments”, which is not on the list of chats it may reach. Nothing was read.");
    // nor by a session id or a chat key the agent guessed
    await r.turn(read("s2"));
    await r.turn(read("agent:s2"));
    expect(r.calls).toEqual([]);
    expect(r.did.sendTo).toEqual([]);
  });

  it("of a chat now of another shop is refused before anything of it is read, and so is a press after the shop changed", async () => {
    const team = { kind: "thread" as const, bot: "buddy", thread: "t1" };
    const r = rig({ scopes: { "fold:buddy:t1": { shop: "khao-man-gai" } } });
    r.list([{ ref: team, title: "Orders this week", scope: { shop: "baanmali" } }]);
    r.calls.length = 0;
    await r.turn(read("1"));
    expect(r.calls.filter((c) => ["held", "read", "lane", "ask"].includes(c))).toEqual([]);
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toContain("which is now a chat of another shop. Manut AI never reaches across shops");

    // listed and opened under the same shop, then the shop changes before the press: refused, the card is gone, nothing sent
    r.scopes["fold:buddy:t1"] = { shop: "baanmali" };
    await r.turn(read("1"));
    const [card] = r.cards();
    expect(card.ask.kind).toBe("read");
    r.scopes["fold:buddy:t1"] = { shop: "khao-man-gai" };
    expect(await r.reach.answer("s1", card.id, true)).toEqual({ ok: false, refused: "shop" });
    expect(r.cards()[0].done).toBe("gone");
    expect(r.did.sendTo).toEqual([]);
    expect((await reachAskRecord(card.id))?.status).toBe("withdrawn");
  });

  it("of a team chat leaves the chat that read it carrying that shop on (item 121)", async () => {
    const team = { kind: "thread" as const, bot: "buddy", thread: "t1" };
    const r = rig({ scopes: { "fold:buddy:t1": { shop: "baanmali" } } });
    r.list([{ ref: team, title: "Orders this week", scope: { shop: "baanmali" } }]);
    await r.turn(read("Orders this week"));
    expect(throughOf("agent:s1")).toEqual([]);
    expect(await r.reach.answer("s1", r.cards()[0].id, true)).toEqual({ ok: true });
    expect(throughOf("agent:s1")).toEqual(["baanmali"]);
  });

  it("of a coding chat under another account of the same agent is refused", async () => {
    const r = rig({ scopes: { "agent:s1": { account: "claude:home" }, "agent:s2": { account: "claude:work" } } });
    r.list([{ ref: { kind: "session", id: "s2" }, title: "Receipt layout", scope: { account: "claude:work" } }]);
    r.recs.set("s2", { id: "s2", agent: "claude", cwd: "/w/app", startedAt: 0, status: "running", view: "chat" });
    await r.turn(read("1"));
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toContain("runs under another account");
  });

  it("shows item 97's text on its card, sends nothing until Let Kit read, then exactly that text, once", async () => {
    const r = rig({ titles: { "agent:s2": "Receipt layout" } });
    r.recs.set("s2", { id: "s2", agent: "codex", cwd: "/w/app", startedAt: 0, status: "running", view: "chat", linkId: "l2" });
    r.msgs["agent:s2"] = [
      { role: "user", text: "Print the receipt in Thai" },
      { role: "assistant", text: "Done: the receipt prints in Thai. Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 was in .env." },
    ];
    r.list([{ ref: { kind: "session", id: "s2" }, link: "l2", title: "Receipt layout", scope: {} }]);
    await r.turn(read("1"));
    const [card] = r.cards();
    expect(card.ask.kind === "read" && card.ask.target.title).toBe("Receipt layout");
    const text = card.ask.kind === "read" ? card.ask.text : "";
    expect(text).toContain('Context from the chat "Receipt layout":');
    expect(text).toContain("First message: Print the receipt in Thai");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r.did.sendTo).toEqual([]);
    expect((await reachAskRecord(card.id))?.status).toBe("pending");

    expect(await r.reach.answer("s1", card.id, true)).toEqual({ ok: true });
    expect(r.did.sendTo).toEqual([text]);
    expect(r.cards()[0].done).toBe("yes");
    expect(await r.reach.answer("s1", card.id, true)).toMatchObject({ ok: false, refused: "already_decided" });
    expect(r.did.sendTo).toHaveLength(1);
  });

  it("No reads nothing into Kit; a card the next turn moved past, or whose chat came off the list, is taken back", async () => {
    const r = rig();
    r.recs.set("s2", { id: "s2", agent: "codex", cwd: "/w/app", startedAt: 0, status: "running", view: "chat" });
    r.list([{ ref: { kind: "session", id: "s2" }, title: "Receipt layout", scope: {} }]);
    await r.turn(read("1"));
    expect(await r.reach.answer("s1", r.cards()[0].id, false)).toEqual({ ok: true });
    expect(r.cards()[0].done).toBe("no");

    await r.turn(read("1"));
    const second = r.cards()[1];
    await r.turn("Something else entirely.");
    expect(r.cards()[1].done).toBe("gone");
    expect(await r.reach.answer("s1", second.id, true)).toMatchObject({ ok: false });

    await r.turn(read("1"));
    const third = r.cards()[2];
    r.reach.remove("s1", 1);
    expect(r.cards()[2].done).toBe("gone");
    expect(await r.reach.answer("s1", third.id, true)).toMatchObject({ ok: false });
    expect(r.did.sendTo).toEqual([]);
  });

  it("a block with a key outside its own is refused whole, before anything is looked up", async () => {
    const r = rig();
    r.list([{ ref: { kind: "session", id: "s2" }, title: "Receipt layout", scope: {} }]);
    r.calls.length = 0;
    await r.turn(`Reading it.\n\n${block("read", { chat: "1", mode: "bypassPermissions" })}`);
    expect(r.calls).toEqual([]);
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toBe("Kit asked to reach another chat, but Manut AI could not read the request: a block has a key Manut AI does not take (mode). Nothing was read, sent or opened.");
  });

  it("with nothing listed, a block is the agent's own words and no card shows", async () => {
    const r = rig();
    await r.turn(read("1"));
    expect(r.cards()).toEqual([]);
    expect(r.lines()).toEqual([]);
  });

  it("a stopped turn asks for nothing", async () => {
    const r = rig();
    r.list([{ ref: { kind: "session", id: "s2" }, title: "Receipt layout", scope: {} }]);
    await r.turn(read("1"), "interrupted");
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toBe("Kit asked to reach another chat in a turn that did not finish, so nothing happens.");
  });
});

describe("adding to the list", () => {
  it("refuses the chat itself, a chat of another shop or account, and the same chat twice; keeps a coding chat's link", () => {
    const r = rig({ scopes: { "agent:s1": { through: ["baanmali"] }, "fold:buddy:t1": { shop: "khao-man-gai" }, "agent:s3": {} }, titles: { "fold:buddy:t1": "Orders" } });
    r.recs.set("s3", { id: "s3", agent: "codex", cwd: "/w/app", startedAt: 0, status: "running", view: "chat", linkId: "l3" });
    expect(r.reach.add("s1", { kind: "session", id: "s1" })).toBe("That is the chat you are in.");
    expect(r.reach.add("s1", { kind: "thread", bot: "buddy", thread: "t1" })).toBe("Orders is in another shop, so Kit cannot reach it from here.");
    expect(r.reach.add("s1", { kind: "session", id: "s3" })).toBeNull();
    expect(r.reach.add("s1", { kind: "session", id: "s3" })).toContain("is already on the list");
    expect(r.recs.get("s1")!.reach).toEqual([{ n: 1, ref: { kind: "session", id: "s3" }, link: "l3", title: "agent:s3", scope: {} }]);
  });

  it("a later chat that took a listed session's id is not the chat that was listed", async () => {
    const r = rig();
    r.recs.set("s3", { id: "s3", agent: "codex", cwd: "/w/app", startedAt: 0, status: "running", view: "chat", linkId: "l3" });
    expect(r.reach.add("s1", { kind: "session", id: "s3" })).toBeNull();
    r.recs.set("s3", { ...r.recs.get("s3")!, linkId: "l99" });
    r.calls.length = 0;
    await r.turn(read("1"));
    expect(r.cards()).toEqual([]);
    expect(r.lines().at(-1)).toBe("Kit asked to read “agent:s3”, which is gone. Nothing was read.");
    expect(r.calls.filter((c) => ["held", "read", "lane", "ask"].includes(c))).toEqual([]);
  });
});

// ---- the sessions store, against a fake shell -----------------------------------------------------------------------------

const DEV = "/w/baanmali-preorder";
const laneDir = (branch: string) => `/w/.manut/lanes/baanmali-preorder/${branch.slice(4)}`;

async function setup(over: { echo?: boolean } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = memory();
  resetKitProjects();
  resetKitAsks();
  resetLanes();
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const hostOf = new Map<number, string>();
  const inputs: { id: string; kind: string; text?: string }[] = [];
  const starts: { agent: string; cwd: string; mode?: string }[] = [];
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [
      { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
      { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
    ],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (cwd === DEV ? "main" : "kit/x"),
    chatStart: async (agent: string, cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string, _s?: boolean, mode?: string) => {
      starts.push({ agent, cwd, mode });
      sinks.set(session ?? "", on);
      hostOf.set(sinks.size, session ?? "");
      return sinks.size;
    },
    chatInput: async (h: number, i: { kind: string; text?: string }) => {
      inputs.push({ id: hostOf.get(h) ?? "?", kind: i.kind, ...(i.text !== undefined ? { text: i.text } : {}) });
      // as an agent does: a message starts its turn at once
      if (over.echo && i.kind === "send") sinks.get(hostOf.get(h) ?? "")?.({ event: "turn.start" });
    },
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneWorktree: async (_cwd: string, names: string[]) =>
      ({ branch: names[0], base: "main", dir: laneDir(names[0]), worktree: laneDir(names[0]), left: 0, from: "", local: "", config: 0, stayed: 0 }) satisfies LaneMade,
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const startIn = async (text: string, agent = "claude") => {
    const id = ss.draft(agent as never);
    ss.setDraft(id, { cwd: DEV });
    await ss.start(id, text);
    return id;
  };
  const chat = (id: string) => store.getState().chats[ss.chatKey(id)!];
  const emit = (id: string, e: ChatEvent) => sinks.get(id)?.(e);
  const turn = async (id: string, text: string) => {
    emit(id, { event: "turn.start" });
    for (let k = 0; k < text.length; k += 40) emit(id, { event: "delta", text: text.slice(k, k + 40) });
    emit(id, { event: "message", id: `m${Math.random()}`, text });
    emit(id, { event: "turn.end", outcome: "done" });
    await tick();
    await tick();
  };
  const cards = (id: string) => (chat(id)?.items ?? []).filter((i): i is ReachAskItem => i.kind === "reachAsk");
  const users = (id: string) => (chat(id)?.items ?? []).flatMap((i) => (i.kind === "user" ? [i] : []));
  const row = (id: string) => ss.getState().list.find((r) => r.id === id)!;
  return { ss, store, inputs, starts, startIn, chat, emit, turn, cards, users, row };
}

describe("in the sessions store", () => {
  it("tells the agent its list with each message, and keeps the bubble what was typed", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    expect(t.ss.reachOffered(a)).toBe(true);
    expect(t.ss.addReach(a, { kind: "session", id: b })).toBeNull();
    await t.ss.send(a, "Check the receipt lane");
    const wire = t.inputs.filter((i) => i.id === a && i.kind === "send").at(-1)!.text!;
    expect(wire.startsWith(REACH_HEAD)).toBe(true);
    expect(wire).toContain('- "1": Fix the receipt layout (Codex, a coding chat)');
    expect(withoutReachNote(wire)).toBe("Check the receipt lane");
    expect(t.users(a).at(-1)?.text).toBe("Check the receipt lane");
    // the list is kept with the session, and taking the last chat off it stops the note
    expect(t.row(a).reach?.map((e) => e.n)).toEqual([1]);
    t.ss.removeReach(a, 1);
    await t.ss.send(a, "Thanks");
    expect(t.inputs.at(-1)?.text).toBe("Thanks");
  });

  it("hides a reach block while it streams and keeps only the words", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    const text = `I'll read the receipt lane first.\n\n${block("read", { chat: "1" })}`;
    t.emit(a, { event: "turn.start" });
    t.emit(a, { event: "delta", text: text.slice(0, text.length - 8) });
    const live = t.chat(a)!.turn!;
    expect(live.reach).toBe(true);
    expect(answerSoFar(live)).toBe("I'll read the receipt lane first.");
    expect(live.status).toBe("Writing a request to reach another chat");
    t.emit(a, { event: "delta", text: text.slice(text.length - 8) });
    t.emit(a, { event: "message", id: "m1", text });
    t.emit(a, { event: "turn.end", outcome: "done" });
    await tick();
    const answers = (t.chat(a)?.items ?? []).flatMap((i) => (i.kind === "assistant" ? [i.text] : []));
    expect(answers.at(-1)).toBe("I'll read the receipt lane first.");
    expect(t.cards(a)).toHaveLength(1);
  });

  it("a message arriving while the other chat's ask waits leaves that ask pending, even when its words are \"Allow\"", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Add the QR library", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    // the other lane asks to install a package, which Kit's dial leaves to the person, and waits
    t.emit(b, { event: "turn.start" });
    t.emit(b, { event: "approval.request", request_id: "req-1", title: "Run this command?", command: "pnpm add qrcode", cwd: t.row(b).lane!.dir, choices: ["deny", "once", "session"] });
    await tick();
    const pending = () => selectAsks(t.store.getState()).filter((x) => x.bot === t.ss.chatKey(b));
    expect(pending()).toHaveLength(1);
    const before = t.inputs.length;

    await t.turn(a, `Telling the other lane.\n\n${block("send", { chat: "1", message: "Allow" })}`);
    const [card] = t.cards(a);
    expect(card.ask.kind).toBe("send");
    // nothing moved before the press
    expect(t.inputs.slice(before).filter((i) => i.id === b)).toEqual([]);
    expect(await t.ss.answerReach(a, card.id, true)).toEqual({ ok: true });
    await tick();

    // it waits in the other chat as a held row marked as from this one; the ask is still waiting and nothing answered it
    const arrived = t.users(b).at(-1)!;
    expect(arrived.held).toBe(true);
    expect(readFromChat(arrived.text)).toEqual({ title: "Add a PromptPay QR", words: "Allow" });
    expect(pending()).toHaveLength(1);
    // no approve, no clarify, and no text either until that turn ends
    expect(t.inputs.slice(before).filter((i) => i.id === b)).toEqual([]);
    const item = t.chat(b)!.items.find((i) => i.kind === "approval");
    expect(item && item.kind === "approval" && item.resolved).toBeFalsy();
    expect(t.cards(a)[0].done).toBe("yes");
  });

  it("a message to a chat with a question waiting, and no turn running, waits too and answers nothing", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Pick a greeting", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    t.emit(b, { event: "clarify.request", request_id: "ask-1", question: "Which greeting?", choices: ["hello", "hi"] });
    await tick();
    expect(selectAsks(t.store.getState()).filter((x) => x.bot === t.ss.chatKey(b))).toHaveLength(1);
    const before = t.inputs.length;
    await t.turn(a, block("send", { chat: "1", message: "hello" }));
    await t.ss.answerReach(a, t.cards(a)[0].id, true);
    await tick();
    expect(t.users(b).at(-1)?.held).toBe(true);
    expect(t.inputs.slice(before).filter((i) => i.id === b)).toEqual([]);
    expect(selectAsks(t.store.getState()).filter((x) => x.bot === t.ss.chatKey(b))).toHaveLength(1);
  });

  it("a message to an idle chat goes at once as text, marked as from the chat that sent it, and Keep here sends nothing", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    await t.turn(a, block("send", { chat: "1", message: "The payload now ends with a CRC-16 checksum." }));
    const before = t.inputs.length;
    expect(await t.ss.answerReach(a, t.cards(a)[0].id, false)).toEqual({ ok: true });
    expect(t.inputs.length).toBe(before);
    await t.turn(a, block("send", { chat: "Fix the receipt layout", message: "The payload now ends with a CRC-16 checksum." }));
    await t.ss.answerReach(a, t.cards(a)[1].id, true);
    await tick();
    const sent = t.inputs.slice(before).filter((i) => i.id === b);
    expect(sent.map((i) => i.kind)).toEqual(["send"]);
    expect(readFromChat(sent[0].text!)).toEqual({ title: "Add a PromptPay QR", words: "The payload now ends with a CRC-16 checksum." });
    expect(t.users(b).at(-1)?.held).toBeFalsy();
  });

  it("Send there is refused while the other chat's agent is not running, and the card stays open to try again", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    await t.turn(a, block("send", { chat: "1", message: "hi" }));
    await t.ss.stopIdle(b);
    expect(await t.ss.answerReach(a, t.cards(a)[0].id, true)).toEqual({ ok: false, refused: "notRunning" });
    expect(t.cards(a)[0].done).toBeUndefined();
  });

  it("Start lane opens an ordinary lane on its agent in its asking mode with the brief as its first message; nothing before", async () => {
    const t = await setup();
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    await t.turn(a, block("open", { title: "Thai date on the receipt", brief: "Show the Thai Buddhist date in src/receipt.tsx.", agent: "codex" }));
    const [card] = t.cards(a);
    expect(card.ask.kind === "open" && card.ask.lane).toMatchObject({ title: "Thai date on the receipt", agent: "codex", own: false });
    const n = t.starts.length;
    const list = t.ss.getState().list.length;
    expect(await t.ss.answerReach(a, card.id, false)).toEqual({ ok: true });
    expect(t.starts.length).toBe(n);

    await t.turn(a, block("open", { title: "Thai date on the receipt", brief: "Show the Thai Buddhist date in src/receipt.tsx.", agent: "codex" }));
    expect(t.starts.length).toBe(n);
    expect(t.ss.getState().list.length).toBe(list);
    expect(await t.ss.answerReach(a, t.cards(a)[1].id, true)).toEqual({ ok: true });
    await tick();
    expect(t.starts.length).toBe(n + 1);
    const started = t.starts.at(-1)!;
    expect(started).toEqual({ agent: "codex", cwd: expect.stringMatching(/^\/w\/\.manut\/lanes\/baanmali-preorder\//), mode: ASK_MODE.codex });
    const lane = t.cards(a)[1].lane!;
    expect(t.row(lane)).toMatchObject({ agent: "codex", title: "Thai date on the receipt", openedBy: a });
    expect(t.row(lane).lane?.dir).toBe(started.cwd);
    const first = t.inputs.filter((i) => i.id === lane && i.kind === "send")[0];
    expect(readFromChat(first.text!)).toEqual({ title: "Add a PromptPay QR", words: "Show the Thai Buddhist date in src/receipt.tsx." });
    // a second press opens nothing more
    expect(await t.ss.answerReach(a, t.cards(a)[1].id, true)).toMatchObject({ ok: false, refused: "already_decided" });
    expect(t.starts.length).toBe(n + 1);
  });

  it("a read sends that chat's text to Kit only on Let Kit read, exactly as its card showed it", async () => {
    const t = await setup({ echo: true });
    const a = await t.startIn("Add a PromptPay QR");
    const b = await t.startIn("Fix the receipt layout", "codex");
    t.ss.addReach(a, { kind: "session", id: b });
    const before = t.inputs.length;
    await t.turn(a, block("read", { chat: "1" }));
    expect(t.inputs.length).toBe(before);
    const card = t.cards(a)[0];
    await t.ss.answerReach(a, card.id, true);
    await tick();
    const sent = t.inputs.slice(before).filter((i) => i.id === a && i.kind === "send");
    expect(sent).toHaveLength(1);
    expect(withoutReachNote(sent[0].text!)).toBe(card.ask.kind === "read" ? card.ask.text : "");
    // the bubble draws it as that chat's context, folded under its title (item 97)
    expect(t.users(a).at(-1)?.text).toBe(card.ask.kind === "read" ? card.ask.text : "");
    // the turn it starts takes back the cards still open, never the one just pressed
    expect(t.chat(a)!.turn).toBeTruthy();
    expect(t.cards(a)[0].done).toBe("yes");
  });
});
