// The reach blocks a coding chat's agent ends an answer with to ask to read another chat, send it a message, or open a new lane
// (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats", rule R10). Pure functions over the answer's text:
// nothing here reads a chat, sends anything or starts an agent. The chat reads an answer with them once its turn ends
// (`reachOutcome`), and hides the blocks while the answer streams (`hideReachBlocks`), in a turn that started with chats on its
// "Kit may reach" list (`Turn.reach`).
//
// The fence walk is item 102e's (`fencedBlocks` in `helperBlocks.ts`, GoSpark's parser with the fork's top-level walk): only a fence
// that opens its own line at the top level counts, never one inside a `>` quote or inside another fence that quotes it as an
// example. The open block takes exactly a helper's keys and is read by item 102e's `helperFrom`, since it asks for the same thing:
// a lane on an agent with a brief. As there, a block that cannot be read, or that names a key outside its own, refuses the whole
// answer's request, and so does a second block: one request an answer, so a card never stands for less than what was asked and
// pressing one card never leaves another of the same answer behind a turn that moved on.
import { BRIEF_MAX, fencedBlocks, endsInFenced, helperFrom, hideFenced, isRefusal, NAME_MAX, type HelperBrief } from "./helperBlocks";

/** The words that open a reach block, one for each thing an agent may ask. No shorter form: `read`, `send` and `open` are words an
 *  agent's own code blocks use. */
export const REACH_FENCES = ["manut-read", "manut-send", "manut-open"] as const;

/** The only keys each block takes. A block names a chat by what its list calls it, never by a path, an id or a mode: any other key
 *  refuses the whole request (R10, as R3 for helper blocks). */
export const REACH_KEYS = {
  read: ["chat"],
  send: ["chat", "message"],
  open: ["title", "brief", "agent", "model", "effort"],
} as const;

/** The longest message a send block takes, in characters: the card shows it whole, as a helper's brief. */
export const MESSAGE_MAX = BRIEF_MAX;

export type ReachKind = keyof typeof REACH_KEYS;

/** What one place's blocks take: the keys of each block, and the longest message or brief. A coding chat on this Mac takes
 *  `MAC_GRAMMAR`; Buddy's chats on the Connected runtime take `BUDDY_GRAMMAR` (item 102l-3). The fences are the same in both. */
export interface ReachGrammar {
  readonly keys: { readonly [K in ReachKind]: readonly string[] };
  readonly max: number;
}

/** A coding chat's blocks (item 102k): a new lane takes a helper's five keys. */
export const MAC_GRAMMAR: ReachGrammar = { keys: REACH_KEYS, max: MESSAGE_MAX };

/** The longest message or brief a block of Buddy's takes on Connected. Each goes to the API's chat as one message, which takes at
 *  most 8,000 characters (apps/api chat-store.ts): this leaves room for the line saying where it came from and for the note of the
 *  conversation it reaches (`reachMarks.ts`). */
export const BUDDY_MESSAGE_MAX = 5_000;

/** Buddy's blocks on Connected (item 102l-3): a new conversation takes only its first message, its brief. The API names a
 *  conversation by its first words and answers every one with the same model, so a title, an agent, a model and an effort would be
 *  promises nothing keeps. */
export const BUDDY_GRAMMAR: ReachGrammar = { keys: { read: ["chat"], send: ["chat", "message"], open: ["brief"] }, max: BUDDY_MESSAGE_MAX };

/** What one block asks. `chat` is the name the agent wrote, exactly: the list decides whether it names a chat at all. */
export type ReachRequest =
  | { readonly kind: "read"; readonly chat: string }
  | { readonly kind: "send"; readonly chat: string; readonly message: string }
  | { readonly kind: "open"; readonly lane: HelperBrief };

/** Why a request could not be read. Each refuses it whole: no card, a line in the chat. */
export type ReachRefusal =
  /** a block is not JSON */
  | { readonly why: "json" }
  /** a block is not one object (a list, a string, a number) */
  | { readonly why: "shape" }
  /** a block has a key outside its own, such as `mode`, `approve` or `path` */
  | { readonly why: "key"; readonly key: string }
  /** a value is not one line of text, where one line is what it takes */
  | { readonly why: "value"; readonly key: string }
  /** a read or send names no chat */
  | { readonly why: "chat" }
  /** a send has no words */
  | { readonly why: "message" }
  /** an open has no brief */
  | { readonly why: "brief" }
  /** a message or a brief is longer than its grammar's `max` */
  | { readonly why: "long" }
  /** a block was never closed: the answer was cut short */
  | { readonly why: "unclosed" }
  /** the answer holds more than one reach block */
  | { readonly why: "many" };

