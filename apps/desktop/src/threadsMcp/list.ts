// The chats other programs may reach (item 103, `docs/mcp-threads.md`, rule M7): the person's own list in Settings › MCP and
// Skills › Other programs, at most `OUTSIDE_MAX` chats, each named by its number there and nothing else. It is 102k's list
// (`jobs/reachList.ts`: the same entries, numbers that are never reused while a chat is listed, the shop or account a chat had
// when it was listed) with its own cap, kept on this Mac rather than with one chat, since a program outside the app is not one
// chat's agent.
//
// Also here, as plain text: what `list_chats` answers. It is English in every language, as 102k's notes to an agent are: the
// program's model reads it, not the person.
import type { Scope } from "../chat/box/carry";
import { maskSecrets } from "../lib/secrets";
import { ENTRY_TITLE_MAX, parseEntries, type ReachEntry } from "../jobs/reachList";

/** The most chats on the list, and so the highest number a call may name (`MAX_LIST` in `src-tauri/src/threads_mcp`). */
export const OUTSIDE_MAX = 10;

/** Where the list is kept on this Mac. */
export const LIST_KEY = "manut.threadsMcp.list";

/** Where a listed chat stands now. `gone`: the app no longer has it; `moved`: it is now of another shop or account than when
 *  it was listed, so nothing of it is reached (as 102k's `crossing`). */
export type ChatState = "working" | "waiting" | "idle" | "gone" | "moved";

/** Whether `now` names another shop or account than `listed` did. */
export function movedScope(listed: Scope, now: Scope): boolean {
  return (listed.shop ?? "") !== (now.shop ?? "") || (listed.account ?? "") !== (now.account ?? "");
}

const STATE_WORDS: Record<ChatState, string> = {
  working: "working",
  waiting: "waiting on the person",
  idle: "idle",
  gone: "no longer in Manut AI; it cannot be reached",
  moved: "now of another shop or account; it cannot be reached",
};

/** What `list_chats` answers when nothing is listed. */
export const EMPTY_LIST = "The person has not listed any chats for other programs. They add chats in Manut AI, in Settings, MCP and Skills, Other programs.";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `list_chats`'s answer: one line a listed chat, its number, its title (masked, as any text the app hands over is), who
 *  answers there and where it stands, then how to name one. */
export function listLines(list: readonly ReachEntry[], stateOf: (e: ReachEntry) => ChatState, whoOf: (e: ReachEntry) => string): string {
  if (!list.length) return EMPTY_LIST;
  const lines = [...list]
    .sort((a, b) => a.n - b.n)
    .map((e) => {
      const title = oneLine(maskSecrets(e.title)).slice(0, ENTRY_TITLE_MAX);
      const who = oneLine(whoOf(e));
      return `${e.n}. ${title} (${who ? `${who}, ` : ""}${STATE_WORDS[stateOf(e)]})`;
    });
  return [...lines, "", "Name a chat by its number. Every read, message and new lane asks the person first."].join("\n");
}

/** The list as kept on this Mac, read defensively (`parseEntries`), or empty when nothing can be read. */
export function loadList(storage: Pick<Storage, "getItem"> | null): ReachEntry[] {
  try {
    const raw = storage?.getItem(LIST_KEY);
    return raw ? parseEntries(JSON.parse(raw), OUTSIDE_MAX) : [];
  } catch {
    return [];
  }
}

/** Keeps the list on this Mac. False when it could not be kept (a private window, storage that throws). */
export function saveList(storage: Pick<Storage, "setItem"> | null, list: readonly ReachEntry[]): boolean {
  try {
    storage?.setItem(LIST_KEY, JSON.stringify(list));
    return !!storage;
  } catch {
    return false;
  }
}
