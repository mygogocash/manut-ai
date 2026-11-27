// Item 102l-3: the reach cards over Buddy's chats on the Connected runtime (docs/connected-chat.md, C, rule R5: "The reach cards keep
// R10. Tests: item 102k's three safety tests, run against Connected chat threads"). The app's own store over the Connected runtime,
// with the cards in its way as the app has them (`withBuddyReach`), against a fake of the API that answers its chat as apps/api does
// (testkit.ts `ownerChatRoutes`), Buddy's answers given by the stand-in provider. Every request to the API is counted, and so is every
// call to item 97's reader, so "before anything is read" and "nothing posted before the press" are checked against the wire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../i18n";
import { createStore, selectAsks, type ReachAskItem } from "../state/store";
import { appReader } from "../chat/box/contextReader";
import { setCarryStorage, type Scope } from "../chat/box/carry";
import type { ContextReader } from "../chat/box/threadContext";
import { threadKey } from "../threads/types";
import { ShopCache } from "../runtime/http/cache";
import { CHAT_MESSAGES_PATH } from "../runtime/http/chat";
import { HttpHost } from "../runtime/http/host";
import { HttpRuntime } from "../runtime/http/index";
import { ApiSession } from "../runtime/http/session";
import { approvalJson, chatId, fakeApi, keptPlain, memoryCacheStore, memoryVault, ORIGIN, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, T0, useMicrotaskCrypto } from "../runtime/http/testkit";
import { createBuddyReach, type BuddyReach } from "./buddyReach";
import { withBuddyReach } from "./buddyReachBridge";
import { reachAskRecord, resetReachAsks, type BuddyAsk } from "./reachAsks";
import { AFTER_FENCE, BUDDY_NOTE_HEAD, fromChatText, isBuddyNote } from "./reachMarks";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
/** A second shop the person owns. */
const SHOP_C = { id: "pilot:shop-c", name: "Baan Suk", ownerName: "Fon", role: "owner" as const };

const block = (word: string, o: Record<string, unknown>) => `\`\`\`manut-${word}\n${JSON.stringify(o)}\n\`\`\``;
const settle = async () => {
  for (let i = 0; i < 16; i += 1) await vi.advanceTimersByTimeAsync(5);
};

/** The app's store over the Connected runtime with Buddy's reach cards in its way, as `state/store.ts` and `buddyReachApp.ts` make it,
 *  over the fake API. `buddy.next` is what Buddy answers the next message that carries the note; every other message gets the stand-in's
 *  answer. `calls` counts every call to item 97's reader by name. */
