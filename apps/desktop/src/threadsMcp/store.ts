// What the page does with item 103's calls (`docs/mcp-threads.md`): the list of chats other programs may reach, the card that
// lets a program in for one run of it, and the cards for a read and a message. The shell decides who may ask
// (`src-tauri/src/threads_mcp/door.rs`); this decides what a chat is and what an answer says, and only the person's press lets a
// program in, reads a chat out to it or puts its words into a chat.
//
// - `let_in`: a card over whatever is showing (`Cards.tsx`), counted on the Dock's badge and announced by a notification while
//   the window is not in front. Let in while it runs, or No.
// - `list_chats`: answered at once from the list (`listLines`): number, title, who answers there and where it stands. The
//   shell sends it only for a program the person let in.
// - `read_chat` (103c): a card showing item 97's text of that chat, built with no model, masked and capped when the card opens;
//   Let it read answers the program with exactly that text.
// - `send_to_chat` (103c): a card showing the words whole, masked as they will go; Send there puts them in that chat through the
//   sessions store's `route`, under a line naming the program, held while that chat works or any ask of it waits, so its words
//   never answer anything (M9). Only a coding chat on this Mac whose agent runs as the app's chat takes one.
// - `open_chat` (103d): a card showing the new lane's title, agent, project folder and brief whole; Start lane makes an ordinary
//   lane through the sessions store's `openLane`, in its agent's Ask mode, the brief its first message under the program's mark,
//   and lists it for the program when the list has room, so the program may then read it or send it a message, each after a card.
//
// Every card is pressed once: it goes from the stack before anything happens, its read or message is settled once in approval-core
// (`asks.ts`), and the chat it names is checked again at the press. A card whose call is gone reads "No longer open" and answers
// nothing. A chat that is not on the list, left, moved shop or account, or cannot take a message opens no card at all.
//
// `createMcp` takes everything it reads as `McpDeps`, so a test drives it with stand-ins; `getMcp` is the app's own.
import { useSyncExternalStore } from "react";
import type { Scope } from "../chat/box/carry";
import { gatherContext, type ContextReader, type ThreadRef } from "../chat/box/threadContext";
import { addEntry, removeEntry, type ReachEntry } from "../jobs/reachList";
import type { OpenLane } from "../jobs/reachChats";
import { maskSecrets } from "../lib/secrets";
import { t } from "../i18n";
import { answerMcpAsk, openMcpAsk, withdrawMcpAsk, type McpAskKind } from "./asks";
import { fromProgramText, listLines, loadList, movedScope, OUTSIDE_MAX, saveList, type ChatState } from "./list";
import { getMcpShell, type McpCall, type McpProgram, type McpShell } from "./shell";

/** What a call that is none of the four tools is answered (the door lets none through; kept for safety). */
export const NOT_YET = "Manut AI does not know that call. Nothing was done.";

interface CardBase {
  id: string;
  program: McpProgram;
  /** ms */
  at: number;
  /** Its call is gone: the program gave up, or ten minutes passed. */
  gone: boolean;
}

/** The chat a read or message card names, as the list and the app had it when the card opened. */
export interface CardChat {
  n: number;
  ref: ThreadRef;
  title: string;
}

/** A card waiting on the person. */
export type McpCard =
  | (CardBase & { kind: "letIn" })
  | (CardBase & { kind: "read"; chat: CardChat; /** item 97's text: exactly what Let it read answers with */ text: string })
  | (CardBase & { kind: "send"; chat: CardChat; /** the words masked as the card shows them: exactly what Send there puts in the chat */ message: string })
  | (CardBase & {
      kind: "open";
      /** the listed chat whose project the lane is made in */
      chat: CardChat;
      title: string;
      /** masked as the card shows it: exactly the new lane's first message, under the program's mark */
      brief: string;
      agent: string;
      agentLabel: string;
      /** the developer's folder the lane is made from */
      cwd: string;
    });

/** The let-in card (103b's name for it). */
export type LetInCard = Extract<McpCard, { kind: "letIn" }>;

export interface McpSnapshot {
  list: readonly ReachEntry[];
  cards: readonly McpCard[];
}

