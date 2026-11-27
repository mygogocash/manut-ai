// The reach cards over Buddy's chats on the Connected runtime (item 102l-3; `docs/connected-chat.md`, C; rule R10 of
// `docs/several-agents.md`, kept as it is). On Connected a "chat" is one of the shop's conversations with Buddy (102l-2), and the asking
// chat is the one the person is in: Buddy's main chat, or a conversation opened from History. This keeps the "Buddy may reach" list of
// each, tells Buddy what is on it with each message (`outgoing`, which puts the note beside the message for the runtime to post after
// it; `buddyReachBridge.ts` puts these hooks in the store's way), reads Buddy's answer when its turn ends, and turns a reach block into
// a card, or into a line that says why there is none.
//
// It reuses item 102k's parts with what differs on Connected handed in: the block grammar (`reachBlocks.ts`, `BUDDY_GRAMMAR`), the
// list (`reachList.ts`: `addEntry`, `findEntry`, `removeEntry`, `REACH_MAX`), the asks (`reachAsks.ts`, the one approval-core store),
// the cards (`ReachCards.tsx`) and item 97's reader of another chat. What it does not reuse is `reachChats.ts`, the sessions store's
// half, which acts through coding agents, lanes and their folders: here every action is one message to the API's chat.
//
// The rules held here, each with its test in `buddyReach.test.ts`:
// - Nothing is read into Buddy, sent or started until the person presses the card that names it (`answer`, called only from the cards'
//   buttons). Each card is one approval of the asking chat, settled once in approval-core. Every press is a model call billed to the
//   shop's monthly limit, and the card says so before it.
// - Buddy names only a conversation the person listed. One that is not listed is refused before anything is looked up: the reader is
//   not asked anything (`findEntry` reads the list alone).
// - Never across shops: a list is the shop's it was made in, a card is the shop's it opened in, and a press while another shop is shown
//   is refused with nothing sent. So is a press on a conversation that is gone, or after the person stopped owning the shop.
// - A message sent on is posted as words and nothing else (`postFromCard`, then the runtime's `chat.send`), so it has no way to answer,
//   allow, deny or dismiss any ask or approval: approvals settle only through the decide route.
// - Each press posts once. A refusal, or a request that got no answer, marks the card with the reason; nothing is sent again from here.
// - Nothing typed or answered is written to disk: the lists, the cards and what a turn said are held in memory for this run.
// - Only the shop's owner chats on Connected (102l-2), so only an owner is offered the list, and only an owner's press is taken.
import { t, type Key } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import type { BridgeEvent, OpParams, Op } from "../lib/protocol";
import { TEAM } from "../runtime/http/view";
import { tookIn, type Carried, type Scope } from "../chat/box/carry";
import { gatherContext, refKey, type ContextReader, type ThreadRef } from "../chat/box/threadContext";
import type { BringRow } from "../chat/box/Bring";
import { threadKey } from "../threads/types";
import type { Actions } from "../state/createStore";
import type { Action } from "../state/reducer";
import type { AppState, ReachAskItem } from "../state/types";
import { changes } from "../lib/changes";
import { BUDDY_GRAMMAR, BUDDY_MESSAGE_MAX, reachOutcome, reachReply, type ReachKind, type ReachRefusal } from "./reachBlocks";
import { answerReachAsk, isBuddyAsk, openReachAsk, withdrawReachAsk, type BuddyAsk, type ReachTarget } from "./reachAsks";
import { addEntry, findEntry, removeEntry, type ReachEntry } from "./reachList";
import { buddyNote, fromChatAfter, fromChatText } from "./reachMarks";
import { crossing, refusalWords, type ReachAnswer } from "./reachChats";

/** Why a listed conversation cannot be reached now. */
type Unreachable = "gone" | "self" | "shop" | "account";

/** What the reach cards need of the app: its store (read, its dispatch, and the three actions they post through), item 97's reader
 *  over it, and whether the app runs on the Connected runtime. */
export interface BuddyReachDeps {
  store(): { getState(): AppState; dispatch(a: Action): void; actions: Pick<Actions, "postFromCard" | "newThread"> };
  reader(): ContextReader;
  connected(): boolean;
  now?(): number;
}

/** One of Buddy's cards in the timeline. */
type BuddyCard = ReachAskItem & { ask: BuddyAsk };

const EMPTY: readonly ReachEntry[] = [];

/** A chip of `scope` with nothing in it: what item 121's `tookIn` reads to keep the shops a chat took in. */
const passed = (scope: Scope): Carried => ({ kind: "thread", id: "reach", ref: "", title: "", text: "", scope });