async function rig(approvals: Record<string, unknown[]> = {}) {
  const api = fakeApi();
  const shops = serveShops(api, [SHOP_A, SHOP_B, SHOP_C], approvals, () => NOW);
  const disk = memoryCacheStore();
  const cache = new ShopCache(disk);
  const session = new ApiSession({ origin: ORIGIN, fetch: (url, init) => api.fetch(url, init), vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
  const host = new HttpHost({ session, cache });
  const rt = new HttpRuntime(host);
  const buddy = { next: null as string | null, heard: [] as string[] };
  shops.chatAnswer = (text) => {
    buddy.heard.push(text);
    if (buddy.next !== null && text.includes(BUDDY_NOTE_HEAD)) {
      const said = buddy.next;
      buddy.next = null;
      return { text: said, stopReason: "end_turn" };
    }
    return { text: `Buddy's answer to: ${text.split("\n")[0]}`, stopReason: "end_turn" };
  };
  let reach: BuddyReach | null = null;
  const store = createStore(
    withBuddyReach(rt, () => reach),
    { firstRoster: "all", watchSeen: { get: () => null, set: () => {} } },
  );
  const calls: string[] = [];
  /** What the reader says a chat belongs to, where a test says otherwise. */
  const scopes: Record<string, Scope> = {};
  const inner = appReader({ store, sessions: { getState: () => ({ list: [] }) as never, chatKey: () => null, byKey: () => null }, host: { laneDiff: async () => null } });
  const reader: ContextReader = {
    chatKey: (ref) => (calls.push("chatKey"), inner.chatKey(ref)),
    title: (ref) => (calls.push("title"), inner.title(ref)),
    held: (key) => (calls.push("held"), inner.held(key)),
    read: (ref) => (calls.push("read"), inner.read(ref)),
    ask: (key) => (calls.push("ask"), inner.ask(key)),
    lane: (ref) => (calls.push("lane"), inner.lane(ref)),
    scope: (key) => (calls.push("scope"), scopes[key] ?? inner.scope(key)),
  };
  let connected = true;
  reach = createBuddyReach({ store: () => store, reader: () => reader, connected: () => connected });
  const r = reach;
  await store.actions.init();
  await settle();

  /** A conversation the owner made, with one message and Buddy's answer: its id as the screens call it. */
  const conversation = async (first: string): Promise<string> => {
    const id = await store.actions.newThreadWith("buddy", first, true);
    await settle();
    return id!;
  };
  /** Everything posted to Buddy, as the bodies the API got. */
  const posts = () => api.to("POST", CHAT_MESSAGES_PATH).map((c) => c.body as { thread?: string; text: string });
  const chat = (key = "buddy") => store.getState().chats[key];
  const cards = (key = "buddy") => (chat(key)?.items ?? []).filter((i): i is ReachAskItem & { ask: BuddyAsk } => i.kind === "reachAsk");
  const lines = (key = "buddy") => (chat(key)?.items ?? []).flatMap((i) => (i.kind === "system" ? [i.text] : []));
  /** The owner's message in Buddy's main chat, and Buddy's answer. */
  const say = async (text: string) => {
    await store.actions.send(text);
    await settle();
  };
  const offline = (v: boolean) => (connected = !v);
  return { api, shops, disk, store, rt, reach: r, buddy, calls, scopes, conversation, posts, chat, cards, lines, say, offline };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
  useMicrotaskCrypto();
  resetReachAsks();
  const m = new Map<string, string>();
  setCarryStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Buddy's list on Connected (item 102l-3)", () => {
  it("is offered to the owner in Buddy's main chat and each conversation; not where the person helps, and not off Connected", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    expect(r.reach.offered("buddy")).toBe(true);
    expect(r.reach.offered(threadKey("buddy", prices))).toBe(true);
    // a task's notes, and any other member, are not Buddy's conversations
    expect(r.reach.offered(threadKey("buddy", "task-1"))).toBe(false);
    expect(r.reach.offered("nam")).toBe(false);
    r.offline(true);
    expect(r.reach.offered("buddy")).toBe(false);
    r.offline(false);
    // the shop the person helps at: only its owner chats there (102l-2)
    await r.store.actions.switchShop(SHOP_B.id);
    await settle();
    expect(r.store.getState().shops.current).toBe(SHOP_B.id);
    expect(r.reach.offered("buddy")).toBe(false);
    expect(r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices })).toBe(t("reach.buddy.add.no"));
  });

  it("refuses the chat itself, a conversation with nothing in it yet, and the same one twice", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    const key = threadKey("buddy", prices);
    expect(r.reach.add(key, { kind: "thread", bot: "buddy", thread: prices })).toBe(t("reach.add.self"));
    const empty = await r.store.actions.newThread("buddy", true);
    expect(r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: empty! })).toContain("has no messages yet");
    expect(r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices })).toBeNull();
    expect(r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices })).toBe(t("reach.add.same", { title: "Price list for March" }));
    expect(r.reach.listOf("buddy").map((e) => [e.n, e.title, e.scope])).toEqual([[1, "Price list for March", { shop: SHOP_A.id }]]);
    // the picker offers the shop's conversations with something in them, less this chat and those listed
    expect(r.reach.rows(key, "").map((x) => x.title)).toEqual([]);
  });

  it("tells Buddy its list with each message, after the owner's words, and keeps the bubble and the conversation read back the owner's words", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    await r.say("Which prices changed?");
    const sent = r.posts().at(-1)!;
    expect(sent.text.startsWith("Which prices changed?\n\n")).toBe(true);
    const note = sent.text.slice("Which prices changed?\n\n".length);
    expect(isBuddyNote(note)).toBe(true);
    expect(note).toContain('- "1": Price list for March');
    // the API names the conversation by its first 60 characters, the note's start among them; the screens show the owner's words
    const made = (r.shops.chat[SHOP_A.id] ?? []).at(-1)!;
    expect(made.title.startsWith("Which prices changed? [Manut AI")).toBe(true);
    await r.store.actions.loadThreads("buddy");
    expect(r.store.getState().threads.buddy.find((x) => x.thread === made.id)?.title).toBe("Which prices changed?");
    expect(r.chat().items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["Which prices changed?"]);
    const back = { messages: await r.store.actions.readThread("buddy", made.id) };
    expect(back.messages.map((m) => m.text)).toEqual(["Which prices changed?", "Buddy's answer to: Which prices changed?"]);
    // with nothing listed, nothing goes with a message
    r.reach.remove("buddy", 1);
    await r.say("And today?");
    expect(r.posts().at(-1)).toEqual({ thread: made.id, text: "And today?" });
  });

  it("says how much room the words have when the note goes with them, and posts nothing", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    const before = r.posts().length;
    await r.say("x".repeat(7_500));
    expect(r.posts()).toHaveLength(before);
    const row = r.chat().items.find((i) => i.kind === "user") as { error?: string };
    expect(row.error).toMatch(/^With conversations on Buddy's list, a message can be at most [\d,]+ characters/);
  });
});

