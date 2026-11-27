// What the page does with item 103's calls (`docs/mcp-threads.md`): the list of chats other programs may reach, and the card
// that lets a program in for one run of it. The shell decides who may ask (`src-tauri/src/threads_mcp/door.rs`); this decides
// what a chat is and what an answer says, and only the person's press lets a program in.
//
// - `let_in`: a card over whatever is showing (`Cards.tsx`), counted on the Dock's badge and announced by a notification while
//   the window is not in front. Let in while it runs, or No; pressed once, and a card whose call is gone reads "No longer
//   open" and answers nothing.
// - `list_chats`: answered at once from the list (`listLines`): number, title, who answers there and where it stands. The
//   shell sends it only for a program the person let in.
// - `read_chat`, `send_to_chat` and `open_chat`: refused, plainly, until slices 103c and 103d build their cards.
//
// `createMcp` takes everything it reads as `McpDeps`, so a test drives it with stand-ins; `getMcp` is the app's own.
import { useSyncExternalStore } from "react";
import type { Scope } from "../chat/box/carry";
import type { ThreadRef } from "../chat/box/threadContext";
import { addEntry, removeEntry, type ReachEntry } from "../jobs/reachList";
import { t } from "../i18n";
import { listLines, loadList, movedScope, OUTSIDE_MAX, saveList, type ChatState } from "./list";
import { getMcpShell, type McpCall, type McpProgram, type McpShell } from "./shell";

/** What a read, a message or a new lane is answered until their slices are built. */
export const NOT_YET = "Manut AI cannot do that for other programs yet: only list_chats works in this version. Nothing was done.";

/** A program waiting to be let in. */
export interface LetInCard {
  id: string;
  program: McpProgram;
  /** ms */
  at: number;
  /** Its call is gone: the program gave up, or ten minutes passed. */
  gone: boolean;
}

export interface McpSnapshot {
  list: readonly ReachEntry[];
  cards: readonly LetInCard[];
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
  notify?(card: LetInCard): void;
  now?(): number;
}

export function createMcp(d: McpDeps) {
  let list: ReachEntry[] = loadList(d.storage);
  let cards: LetInCard[] = [];
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

  /** Where listed chat `e` stands now; `gone` and `moved` are never reached. */
  const stateOf = (e: ReachEntry): ChatState => {
    const w = d.where(e.ref);
    if (!w) return "gone";
    if (e.ref.kind === "session" && e.link && d.link(e.ref) !== e.link) return "gone";
    if (movedScope(e.scope, w.scope)) return "moved";
    return d.stateOf(w.key);
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
      const w = d.where(ref);
      if (!w) return t("tm.add.gone", { title });
      const link = d.link(ref);
      const r = addEntry(list, { ref, ...(link ? { link } : {}), title, scope: w.scope }, OUTSIDE_MAX);
      if (r.refused === "same") return t("tm.add.same", { title });
      if (r.refused === "full") return t("tm.add.full", { max: OUTSIDE_MAX });
      keep(r.list);
      return null;
    },

    /** Takes chat `n` off the list. */
    remove(n: number): void {
      keep(removeEntry(list, n));
    },

    /** A call the shell handed over. */
    call(c: McpCall): void {
      if (c.tool === "let_in") {
        if (cards.some((x) => x.id === c.id)) return;
        const card: LetInCard = { id: c.id, program: c.program, at: (d.now ?? Date.now)(), gone: false };
        cards = [...cards, card];
        emit();
        d.notify?.(card);
        return;
      }
      if (c.tool === "list_chats") {
        void d.shell.reply(c.id, listLines(list, stateOf, (e) => d.whoOf(e.ref)), false);
        return;
      }
      void d.shell.reply(c.id, NOT_YET, true);
    },

    /** Call `id` is gone: its card stays, reading "No longer open", until the person closes it. */
    gone(id: string): void {
      if (!cards.some((x) => x.id === id && !x.gone)) return;
      cards = cards.map((x) => (x.id === id ? { ...x, gone: true } : x));
      emit();
    },

    /** The person's press on a let-in card, once: the card goes before the answer is sent, so a second press finds nothing.
     *  True when the shell took the answer; false for a card that is gone or already answered. */
    async letIn(id: string, yes: boolean): Promise<boolean> {
      const card = cards.find((x) => x.id === id);
      if (!card || card.gone) return false;
      cards = cards.filter((x) => x.id !== id);
      emit();
      return d.shell.reply(id, "", !yes);
    },

    /** Closes a card that reads "No longer open". */
    dismiss(id: string): void {
      if (!cards.some((x) => x.id === id && x.gone)) return;
      cards = cards.filter((x) => x.id !== id);
      emit();
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
    },
  );
  return live;
}

/** The list and the cards, redrawn when either changes. */
export function useMcp(): McpSnapshot {
  const m = getMcp();
  return useSyncExternalStore(m.subscribe, m.getSnapshot, m.getSnapshot);
}
