// Chats that reach other chats (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats", rule R10), kept by the
// sessions store (`sessions/sessions.ts`), which hands this its sessions' records, their chats, their events, item 97's reader of
// another chat, and the three ways it acts (send to the asking chat, route into another chat, open a lane). It keeps the "Kit may
// reach" list of each chat, tells the agent what is on it with each message, reads the agent's answer when its turn ends, and turns a
// reach block into a card, or into a line that says why there is none.
//
// The rules held here, each with its test in `reachChats.test.ts`:
// - Nothing is read into an agent, sent or opened until the person presses the card that names it (`answer`, called only from the
//   cards' buttons). Each card is one approval of the asking chat, settled once in approval-core (`reachAsks.ts`).
// - An agent names only a chat the person listed. A chat that is not listed is refused before anything is looked up: the reader is
//   not called at all (`findEntry` reads the list alone).
// - Never across shops or accounts (item 97, item 121): a chat listed under one shop that is now of another, or whose content would
//   cross a shop or an account in either direction, is refused before anything of it is read, when the card would open and again at
//   the press.
// - A message arrives in another chat marked as from this one (`fromChatText`), masked as its card showed it, behind that chat's
//   running turn or waiting ask, and never steered in: the sessions store's `route` only ever sends text, so it has no way to answer, allow, deny or dismiss an ask.
// - Open makes an ordinary lane on its agent in its asking mode, with the brief as its first message, only on Start lane.
import { t as tr, type Key } from "../i18n";
import { maskSecrets } from "../lib/secrets";
import { scopeRefusal, tookIn, type Carried, type Scope } from "../chat/box/carry";
import { gatherContext, refKey, type ContextReader } from "../chat/box/threadContext";
import { agentDef, sessionMode, type AgentInfo, type SessionRec } from "../sessions/agents";
import type { ChatEvent } from "../sessions/host";
import type { ModelOption } from "../sessions/sessionTypes";
import type { AppState, ReachAskItem } from "../state/types";
import type { Action } from "../state/reducer";
import { helperRows } from "./helperAsks";
import { BRIEF_MAX } from "./helperBlocks";
import { reachOutcome, reachReply, type ReachKind, type ReachRefusal } from "./reachBlocks";
import { answerReachAsk, openReachAsk, withdrawReachAsk, type ReachAsk, type ReachTarget } from "./reachAsks";
import { addEntry, findEntry, reachOffered, removeEntry, withReachNote, fromChatText, type NoteEntry, type ReachEntry } from "./reachList";
import type { ThreadRef } from "../chat/box/threadContext";

/** What pressing a card's button did: settled, or why nothing was. approval-core's refusals (`already_decided`, `superseded`), or
 *  the app's own, checked before anything is settled: `notListed`, `gone`, `self`, `shop`, `account`, `notCoding` (the chat named is
 *  no longer one Kit may reach), `notRunning` (the chat to send to has no agent running now), `agent` (the lane's agent will not
 *  start), `not_found` for a card that is gone. */
export type ReachAnswer = { ok: true } | { ok: false; refused: string };

/** Why a chat on the list cannot be reached now. */
export type Unreachable = "gone" | "self" | "shop" | "account" | "notCoding";

/** The lane an open card's Start lane asks the sessions store to start. */
export interface OpenLane {
  agent: string;
  cwd: string;
  title: string;
  /** its first message: the brief, marked as from the asking chat */
  first: string;
  model?: string;
  effort?: string;
  /** the asking chat's session */
  from: string;
}

/** What the reach cards need from the sessions store. */
export interface ReachDeps {
  rec(id: string): SessionRec | undefined;
  chatKey(id: string): string | undefined;
  store(): { getState(): Pick<AppState, "chats">; dispatch(a: Action): void };
  agents(): readonly AgentInfo[] | null;
  models(id: string): readonly ModelOption[];
  efforts(id: string): readonly string[];
  /** item 97's reader of another chat, over the app's store, sessions and shell */
  reader(): ContextReader;
  /** keeps session `id`'s list (`SessionRec.reach`) */
  setList(id: string, list: readonly ReachEntry[]): void;
  /** sends `text` to session `id`'s agent as its next message, as the person's own Send does, never steered into a running turn */
  sendTo(id: string, text: string): Promise<boolean>;
  /** puts `text` into session `id`'s chat as a message from another chat: behind its running turn or a waiting ask, never steered */
  route(id: string, text: string): Promise<boolean>;
  /** session `id`'s agent runs now, so a message can reach it */
  running(id: string): boolean;
  /** starts the lane Start lane asked for: its session, or why none started */
  openLane(p: OpenLane): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  /** what a new lane on `agent` would run under (the account picked for new sessions) */
  laneScope(agent: string): Scope;
  now?(): number;
}