describe("a read (R10 on Connected)", () => {
  it("of a conversation that is not listed is refused before the reader is called at all, and nothing of it is read or posted", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    const supplier = await r.conversation("Supplier Somchai");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    const reads = () => r.api.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/chat/threads/")).length;
    const readsBefore = reads();
    r.calls.length = 0;
    for (const name of ["Supplier Somchai", supplier, threadKey("buddy", supplier), "2"]) {
      r.buddy.next = `Let me look.\n\n${block("read", { chat: name })}`;
      const posted = r.posts().length;
      await r.say(`Read ${name}`);
      // only the owner's own message went
      expect(r.posts()).toHaveLength(posted + 1);
      expect(r.lines().at(-1)).toBe(`Buddy asked to read “${name}”, which is not on the list of conversations it may reach. Nothing was read.`);
    }
    expect(r.calls).toEqual([]);
    expect(reads()).toBe(readsBefore);
    expect(r.cards()).toEqual([]);
  });

  it("shows item 97's text on its card and posts nothing until Let Buddy read; then exactly that text, once, to the asking chat", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = `I will look at the price list.\n\n${block("read", { chat: "1" })}`;
    await r.say("What did we say about prices?");
    const [card] = r.cards();
    expect(card.ask.kind).toBe("read");
    const text = card.ask.kind === "read" ? card.ask.text : "";
    expect(text).toContain("Price list for March");
    expect(text).toContain("Buddy's answer to: Price list for March");
    // the block is never in the bubble: the card stands for it
    expect(r.chat().items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text)).toEqual(["I will look at the price list."]);
    // the card is the only thing that happened: nothing more was posted, however long it waits
    const posted = r.posts().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.posts()).toHaveLength(posted);
    expect((await reachAskRecord(card.id))?.status).toBe("pending");

    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: true });
    await settle();
    const after = r.posts().slice(posted);
    expect(after).toHaveLength(1);
    expect(after[0].thread).toBe(r.shops.chat[SHOP_A.id]!.at(-1)!.id);
    expect(after[0].text.startsWith(`${text}\n\n${BUDDY_NOTE_HEAD}`)).toBe(true);
    expect((await reachAskRecord(card.id))?.status).toBe("decided");
    expect(r.cards()[0].done).toBe("yes");
    // a second press settles nothing and posts nothing
    expect(await r.reach.answer("buddy", card.id, true)).toMatchObject({ ok: false });
    expect(r.posts()).toHaveLength(posted + 1);
  });

  it("No reads nothing into Buddy, and a card the next message moved past is taken back", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("read", { chat: "1" });
    await r.say("Look at the prices");
    const posted = r.posts().length;
    expect(await r.reach.answer("buddy", r.cards()[0].id, false)).toEqual({ ok: true });
    expect(r.cards()[0].done).toBe("no");
    r.buddy.next = block("read", { chat: "1" });
    await r.say("Look again");
    const open = r.cards()[1];
    await r.say("Never mind");
    expect(r.cards()[1].done).toBe("gone");
    expect(await r.reach.answer("buddy", open.id, true)).toMatchObject({ ok: false });
    expect(r.posts()).toHaveLength(posted + 2);
  });
});