export interface McpDeps {
  shell: McpShell;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  /** The chat `ref` names now: its key and what it belongs to, or null when the app no longer has it. */
  where(ref: ThreadRef): { key: string; scope: Scope } | null;
  title(ref: ThreadRef): string;
  /** Where chat `key` stands: an ask of it waits on the person, a turn runs, or neither. */
  stateOf(key: string): "working" | "waiting" | "idle";
  /** Who answers in `ref`: the agent of a coding chat, the member of a team thread. */
  whoOf(ref: ThreadRef): string;
  /** A coding chat's link id now, so a later chat that took the same session id is not the one listed. */
  link(ref: ThreadRef): string | undefined;
  /** Item 97's reader, for a read card's text. */
  reader(): ContextReader;
  /** Whether `ref` can take a message: a coding chat on this Mac, started, whose agent runs as the app's chat (102k's rule). */
  sendable(ref: ThreadRef): boolean;
  /** The sessions store's `route`: false when the chat's agent is not running to take it. */
  route(session: string, text: string): Promise<boolean>;
  /** A coding chat's developer folder and agent, the base a new lane is made from; null for anything else. */
  laneBase(ref: ThreadRef): { cwd: string; agent: string } | null;
  /** The agent named (by its id or the name Settings shows) when Manut AI can start it here, on and installed; null when not. */
  agentFor(name: string): { id: string; label: string } | null;
  /** The sessions store's `openLane`: an ordinary lane in its agent's Ask mode. */
  openLane(p: OpenLane): Promise<{ ok: true; id: string } | { ok: false; why: string }>;
  notify?(card: McpCard): void;
  now?(): number;
}

/** What a program hears when the chat it names opens no card. M13: the call's words are never echoed. */
const nothing = (kind: McpAskKind) => (kind === "read" ? "Nothing was read." : kind === "send" ? "Nothing was sent." : "Nothing was started.");
const notListed = (n: number, kind: McpAskKind) => `Chat ${n} is not on the person's list. ${nothing(kind)}`;
const unreachable = (n: number, kind: McpAskKind) => `Chat ${n} can no longer be reached: it left Manut AI, or it is now of another shop or account. ${nothing(kind)}`;
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