/** What a turn of a chat with a list wrote, as its agent sent it. */
interface Said {
  texts: string[];
  streaming: string;
  reach: boolean;
}

/** The words for a request that could not be read. */
export function refusalWords(r: ReachRefusal): string {
  switch (r.why) {
    case "key":
      return tr("reach.why.key", { key: r.key });
    case "value":
      return tr("reach.why.value", { key: r.key });
    case "long":
      return tr("reach.why.long", { max: BRIEF_MAX.toLocaleString("en-US") });
    default:
      return tr(`reach.why.${r.why}` as Key);
  }
}

/** Whether content may pass between a chat listed under `listed`, which belongs to `now` today, and the asking chat under `asker`:
 *  null when it may, else why not. A chat listed under one shop that is now of another is another shop's chat; and as item 97 and
 *  item 121 refuse a chip, content never crosses a shop or an account, here in either direction, since a read brings the chat's text
 *  in and a message takes the asking chat's words out. */
export function crossing(listed: Scope, now: Scope, asker: Scope): "shop" | "account" | null {
  if (listed.shop !== undefined && now.shop !== listed.shop) return "shop";
  if (listed.account && now.account && now.account !== listed.account) return "account";
  return scopeRefusal(now, asker) ?? scopeRefusal(asker, now);
}

/** A chip of `scope` with nothing in it: what item 121's `tookIn` reads to keep the shops a chat took in. */
const passed = (scope: Scope): Carried => ({ kind: "thread", id: "reach", ref: "", title: "", text: "", scope });