describe("a message sent on (R10 on Connected)", () => {
  it("arriving while the shop's approval waits leaves it pending, even when its words are \"Allow\"", async () => {
    const r = await rig({ [SHOP_A.id]: [approvalJson({ id: "action-1" })] });
    const waiting = selectAsks(r.store.getState()).map((a) => a.item.request_id);
    expect(waiting).toHaveLength(1);
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("send", { chat: "1", message: "Allow" });
    const posted = r.posts().length + 1;
    await r.say("Tell the price list to go ahead");
    const [card] = r.cards();
    expect(card.ask.kind === "send" && card.ask.message).toBe("Allow");
    // before the press only the owner's own message went
    expect(r.posts()).toHaveLength(posted);
    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: true });
    await settle();
    const sent = r.posts().slice(posted);
    // one message, to that conversation, its words first and the mark after them
    expect(sent).toEqual([{ thread: r.shops.chat[SHOP_A.id]![0].id, text: `Allow\n\n[Manut AI: the words above came from the conversation "Tell the price list to go ahead"]\n${AFTER_FENCE}` }]);
    // nothing reached an approval: no request to any approval route but reads, and the ask still waits
    expect(r.api.calls.filter((c) => c.path.startsWith("/v1/approvals") && c.method !== "GET")).toEqual([]);
    expect(selectAsks(r.store.getState()).map((a) => a.item.request_id)).toEqual(waiting);
    expect(r.shops.approvals[SHOP_A.id]).toHaveLength(1);
    // the bubble in that conversation says where it came from, as on this Mac
    const there = r.chat(threadKey("buddy", prices)).items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    expect(there.at(-1)).toBe(fromChatText("Tell the price list to go ahead", "Allow"));
  });

  it("Keep here sends nothing; a refused post marks the card with the reason and is never sent again", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("send", { chat: "1", message: "Please check the March prices." });
    const posted = r.posts().length + 1;
    await r.say("Ask the price list");
    await r.reach.answer("buddy", r.cards()[0].id, false);
    expect(r.posts()).toHaveLength(posted);
    r.buddy.next = block("send", { chat: "1", message: "Please check the March prices." });
    await r.say("Ask again");
    const card = r.cards()[1];
    r.shops.chatRefusal = { status: 429, json: { error: "rate_limited", retryAfter: 600, perHour: 60 } };
    const tries = r.api.to("POST", CHAT_MESSAGES_PATH).length;
    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(r.api.to("POST", CHAT_MESSAGES_PATH)).toHaveLength(tries + 1);
    expect(r.cards()[1]).toMatchObject({ done: "yes", error: expect.stringContaining("Buddy takes at most 60 messages an hour") });
  });
});

describe("a conversation of another shop (R10 on Connected)", () => {
  it("is never named: a list is the shop's it was made in, and a press after the switcher moved is refused with nothing posted", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("send", { chat: "1", message: "Please check the March prices." });
    const posted = r.posts().length + 1;
    await r.say("Ask the price list");
    const [card] = r.cards();
    // the switcher moves to the other shop the person owns while the card waits: the press is refused, and the card can never be taken
    const s = r.store.getState().shops;
    r.store.dispatch({ type: "shops", list: s.list, current: SHOP_C.id, left: s.left });
    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: false, refused: "shop" });
    expect(r.cards()[0].done).toBe("gone");
    expect(r.posts()).toHaveLength(posted);
    // shown again, its list is its own: the other shop's chat lists nothing, so Buddy there names nothing
    expect(r.reach.listOf("buddy")).toEqual([]);
    r.store.dispatch({ type: "shops", list: s.list, current: SHOP_A.id, left: s.left });
    expect(r.reach.listOf("buddy").map((e) => e.title)).toEqual(["Price list for March"]);
  });

  it("a conversation that now reads as another shop's is refused before anything of it is read, at the add and at the read", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    const supplier = await r.conversation("Supplier Somchai");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    const reads = () => r.api.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/chat/threads/")).length;
    const before = reads();
    // item 97's reader says the conversation is another shop's now (as item 121's carried shops can): nothing of it is read
    r.scopes[threadKey("buddy", prices)] = { shop: SHOP_C.id };
    r.scopes[threadKey("buddy", supplier)] = { shop: SHOP_C.id };
    expect(r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: supplier })).toBe(t("reach.buddy.add.shop", { title: "Supplier Somchai" }));
    r.calls.length = 0;
    r.buddy.next = block("read", { chat: "1" });
    const posted = r.posts().length;
    await r.say("Read the price list");
    expect(r.lines().at(-1)).toBe(t("reach.buddy.shop", { title: "Price list for March" }));
    expect(r.calls.filter((c) => c === "held" || c === "read" || c === "ask")).toEqual([]);
    expect(reads()).toBe(before);
    expect(r.cards()).toEqual([]);
    expect(r.posts()).toHaveLength(posted + 1);
  });
});