export function createMcp(d: McpDeps) {
  let list: ReachEntry[] = loadList(d.storage);
  let cards: McpCard[] = [];
  let snap: McpSnapshot = { list, cards };
  const subs = new Set<() => void>();
  const emit = () => {
    snap = { list, cards };
    for (const f of subs) f();
  };
  const keep = (next: ReachEntry[]) => {
    list = next;
    saveList(d.storage, list);
    emit();
  };
  const now = () => (d.now ?? Date.now)();
  const reply = (id: string, text: string, error: boolean) => void d.shell.reply(id, text, error);

  /** Where listed chat `e` stands now; `gone` and `moved` are never reached. A team thread is never reached either: the list holds
   *  coding chats only, and this holds even for one that got onto it some other way. */
  const stateOf = (e: ReachEntry): ChatState => {
    if (e.ref.kind !== "session") return "gone";
    const w = d.where(e.ref);
    if (!w) return "gone";
    if (e.ref.kind === "session" && e.link && d.link(e.ref) !== e.link) return "gone";
    if (movedScope(e.scope, w.scope)) return "moved";
    return d.stateOf(w.key);
  };
  const reachable = (e: ReachEntry) => {
    const s = stateOf(e);
    return s !== "gone" && s !== "moved";
  };
  /** The listed chat a card names, as it is now: the same chat (by its reference) still on the list. */
  const listed = (chat: CardChat) => list.find((e) => e.n === chat.n && JSON.stringify(e.ref) === JSON.stringify(chat.ref));

  const push = (card: McpCard) => {
    cards = [...cards, card];
    emit();
    d.notify?.(card);
  };
  const take = (id: string) => {
    cards = cards.filter((x) => x.id !== id);
    emit();
  };

  /** A read or a message: its card, or the line that says why there is none. */
  const ask = async (c: McpCall, kind: McpAskKind) => {
    const n = Number(c.args.chat);
    const e = list.find((x) => x.n === n);
    if (!e) return reply(c.id, notListed(n, kind), true);
    if (!reachable(e)) return reply(c.id, unreachable(n, kind), true);
    const chat: CardChat = { n: e.n, ref: e.ref, title: d.title(e.ref) };
    let card: McpCard;
    if (kind === "open") {
      const base = d.laneBase(e.ref);
      if (!base) return reply(c.id, `Chat ${n} is not a coding chat with a project folder, so no lane can be made from it. Nothing was started.`, true);
      const agent = d.agentFor(typeof c.args.agent === "string" ? c.args.agent : base.agent);
      if (!agent) return reply(c.id, "That agent is not one Manut AI can start here: it is not installed, or it is turned off in Settings. Nothing was started.", true);
      card = { kind: "open", id: c.id, program: c.program, at: now(), gone: false, chat, title: oneLine(String(c.args.title ?? "")), brief: maskSecrets(String(c.args.brief ?? "")), agent: agent.id, agentLabel: agent.label, cwd: base.cwd };
    } else if (kind === "send") {
      if (!d.sendable(e.ref)) return reply(c.id, `Chat ${n} is not a coding chat whose agent runs in Manut AI, so a message cannot go there. Nothing was sent.`, true);
      card = { kind: "send", id: c.id, program: c.program, at: now(), gone: false, chat, message: maskSecrets(String(c.args.message ?? "")) };
    } else {
      let text: string;
      try {
        // item 97's text, built with no model, masked and capped: shown whole on the card, and exactly what Let it read answers
        text = (await gatherContext(e.ref, d.reader())).text;
      } catch {
        return reply(c.id, `Chat ${n} could not be read just now. Nothing was read.`, true);
      }
      card = { kind: "read", id: c.id, program: c.program, at: now(), gone: false, chat, text };
    }
    try {
      const { id: _id, at: _at, gone: _gone, ...detail } = card;
      await openMcpAsk(c.id, kind, detail);
    } catch {
      return reply(c.id, "That call was already asked. Nothing was done.", true);
    }
    push(card);
  };

  return {
    getSnapshot: (): McpSnapshot => snap,
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => void subs.delete(f);
    },
    stateOf,

    /** Puts chat `ref` on the list under the next free number. Null when it was added, else the line Settings shows. */
    add(ref: ThreadRef): string | null {
      const title = d.title(ref);
      // coding chats only: a shop's team thread holds its customers' words (the owner, 27 Nov 2026)
      if (ref.kind !== "session") return t("tm.add.team", { title });
      const w = d.where(ref);
      if (!w) return t("tm.add.gone", { title });
      const link = d.link(ref);
      const r = addEntry(list, { ref, ...(link ? { link } : {}), title, scope: w.scope }, OUTSIDE_MAX);
      if (r.refused === "same") return t("tm.add.same", { title });
      if (r.refused === "full") return t("tm.add.full", { max: OUTSIDE_MAX });
      keep(r.list);
      return null;
    },

    /** Takes chat `n` off the list. A card still open that names it can no longer be taken: its press finds the chat gone. */
    remove(n: number): void {
      keep(removeEntry(list, n));
    },

    /** A call the shell handed over. Resolves once its card is up, or it is answered. */
    async call(c: McpCall): Promise<void> {
      if (cards.some((x) => x.id === c.id)) return;
      if (c.tool === "let_in") return push({ kind: "letIn", id: c.id, program: c.program, at: now(), gone: false });
      if (c.tool === "list_chats") return reply(c.id, listLines(list, stateOf, (e) => d.whoOf(e.ref)), false);
      if (c.tool === "read_chat") return ask(c, "read");
      if (c.tool === "send_to_chat") return ask(c, "send");
      if (c.tool === "open_chat") return ask(c, "open");
      reply(c.id, NOT_YET, true);
    },

    /** Call `id` is gone: its card stays, reading "No longer open", until the person closes it; its request is taken back. */
    gone(id: string): void {
      const card = cards.find((x) => x.id === id && !x.gone);
      if (!card) return;
      cards = cards.map((x) => (x.id === id ? { ...x, gone: true } : x));
      if (card.kind !== "letIn") void withdrawMcpAsk(id);
      emit();
    },

    /** The person's press on a let-in card, once: the card goes before the answer is sent, so a second press finds nothing.
     *  True when the shell took the answer; false for a card that is gone or already answered. */
    async letIn(id: string, yes: boolean): Promise<boolean> {
      const card = cards.find((x) => x.id === id);
      if (!card || card.gone || card.kind !== "letIn") return false;
      take(id);
      return d.shell.reply(id, "", !yes);
    },

    /** The person's press on a read or message card, once. The card goes first; approval-core settles its request (refused when
     *  the call is gone); the chat is checked again; only then is anything read out or sent. True when the program was answered. */
    async answer(id: string, yes: boolean): Promise<boolean> {
      const card = cards.find((x) => x.id === id);
      if (!card || card.gone || card.kind === "letIn") return false;
      take(id);
      const settled = await answerMcpAsk(id, card.kind, yes, true);
      if (!settled.ok) return false;
      const { n } = card.chat;
      if (!yes) {
        const no = card.kind === "read" ? `The person did not let you read chat ${n}. Nothing was read.` : card.kind === "send" ? `The person kept your message out of chat ${n}. Nothing was sent.` : "The person did not start the lane. Nothing was started.";
        return d.shell.reply(id, no, true);
      }
      const e = listed(card.chat);
      if (!e || !reachable(e)) return d.shell.reply(id, unreachable(n, card.kind), true);
      if (card.kind === "read") return d.shell.reply(id, card.text, false);
      if (card.kind === "open") {
        const started = await d.openLane({ agent: card.agent, cwd: card.cwd, title: card.title, first: fromProgramText(card.program.name, card.brief), from: "", program: card.program.name });
        if (!started.ok) return d.shell.reply(id, `The lane did not start: ${started.why}`, true);
        // listed for the program when there is room, as the person can see on the list; each read or message still asks
        const ref: ThreadRef = { kind: "session", id: started.id };
        const link = d.link(ref);
        const added = addEntry(list, { ref, ...(link ? { link } : {}), title: card.title, scope: d.where(ref)?.scope ?? e.scope }, OUTSIDE_MAX);
        if (!added.refused) keep(added.list);
        const num = added.refused ? null : added.list[added.list.length - 1].n;
        const said = "It runs in its agent's Ask mode, so each step it takes asks the person.";
        return d.shell.reply(id, num ? `Started the lane as chat ${num}. ${said}` : `Started the lane. ${said} The person's list is full, so it is not listed for you.`, false);
      }
      if (e.ref.kind !== "session" || !d.sendable(e.ref) || !(await d.route(e.ref.id, fromProgramText(card.program.name, card.message)))) {
        return d.shell.reply(id, `Chat ${n}'s agent is not running to take the message. Nothing was sent.`, true);
      }
      return d.shell.reply(id, `Sent to chat ${n}. It waits there while that chat works or waits on the person, and its words answer nothing there.`, false);
    },

    /** Closes a card that reads "No longer open". */
    dismiss(id: string): void {
      if (!cards.some((x) => x.id === id && x.gone)) return;
      take(id);
    },
  };
}

export type Mcp = ReturnType<typeof createMcp>;

let live: Mcp | null = null;
let liveDeps: (() => McpDeps) | null = null;

/** Hands the app's own reads to `getMcp`; `start.ts` does this, so this file needs none of the app's stores. */
export function provideMcpDeps(f: () => McpDeps): void {
  liveDeps = f;
}

/** The app's own, made once. */
export function getMcp(): Mcp {
  live ??= createMcp(
    liveDeps?.() ?? {
      shell: getMcpShell(),
      storage: null,
      where: () => null,
      title: () => "",
      stateOf: () => "idle",
      whoOf: () => "",
      link: () => undefined,
      reader: () => {
        throw new Error("no reader");
      },
      sendable: () => false,
      route: async () => false,
      laneBase: () => null,
      agentFor: () => null,
      openLane: async () => ({ ok: false, why: "not ready" }),
    },
  );
  return live;
}

/** The list and the cards, redrawn when either changes. */
export function useMcp(): McpSnapshot {
  const m = getMcp();
  return useSyncExternalStore(m.subscribe, m.getSnapshot, m.getSnapshot);
}