/** The words for a request of Buddy's that could not be read: item 102k's, but a new conversation's in its own words. */
function buddyRefusal(r: ReachRefusal): string {
  return r.why === "brief" ? t("reach.buddy.why.brief") : refusalWords(r, BUDDY_MESSAGE_MAX);
}

/** The key of the chat an event or a message belongs to: Buddy's main chat, or a conversation's `fold:` key. */
const keyOf = (bot: string, session: unknown): string => (typeof session === "string" && session ? threadKey(bot, session) : bot);

export function createBuddyReach(deps: BuddyReachDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const told = changes();
  /** Each list by its shop and chat, in memory only. */
  const lists = new Map<string, ReachEntry[]>();
  /** What a turn of a chat with a list wrote, for its end to read. */
  const said = new Map<string, { reach: boolean; texts: string[] }>();
  /** The conversation Buddy's main chat posts to now (its first message made it), so the main chat never lists or reaches itself. */
  let mainConv: string | null = null;
  let seq = 0;

  const state = () => deps.store().getState();
  const dispatch = (a: Action) => deps.store().dispatch(a);
  const viewing = (): string | null => state().shops.current;
  const owns = (): boolean => {
    const shop = viewing();
    return shop !== null && state().shops.list.some((s) => s.id === shop && s.role === "owner");
  };
  const listKey = (shop: string, key: string) => `${shop}\n${key}`;
  const rowOf = (thread: string) => (state().threads[TEAM] ?? []).find((r) => r.thread === thread && r.kind === "chat");
  /** Conversation `thread` has something in it: the API counted its messages, or this run shows one that went (a conversation made
   *  here keeps the count it was prepared with until the list is read again). One with nothing in it has nothing to read. */
  const hasWords = (thread: string): boolean =>
    (rowOf(thread)?.message_count ?? 0) > 0 ||
    (state().chats[threadKey(TEAM, thread)]?.items ?? []).some((i) => i.kind === "assistant" || (i.kind === "user" && !i.error && !i.held));
  const conversationOf = (key: string): string | null => (key.startsWith(`fold:${TEAM}:`) ? key.slice(`fold:${TEAM}:`.length) : null);

  /** Chat `key` is one of Buddy's chats on Connected, in a shop the person owns: Buddy's main chat or a listed conversation. */
  const offered = (key: string): boolean => {
    if (!deps.connected() || !owns()) return false;
    if (key === TEAM) return true;
    const conv = conversationOf(key);
    return conv !== null && !!rowOf(conv);
  };
  const listOf = (key: string): readonly ReachEntry[] => {
    const shop = viewing();
    // the same empty list each time, so a screen reading it as an external store sees no change
    return shop === null ? EMPTY : (lists.get(listKey(shop, key)) ?? EMPTY);
  };
  const setList = (key: string, list: readonly ReachEntry[]) => {
    const shop = viewing();
    if (shop === null) return;
    if (list.length) lists.set(listKey(shop, key), [...list]);
    else lists.delete(listKey(shop, key));
    told.emit();
  };
  const active = (key: string) => offered(key) && listOf(key).length > 0;
  const line = (key: string, text: string) => dispatch({ type: "system.note", bot: key, text, now: now() });
  const cardsOf = (key: string): BuddyCard[] => (state().chats[key]?.items ?? []).filter((i): i is BuddyCard => i.kind === "reachAsk" && isBuddyAsk(i.ask));
  /** The asking chat's name, as a message it sends on says where it came from. */
  const titleOf = (key: string): string => {
    const conv = key === TEAM ? mainConv : conversationOf(key);
    return (conv !== null && rowOf(conv)?.title) || t("reach.buddy.mainChat");
  };

  /** The open cards of chat `key` taken back, each saying it is no longer open. `only`: just those naming that listed conversation. */
  const withdrawOpen = (key: string, only?: string) => {
    for (const card of cardsOf(key)) {
      if (card.done) continue;
      if (only !== undefined && (card.ask.kind === "open" || refKey(card.ask.target.ref) !== only)) continue;
      void withdrawReachAsk(card.id);
      dispatch({ type: "reach.done", bot: key, id: card.id, done: "gone" });
    }
  };

  /** Where listed conversation `e` is now, for the asking chat `asker`: its key, title and scope, or why it cannot be reached. Only which
   *  conversation it is and what it belongs to are looked up here; nothing of what is in it is read. */
  const locate = (asker: string, e: ReachEntry): { ok: true; key: string; title: string; scope: Scope } | { ok: false; why: Unreachable } => {
    if (e.ref.kind !== "thread" || e.ref.bot !== TEAM) return { ok: false, why: "gone" };
    const row = rowOf(e.ref.thread);
    if (!row) return { ok: false, why: "gone" };
    const key = threadKey(TEAM, e.ref.thread);
    if (key === asker || (asker === TEAM && e.ref.thread === mainConv)) return { ok: false, why: "self" };
    const reader = deps.reader();
    const scope = reader.scope(key);
    const why = crossing(e.scope, scope, reader.scope(asker));
    if (why) return { ok: false, why };
    return { ok: true, key, title: row.title || t("thread.untitled"), scope };
  };

  const unreachableWords = (why: Unreachable, title: string, kind: ReachKind) =>
    why === "gone" ? t(kind === "send" ? "reach.buddy.gone.send" : "reach.buddy.gone.read", { title }) : t(why === "self" ? "reach.buddy.self" : "reach.buddy.shop", { title });

  /** Buddy's answer came: a reach block becomes its card, or a line that says why there is none. */
  const turnEnded = async (key: string, outcome: unknown) => {
    const s = said.get(key);
    said.delete(key);
    if (!s?.reach) return;
    const at = reachReply(s.texts);
    if (at === null) return;
    const asked = reachOutcome(s.texts[at], BUDDY_GRAMMAR);
    if (outcome !== "done") return line(key, t("reach.buddy.unfinished"));
    if (!active(key)) return line(key, t("reach.buddy.listEmptied"));
    if (asked.kind === "refused") return line(key, t("reach.buddy.refused", { why: buddyRefusal(asked.refusal) }));
    if (asked.kind !== "request") return;
    const turn = state().chats[key]?.lastTurn?.id;
    const shop = viewing();
    if (!turn || shop === null) return;
    const req = asked.request;
    const base = { id: `buddy-reach-${++seq}-${turn}`, buddy: true as const, asker: key, shop, turn };
    let ask: BuddyAsk;
    if (req.kind === "open") {
      // masked as the card shows it, and posted as it was shown
      ask = { ...base, kind: "open", brief: maskSecrets(req.lane.brief), title: maskSecrets(req.lane.title) };
    } else {
      // the list alone says which conversation the name means: one not listed is refused before the reader is asked anything
      const entry = findEntry(listOf(key), req.chat);
      if (!entry) return line(key, t(req.kind === "read" ? "reach.buddy.notListed.read" : "reach.buddy.notListed.send", { name: req.chat }));
      const where = locate(key, entry);
      if (!where.ok) return line(key, unreachableWords(where.why, entry.title, req.kind));
      const target: ReachTarget = { n: entry.n, ref: entry.ref, key: where.key, title: where.title, scope: where.scope };
      if (req.kind === "send") ask = { ...base, kind: "send", target, message: maskSecrets(req.message) };
      else {
        // item 97's text, built with no model, masked and capped: shown whole on the card, and exactly what Let Buddy read posts
        let text: string;
        try {
          text = (await gatherContext(entry.ref, deps.reader())).text;
        } catch (e) {
          return line(key, t("reach.buddy.readFailed", { title: where.title, error: e instanceof Error ? e.message : String(e) }));
        }
        ask = { ...base, kind: "read", target, text };
      }
    }
    await openReachAsk(ask);
    dispatch({ type: "reach.ask", bot: key, item: { kind: "reachAsk", id: ask.id, ts: now() / 1000, ask } });
  };

  /** Checked again at the press, before anything is settled: the same shop is shown and the person still owns it, and a conversation a
   *  card names is still listed and still one Buddy may reach. `gone`: the card can never be taken now. */
  const recheck = (ask: BuddyAsk): { ok: true; scope?: Scope } | { ok: false; refused: string; gone: boolean } => {
    if (!deps.connected() || viewing() !== ask.shop) return { ok: false, refused: "shop", gone: true };
    if (!owns()) return { ok: false, refused: "notOwner", gone: true };
    if (ask.kind === "open") return { ok: true };
    const entry = listOf(ask.asker).find((e) => refKey(e.ref) === refKey(ask.target.ref));
    if (!entry) return { ok: false, refused: "notListed", gone: true };
    const where = locate(ask.asker, entry);
    if (!where.ok) return { ok: false, refused: where.why, gone: true };
    return { ok: true, scope: where.scope };
  };

  /** What a yes does, once its card is settled: the only place anything moves between Buddy's conversations. Each is one post. */
  const act = async (ask: BuddyAsk, scope: Scope | undefined): Promise<{ thread?: string; error?: string }> => {
    const actions = deps.store().actions;
    const from = titleOf(ask.asker);
    if (ask.kind === "read") {
      const error = await actions.postFromCard(ask.asker, ask.text, ask.text);
      if (error !== null) return { error };
      // the asking chat now holds that conversation's content: its chips carry that shop on (item 121)
      tookIn(ask.asker, [passed(scope ?? ask.target.scope)]);
      return {};
    }
    if (ask.kind === "send") {
      // after the words on the wire, so the API's kept text reads as it was written; in front in the bubble, as on this Mac
      const error = await actions.postFromCard(ask.target.key, fromChatText(from, ask.message), fromChatAfter(from, ask.message));
      return error === null ? {} : { error };
    }
    // a conversation is made by its first message (102l-2): prepared here, with nothing sent, then posted once
    const thread = await actions.newThread(TEAM, true);
    if (!thread) return { error: t("reach.buddy.notStarted") };
    const error = await actions.postFromCard(threadKey(TEAM, thread), fromChatText(from, ask.brief), fromChatAfter(from, ask.brief));
    return error === null ? { thread } : { thread, error };
  };

  return {
    /** Tells a list's readers it changed. */
    subscribe: told.subscribe,
    /** Chat `key` shows the list. */
    offered,
    /** Chat `key` has a conversation on its list: Buddy is told, and its blocks are read. */
    active,
    /** Chat `key`'s list, for the shop shown now. */
    listOf,
    /** The conversations the person may add to chat `key`'s list, for `query`: the shop's conversations with at least one message,
     *  newest first, less the chat itself and those already listed. A conversation with nothing in it has nothing to read. */
    rows(key: string, query: string): BringRow[] {
      if (!offered(key)) return [];
      const listed = new Set(listOf(key).map((e) => refKey(e.ref)));
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return [...(state().threads[TEAM] ?? [])]
        .filter((r) => r.kind === "chat" && hasWords(r.thread) && threadKey(TEAM, r.thread) !== key && !(key === TEAM && r.thread === mainConv))
        .sort((a, b) => (b.last ?? b.started_at) - (a.last ?? a.started_at))
        .map((r): BringRow => ({ ref: { kind: "thread", bot: TEAM, thread: r.thread }, title: r.title || t("thread.untitled"), who: t("reach.buddy.who") }))
        .filter((r) => !listed.has(refKey(r.ref)) && words.every((w) => r.title.toLowerCase().includes(w)));
    },
    /** Adds conversation `ref` to chat `key`'s list, at the person's own press. Null when it was added, else the line the list shows:
     *  this chat, a conversation that is gone or has nothing in it yet, one of another shop (said before anything of it is read), the
     *  same one twice, or a full list. */
    add(key: string, ref: ThreadRef): string | null {
      if (!offered(key)) return t("reach.buddy.add.no");
      const row = ref.kind === "thread" && ref.bot === TEAM ? rowOf(ref.thread) : undefined;
      if (!row || ref.kind !== "thread") return t("reach.add.gone", { title: row?.title || t("thread.untitled") });
      const title = row.title || t("thread.untitled");
      const target = threadKey(TEAM, ref.thread);
      if (target === key || (key === TEAM && ref.thread === mainConv)) return t("reach.add.self");
      if (!hasWords(ref.thread)) return t("reach.buddy.add.empty", { title });
      const reader = deps.reader();
      const scope = reader.scope(target);
      if (crossing(scope, scope, reader.scope(key))) return t("reach.buddy.add.shop", { title });
      const r = addEntry(listOf(key), { ref, title, scope });
      if (r.refused === "same") return t("reach.add.same", { title });
      if (r.refused === "full") return t("reach.add.full", { max: r.list.length });
      setList(key, r.list);
      return null;
    },
    /** Takes listed conversation `n` off chat `key`'s list. A card still open that names it is taken back. */
    remove(key: string, n: number): void {
      const e = listOf(key).find((x) => x.n === n);
      if (!e) return;
      const next = removeEntry(listOf(key), n);
      setList(key, next);
      if (!next.length) withdrawOpen(key);
      else withdrawOpen(key, refKey(e.ref));
    },
    /** A request on its way to the runtime: a message to a chat with a list carries Buddy's note beside it, for the runtime to post
     *  after the words; Buddy's main chat opened again posts to a new conversation from its next message. */
    outgoing<K extends Op>(op: K, params: OpParams<K> | undefined): OpParams<K> | undefined {
      if (op === "chat.open" && (params as OpParams<"chat.open"> | undefined)?.bot === TEAM) mainConv = null;
      if (op !== "chat.send" || !params) return params;
      const p = params as OpParams<"chat.send">;
      if (p.bot !== TEAM) return params;
      const key = keyOf(p.bot, p.session);
      if (!active(key)) return params;
      const entries = listOf(key).map((e) => ({ n: e.n, title: e.title }));
      return { ...p, note: buddyNote(entries, BUDDY_GRAMMAR) } as OpParams<K>;
    },
    /** An event of Buddy's, before the store takes it: a turn of a chat with a list is marked so (the store then keeps its reach blocks
     *  out of the bubble), and what it says is kept for its end to read. */
    incoming(ev: BridgeEvent): BridgeEvent {
      if (ev.bot !== TEAM) return ev;
      if (ev.event === ("thread.added" as string) && !ev.session) mainConv = (ev as unknown as { thread: string }).thread;
      const key = keyOf(ev.bot, ev.session);
      if (ev.event === "turn.start") {
        // a new turn: an older card no longer answers what is going on
        withdrawOpen(key);
        const reach = active(key);
        said.set(key, { reach, texts: [] });
        return reach ? { ...ev, reach: true } : ev;
      }
      const s = said.get(key);
      if (s?.reach && ev.event === "message" && typeof ev.text === "string") s.texts.push(ev.text);
      return ev;
    },
    /** An event of Buddy's, after the store took it: a turn's end reads what it asked for. */
    settled(ev: BridgeEvent): Promise<void> {
      return ev.bot === TEAM && ev.event === "turn.end" ? turnEnded(keyOf(ev.bot, ev.session), ev.outcome) : Promise.resolve();
    },
    /** The person pressed a card's yes (`yes`) or no on card `askId` of chat `key`. Checked again first (the same shop, still its owner,
     *  still listed, still there); then the card's approval settles once in approval-core, against the asking chat's turn now (read from
     *  its chat, never from the card); only then is anything posted, once. */
    async answer(key: string, askId: string, yes: boolean): Promise<ReachAnswer> {
      const chat = state().chats[key];
      const card = cardsOf(key).find((c) => c.id === askId);
      if (!chat || !card) return { ok: false, refused: "not_found" };
      let scope: Scope | undefined;
      if (yes && !card.done) {
        const pre = recheck(card.ask);
        if (!pre.ok) {
          if (pre.gone) {
            void withdrawReachAsk(askId);
            dispatch({ type: "reach.done", bot: key, id: askId, done: "gone" });
          }
          return { ok: false, refused: pre.refused };
        }
        scope = pre.scope;
      }
      const decided = await answerReachAsk(askId, card.ask.kind, yes, { turnId: chat.turn?.id ?? chat.lastTurn?.id ?? null }, true);
      if (!decided.ok) {
        if (decided.refused === "superseded") dispatch({ type: "reach.done", bot: key, id: askId, done: "gone" });
        return { ok: false, refused: decided.refused };
      }
      if (!yes) {
        dispatch({ type: "reach.done", bot: key, id: askId, done: "no" });
        return { ok: true };
      }
      // settled before anything moves: a read starts the asking chat's next turn, whose start takes back every card still open
      dispatch({ type: "reach.done", bot: key, id: askId, done: "yes" });
      const did = await act(card.ask, scope);
      if (did.thread || did.error) dispatch({ type: "reach.done", bot: key, id: askId, done: "yes", ...did });
      return { ok: true };
    },
    /** Drops the lists of every shop the person no longer owns: signing out empties the shops' list, so every list goes with it, as
     *  Buddy's chat forgets its conversations then (102l-2); a shop the person now only helps at keeps none. */
    prune(): void {
      const owned = new Set(state().shops.list.filter((s) => s.role === "owner").map((s) => s.id));
      let dropped = false;
      // a Map's own iteration goes on safely past an entry deleted under it
      for (const k of lists.keys()) {
        if (owned.has(k.slice(0, k.indexOf("\n")))) continue;
        lists.delete(k);
        dropped = true;
      }
      if (!owned.size) mainConv = null;
      if (dropped) told.emit();
    },
  };
}

export type BuddyReach = ReturnType<typeof createBuddyReach>;

/** The words of a refused press on one of Buddy's cards. */
export function buddyRefusedWords(code: string): string | null {
  const own: Record<string, Key> = { shop: "reach.buddy.refusal.shop", notOwner: "reach.buddy.refusal.notOwner", superseded: "reach.buddy.refusal.superseded" };
  return own[code] ? t(own[code]) : null;
}