describe("a new conversation (R10 on Connected)", () => {
  it("starts only on Start conversation, its first message the brief with the mark after it, named by the brief; Not now starts nothing", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("open", { brief: "Plan the Songkran sale: which items, what discount, from which day." });
    await r.say("Can we plan a sale?");
    const conversations = () => (r.shops.chat[SHOP_A.id] ?? []).length;
    const before = conversations();
    const posted = r.posts().length;
    await r.reach.answer("buddy", r.cards()[0].id, false);
    expect(r.cards()[0].done).toBe("no");
    expect([conversations(), r.posts().length]).toEqual([before, posted]);

    r.buddy.next = block("open", { brief: "Plan the Songkran sale: which items, what discount, from which day." });
    await r.say("Plan it then");
    const card = r.cards()[1];
    // named as the API will name it: the brief's first words
    expect(card.ask.kind === "open" && card.ask.title).toBe("Plan the Songkran sale: which items, what discount, from wh…");
    expect(conversations()).toBe(before);
    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: true });
    await settle();
    expect(conversations()).toBe(before + 1);
    const made = r.shops.chat[SHOP_A.id]!.at(-1)!;
    expect(made.title).toBe("Plan the Songkran sale: which items, what discount, from whi");
    expect(r.posts().at(-1)).toEqual({ text: `Plan the Songkran sale: which items, what discount, from which day.\n\n[Manut AI: the words above came from the conversation "Can we plan a sale?"]\n${AFTER_FENCE}` });
    expect(r.cards()[1]).toMatchObject({ done: "yes", thread: expect.any(String) });
    // it is listed with the others, and read back with the mark in front
    const back = { messages: await r.store.actions.readThread("buddy", made.id) };
    expect(back.messages[0].text).toBe(fromChatText("Can we plan a sale?", "Plan the Songkran sale: which items, what discount, from which day."));
  });
});

describe("what a press checks first", () => {
  it("refuses a conversation that is gone, and a press after the person stopped owning the shop, with nothing posted", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    const supplier = await r.conversation("Supplier Somchai");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: supplier });
    r.buddy.next = block("send", { chat: "1", message: "Check the prices." });
    await r.say("Ask prices");
    const gone = r.cards()[0];
    const posted = r.posts().length;
    r.store.dispatch({ type: "thread.gone", bot: "buddy", thread: prices });
    expect(await r.reach.answer("buddy", gone.id, true)).toEqual({ ok: false, refused: "gone" });
    expect(r.cards()[0].done).toBe("gone");

    r.buddy.next = block("send", { chat: "2", message: "Check the order." });
    await r.say("Ask the supplier");
    const card = r.cards()[1];
    const after = r.posts().length;
    const s = r.store.getState().shops;
    r.store.dispatch({ type: "shops", list: s.list.map((x) => (x.id === SHOP_A.id ? { ...x, role: "helper" as const } : x)), current: SHOP_A.id, left: s.left });
    expect(await r.reach.answer("buddy", card.id, true)).toEqual({ ok: false, refused: "notOwner" });
    expect(r.posts()).toHaveLength(after);
    expect(posted).toBe(after - 1);
    // and the lists of a shop the person no longer owns go
    r.reach.prune();
    expect(r.reach.listOf("buddy")).toEqual([]);
  });

  it("a block Buddy writes with a key outside its own, or a second block, is refused whole with a line and no card", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("open", { brief: "Plan the sale", model: "claude-opus-5-5" });
    await r.say("Plan a sale");
    expect(r.lines().at(-1)).toBe(t("reach.buddy.refused", { why: t("reach.why.key", { key: "model" }) }));
    r.buddy.next = `${block("read", { chat: "1" })}\n\n${block("read", { chat: "1" })}`;
    await r.say("Read twice");
    expect(r.lines().at(-1)).toBe(t("reach.buddy.refused", { why: t("reach.why.many") }));
    expect(r.cards()).toEqual([]);
  });

  it("with nothing listed, a block is Buddy's own words and no card shows", async () => {
    const r = await rig();
    await r.say("Hello");
    r.shops.chatAnswer = () => ({ text: block("read", { chat: "1" }), stopReason: "end_turn" });
    await r.say("Read one");
    expect(r.cards()).toEqual([]);
    expect(r.chat().items.filter((i) => i.kind === "assistant").at(-1)).toMatchObject({ text: block("read", { chat: "1" }) });
  });
});

describe("nothing on disk", () => {
  it("keeps no list, card, message or answer in the read kept for offline use", async () => {
    const r = await rig();
    const prices = await r.conversation("Price list for March");
    r.reach.add("buddy", { kind: "thread", bot: "buddy", thread: prices });
    r.buddy.next = block("send", { chat: "1", message: "Check the Somchai order." });
    await r.say("Ask about Somchai");
    await r.reach.answer("buddy", r.cards()[0].id, true);
    await settle();
    await vi.advanceTimersByTimeAsync(61_000);
    const kept = JSON.stringify(await keptPlain(r.disk));
    for (const word of ["Somchai", "Price list", "Buddy's answer", BUDDY_NOTE_HEAD, chatId(1)]) expect(kept, word).not.toContain(word);
    expect(OWNER_A).toBeTruthy();
  });
});