export function createReach(deps: ReachDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const said = new Map<string, Said>();
  let seq = 0;

  const offered = (id: string) => reachOffered(deps.rec(id), deps.agents());
  const listOf = (id: string): readonly ReachEntry[] => deps.rec(id)?.reach ?? [];
  const active = (id: string) => offered(id) && listOf(id).length > 0;
  const note = (key: string, text: string) => deps.store().dispatch({ type: "system.note", bot: key, text, now: now() });
  const cardsOf = (key: string): ReachAskItem[] => (deps.store().getState().chats[key]?.items ?? []).filter((i): i is ReachAskItem => i.kind === "reachAsk");
  const asSession = (id: string): ThreadRef => ({ kind: "session", id });

  /** Who answers in a listed chat, for the note: a coding chat's agent, else a team chat. */
  const whoOf = (e: ReachEntry): string => {
    if (e.ref.kind !== "session") return "a team chat";
    const r = deps.rec(e.ref.id);
    return r ? `${agentDef(r.agent).label}, a coding chat` : "a coding chat";
  };

  /** The open cards of session `id` taken back, each saying it is no longer open. `only`: just those naming that listed chat. */
  const withdrawOpen = (id: string, only?: string) => {
    const key = deps.chatKey(id);
    if (!key) return;
    for (const card of cardsOf(key)) {
      if (card.done) continue;
      if (only !== undefined && (card.ask.kind === "open" || refKey(card.ask.target.ref) !== only)) continue;
      void withdrawReachAsk(card.id);
      deps.store().dispatch({ type: "reach.done", bot: key, id: card.id, done: "gone" });
    }
  };

  /** Where listed chat `e` is now, for the asking chat `asker`: its key, title and scope, or why it cannot be reached. Only the
   *  reader's look-up of which chat it is and what it belongs to runs here; nothing of what is in it is read. */
  const locate = (asker: string, e: ReachEntry, kind: ReachKind): { ok: true; key: string; title: string; scope: Scope } | { ok: false; why: Unreachable } => {
    const reader = deps.reader();
    const target = e.ref.kind === "session" ? deps.rec(e.ref.id) : undefined;
    // a later chat that took the same session id is not the chat that was listed
    if (e.ref.kind === "session" && (!target || (e.link && target.linkId !== e.link))) return { ok: false, why: "gone" };
    const key = reader.chatKey(e.ref);
    const askerKey = deps.chatKey(asker);
    if (!key || !askerKey) return { ok: false, why: "gone" };
    if (key === askerKey) return { ok: false, why: "self" };
    const scope = reader.scope(key);
    const why = crossing(e.scope, scope, reader.scope(askerKey));
    if (why) return { ok: false, why };
    // a message goes only to a coding chat on this Mac, whose agent takes text and nothing else from it (`route`)
    if (kind === "send" && !(target && target.status !== "draft" && sessionMode(deps.agents() as AgentInfo[] | null, target) === "chat")) return { ok: false, why: "notCoding" };
    return { ok: true, key, title: reader.title(e.ref), scope };
  };

  /** The line for a listed chat that cannot be reached, named as the list names it. */
  const unreachableWords = (why: Unreachable, title: string, kind: ReachKind) =>
    why === "notCoding" ? tr("reach.notCoding", { title }) : why === "gone" ? tr(`reach.gone.${kind === "send" ? "send" : "read"}`, { title }) : tr(`reach.${why}`, { title });

  /** The turn ended: a reach block becomes its card, or a line that says why there is none. */
  const turnEnded = async (id: string, outcome: unknown) => {
    const s = said.get(id);
    said.delete(id);
    const r = deps.rec(id);
    const key = deps.chatKey(id);
    if (!s?.reach || !r || !key) return;
    const texts = [...s.texts, ...(s.streaming.trim() ? [s.streaming] : [])];
    const at = reachReply(texts);
    if (at === null) return;
    const asked = reachOutcome(texts[at]);
    // a stopped or failed turn asks for nothing: the person did not see it finish
    if (outcome !== "done") return note(key, tr("reach.unfinished"));
    if (!active(id)) return note(key, tr("reach.listEmptied"));
    if (asked.kind === "refused") return note(key, tr("reach.refused", { why: refusalWords(asked.refusal) }));
    if (asked.kind !== "request") return;
    const turn = deps.store().getState().chats[key]?.lastTurn?.id;
    if (!turn) return;
    const req = asked.request;
    const base = { id: `reach-${id}-${turn}-${++seq}`, asker: id, turn };
    let ask: ReachAsk;
    if (req.kind === "open") {
      const { rows } = helperRows([req.lane], { agent: r.agent, models: deps.models(id), efforts: deps.efforts(id) }, deps.agents());
      ask = { ...base, kind: "open", lane: rows[0], cwd: r.cwd };
    } else {
      // the list alone says which chat the name means: one not listed is refused before the reader is asked anything
      const entry = findEntry(listOf(id), req.chat);
      if (!entry) return note(key, tr(req.kind === "read" ? "reach.notListed.read" : "reach.notListed.send", { name: req.chat }));
      const where = locate(id, entry, req.kind);
      if (!where.ok) return note(key, unreachableWords(where.why, entry.title, req.kind));
      const target: ReachTarget = { n: entry.n, ref: entry.ref, key: where.key, title: where.title, scope: where.scope };
      if (req.kind === "send") ask = { ...base, kind: "send", target, message: req.message };
      else {
        // item 97's text, built with no model, masked and capped: shown whole on the card, and exactly what Let Kit read sends
        let text: string;
        try {
          text = (await gatherContext(entry.ref, deps.reader())).text;
        } catch (e) {
          return note(key, tr("reach.readFailed", { title: where.title, error: e instanceof Error ? e.message : String(e) }));
        }
        ask = { ...base, kind: "read", target, text };
      }
    }
    await openReachAsk(ask);
    deps.store().dispatch({ type: "reach.ask", bot: key, item: { kind: "reachAsk", id: ask.id, ts: now() / 1000, ask } });
  };

  /** Checked again at the press, before anything is settled: the chat named is still listed and still one Kit may reach, a chat to
   *  send to runs, a lane's agent will start and runs under no other account of it. `gone`: the card can never be taken now. */
  const recheck = (ask: ReachAsk): { ok: true; key?: string; scope?: Scope } | { ok: false; refused: string; gone: boolean } => {
    if (ask.kind === "open") {
      if (ask.lane.problem) return { ok: false, refused: "agent", gone: false };
      const askerKey = deps.chatKey(ask.asker);
      const why = askerKey ? scopeRefusal(deps.reader().scope(askerKey), deps.laneScope(ask.lane.agent)) : null;
      return why ? { ok: false, refused: why, gone: false } : { ok: true };
    }
    const entry = listOf(ask.asker).find((e) => refKey(e.ref) === refKey(ask.target.ref));
    if (!entry) return { ok: false, refused: "notListed", gone: true };
    const where = locate(ask.asker, entry, ask.kind);
    if (!where.ok) return { ok: false, refused: where.why, gone: true };
    if (ask.kind === "send" && ask.target.ref.kind === "session" && !deps.running(ask.target.ref.id)) return { ok: false, refused: "notRunning", gone: false };
    return { ok: true, key: where.key, scope: where.scope };
  };

  /** What a yes does, once its card is settled: the only place anything of another chat moves. */
  const act = async (ask: ReachAsk, at: { key?: string; scope?: Scope }): Promise<{ lane?: string; error?: string }> => {
    const askerKey = deps.chatKey(ask.asker) ?? "";
    const reader = deps.reader();
    const askerTitle = reader.title(asSession(ask.asker));
    if (ask.kind === "read") {
      if (!(await deps.sendTo(ask.asker, ask.text))) return { error: tr("reach.notSent") };
      // the asking chat now holds that chat's content: its chips carry that chat's shops on (item 121)
      tookIn(askerKey, [passed(at.scope ?? ask.target.scope)]);
      return {};
    }
    if (ask.kind === "send") {
      if (ask.target.ref.kind !== "session" || !(await deps.route(ask.target.ref.id, fromChatText(askerTitle, maskSecrets(ask.message))))) return { error: tr("reach.notSent") };
      if (at.key) tookIn(at.key, [passed(reader.scope(askerKey))]);
      return {};
    }
    const lane = ask.lane;
    const started = await deps.openLane({
      agent: lane.agent,
      cwd: ask.cwd,
      title: lane.title,
      // masked as the card showed it: what goes is what the person read
      first: fromChatText(askerTitle, maskSecrets(lane.brief)),
      // a model or an effort the card said starts on the agent's own is not asked for
      ...(lane.model && !lane.modelUnlisted ? { model: lane.model } : {}),
      ...(lane.effort && !lane.effortUnlisted ? { effort: lane.effort } : {}),
      from: ask.asker,
    });
    if (!started.ok) return { error: started.why };
    const laneKey = deps.chatKey(started.id);
    if (laneKey) tookIn(laneKey, [passed(reader.scope(askerKey))]);
    return { lane: started.id };
  };

  return {
    /** Session `id` shows the list. */
    offered,
    /** Session `id` has a chat on its list where it may: its agent is told, and its blocks are read. */
    active,
    /** Adds chat `ref` to session `id`'s list, at the person's own press. Null when it was added, else the line the list shows: the
     *  chat itself, a chat that is gone, one of another shop or account (said before anything of it is read), the same chat twice,
     *  or a full list. */
    add(id: string, ref: ThreadRef): string | null {
      const askerKey = deps.chatKey(id);
      if (!offered(id) || !askerKey) return tr("reach.add.no");
      const reader = deps.reader();
      const key = reader.chatKey(ref);
      const title = reader.title(ref);
      if (!key) return tr("reach.add.gone", { title });
      if (key === askerKey) return tr("reach.add.self");
      const scope = reader.scope(key);
      const why = crossing(scope, scope, reader.scope(askerKey));
      if (why) return tr(why === "shop" ? "reach.add.shop" : "reach.add.account", { title });
      const link = ref.kind === "session" ? deps.rec(ref.id)?.linkId : undefined;
      const r = addEntry(listOf(id), { ref, ...(link ? { link } : {}), title, scope });
      if (r.refused === "same") return tr("reach.add.same", { title });
      if (r.refused === "full") return tr("reach.add.full", { max: r.list.length });
      deps.setList(id, r.list);
      return null;
    },
    /** Takes listed chat `n` off session `id`'s list. A card still open that names it is taken back. */
    remove(id: string, n: number): void {
      const e = listOf(id).find((x) => x.n === n);
      if (!e) return;
      const next = removeEntry(listOf(id), n);
      deps.setList(id, next);
      if (!next.length) withdrawOpen(id);
      else withdrawOpen(id, refKey(e.ref));
    },
    /** The text that goes to session `id`'s agent for a message the person sent: with the note naming its list in front while the
     *  list holds a chat, as it is otherwise. */
    wire(id: string, text: string): string {
      if (!active(id)) return text;
      const entries: NoteEntry[] = listOf(id).map((e) => ({ n: e.n, title: e.title, who: whoOf(e) }));
      return withReachNote(text, entries);
    },
    /** An event of session `id`'s agent, before the chat takes it: a turn that starts with a chat on the list is marked so (the chat
     *  then hides its reach blocks), and what the turn writes is kept as the agent sent it, for its end to read. */
    before(id: string, ev: ChatEvent): ChatEvent {
      if (ev.event === "turn.start") {
        // a new turn, the person's or the agent's own: an older card no longer answers what is going on
        withdrawOpen(id);
        const reach = active(id);
        said.set(id, { texts: [], streaming: "", reach });
        return reach ? { ...ev, reach: true } : ev;
      }
      const s = said.get(id);
      if (!s?.reach) return ev;
      if (ev.event === "delta" && typeof ev.text === "string") s.streaming += ev.text;
      else if (ev.event === "message" && typeof ev.text === "string") {
        s.texts.push(ev.text);
        s.streaming = "";
      } else if (ev.event === "tool.start" && s.streaming) {
        s.texts.push(s.streaming);
        s.streaming = "";
      }
      return ev;
    },
    /** An event of session `id`'s agent, after the chat took it: a turn's end reads what it asked for. */
    after(id: string, ev: ChatEvent): Promise<void> {
      return ev.event === "turn.end" ? turnEnded(id, ev.outcome) : Promise.resolve();
    },
    /** The person pressed a card's yes (`yes`) or no on card `askId` of session `id`. Checked again first (still listed, same shop
     *  and account, the chat to send to runs); then the card's approval settles once in approval-core, against the asking chat's
     *  turn now (read from its chat, never from the card); only then does anything move. */
    async answer(id: string, askId: string, yes: boolean): Promise<ReachAnswer> {
      const key = deps.chatKey(id);
      const chat = key ? deps.store().getState().chats[key] : undefined;
      const card = key ? cardsOf(key).find((c) => c.id === askId) : undefined;
      if (!key || !chat || !card) return { ok: false, refused: "not_found" };
      let at: { key?: string; scope?: Scope } = {};
      if (yes && !card.done) {
        const pre = recheck(card.ask);
        if (!pre.ok) {
          if (pre.gone) {
            void withdrawReachAsk(askId);
            deps.store().dispatch({ type: "reach.done", bot: key, id: askId, done: "gone" });
          }
          return { ok: false, refused: pre.refused };
        }
        at = pre;
      }
      const decided = await answerReachAsk(askId, card.ask.kind, yes, { turnId: chat.turn?.id ?? chat.lastTurn?.id ?? null });
      if (!decided.ok) {
        if (decided.refused === "superseded") deps.store().dispatch({ type: "reach.done", bot: key, id: askId, done: "gone" });
        return { ok: false, refused: decided.refused };
      }
      if (!yes) {
        deps.store().dispatch({ type: "reach.done", bot: key, id: askId, done: "no" });
        return { ok: true };
      }
      const did = await act(card.ask, at);
      deps.store().dispatch({ type: "reach.done", bot: key, id: askId, done: "yes", ...did });
      return { ok: true };
    },
    /** Session `id` closed: what was kept for it goes. */
    forget(id: string): void {
      said.delete(id);
    },
  };
}

export type Reach = ReturnType<typeof createReach>;