export type ReachOutcome =
  /** no reach block: the agent answered by itself */
  | { readonly kind: "none" }
  /** a block was there and the request cannot be used */
  | { readonly kind: "refused"; readonly refusal: ReachRefusal }
  /** one block, read */
  | { readonly kind: "request"; readonly request: ReachRequest };

const kindOf = (word: string): ReachKind => word.slice("manut-".length) as ReachKind;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** The chat a read or send names: one line of text, at most `NAME_MAX`. */
function chatOf(entry: Record<string, unknown>): string | ReachRefusal {
  if (!("chat" in entry)) return { why: "chat" };
  if (typeof entry.chat !== "string") return { why: "value", key: "chat" };
  const chat = entry.chat.trim();
  if (/[\r\n]/.test(chat) || chat.length > NAME_MAX) return { why: "value", key: "chat" };
  return chat || { why: "chat" };
}

/** One block's request, or why it cannot be one. Strict as a helper block is: an unknown key, a value that is not text, or a
 *  missing chat, message or brief refuses it. */
function readBlock(kind: ReachKind, body: string, grammar: ReachGrammar): ReachRequest | ReachRefusal {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { why: "json" };
  }
  if (!isPlainObject(json)) return { why: "shape" };
  const keys: readonly string[] = grammar.keys[kind];
  for (const key of Object.keys(json)) if (!keys.includes(key)) return { why: "key", key: cut(oneLine(key), 40) };
  if (kind === "open") {
    const lane = helperFrom(json);
    if (!isRefusal(lane)) return lane.brief.length > grammar.max ? { why: "long" } : { kind: "open", lane };
    // the helper's own reasons say the same things in this block's terms
    if (lane.why === "key" || lane.why === "value") return lane;
    if (lane.why === "brief" || lane.why === "long") return { why: lane.why };
    return { why: "shape" };
  }
  for (const key of keys) if (key in json && typeof json[key] !== "string") return { why: "value", key };
  const chat = chatOf(json);
  if (typeof chat !== "string") return chat;
  if (kind === "read") return { kind: "read", chat };
  const message = typeof json.message === "string" ? json.message.trim() : "";
  if (!message) return { why: "message" };
  if (message.length > grammar.max) return { why: "long" };
  return { kind: "send", chat, message };
}

/** What an answer asks once its turn is over: none, one request, or why it is refused. Every top-level reach block counts, so a
 *  second one refuses the request (`many`), as does one left open at the end (a stopped or truncated answer). `grammar` is the
 *  place's keys and longest message: a coding chat's unless another is handed in. */
export function reachOutcome(text: string, grammar: ReachGrammar = MAC_GRAMMAR): ReachOutcome {
  const { blocks } = fencedBlocks(text, REACH_FENCES);
  if (!blocks.length) return { kind: "none" };
  if (blocks.some((b) => !b.closed)) return { kind: "refused", refusal: { why: "unclosed" } };
  if (blocks.length > 1) return { kind: "refused", refusal: { why: "many" } };
  const read = readBlock(kindOf(blocks[0].word), blocks[0].body, grammar);
  return "why" in read ? { kind: "refused", refusal: read } : { kind: "request", request: read };
}

/** Which of a turn's answers, oldest first, carries the request to act on: the newest one with a reach block, readable or not. */
export function reachReply(texts: readonly string[]): number | null {
  for (let i = texts.length - 1; i >= 0; i--) if (fencedBlocks(texts[i], REACH_FENCES).blocks.length) return i;
  return null;
}

/** Whether `text` has a reach block at its top level, closed or still being written. */
export const hasReachBlock = (text: string): boolean => fencedBlocks(text, REACH_FENCES).blocks.length > 0;

/** Whether `text` ends in a reach block, with nothing but blank lines after it. */
export const endsInReachBlock = (text: string): boolean => endsInFenced(text, REACH_FENCES);

/** The answer as the person reads it in a chat whose turn started with chats on its list: every top-level reach block taken out,
 *  and one still open cut from its fence to the end. */
export const hideReachBlocks = (text: string): string => hideFenced(text, REACH_FENCES);
