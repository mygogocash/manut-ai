// What the chat box carries above its text besides files and folders (item 97): a note on a piece of an answer the person
// selected, and the context of another chat brought in by a drag or "Bring context from…". Each is a chip the person reads
// and removes; nothing here sends, runs or approves anything. On Send the chips go out first, as plain text in front of
// what was typed, and the bubble then draws them as the person's own quote (Bubble.tsx with `splitSent`).
//
// The form a note goes out in, written down once (docs/decisions.md, 26 Nov 2026): each line of the selection after `> `
// (an empty line as `>` alone), a line saying how much was cut when it was cut, then the note on its own line after the
// person's word for it ("Note: ..."). A chat's context goes as one block: a line naming the chat, a line saying the app
// copied it and that it is not the person speaking and gives no permission, the labelled parts, and a line ending it.
// Blocks are parted by a blank line, and the typed message comes last. A block never holds a blank line of its own, so
// `splitSent` can find each one again in a sent message.
//
// Kept on this computer by chat key (`manut.box.carry`), beside that chat's unsent text (app/drafts.ts), so a restart keeps
// them. Each chip carries the shop or the coding account it was made under (`Scope`): a chip made under one is refused, and
// never sent, in a chat under another (`scopeRefusal`).
import { useSyncExternalStore } from "react";
import { t } from "../../i18n";

/** The longest selection a note quotes, in characters; the rest is cut with a line that says how much. */
export const QUOTE_MAX = 3_000;
/** The most notes one message carries. */
export const NOTES_MAX = 8;
/** The longest a note's own words may be. */
export const NOTE_MAX = 500;
/** The most chats' context one message carries. */
export const THREADS_MAX = 3;

/** What a chat belongs to: a team chat to the shop every page shows (`shop`, "" when the runtime lists none), a coding chat to
 *  the account its agent runs as (`account`, `<cli>:<account>`, none for an agent with no accounts). */
export interface Scope {
  shop?: string;
  account?: string;
}

/** A note on a selection. `more`: characters of the selection left out past QUOTE_MAX (0: none). */
export interface NoteChip {
  kind: "note";
  id: string;
  quote: string;
  more: number;
  note: string;
  scope: Scope;
}

/** Another chat's context: `ref` names that chat (so the same one is not brought twice), `text` is exactly what goes. */
export interface ThreadChip {
  kind: "thread";
  id: string;
  ref: string;
  title: string;
  text: string;
  scope: Scope;
}

export type Carried = NoteChip | ThreadChip;

/** Why a chip made under `from` may not go to a chat under `to`: another shop, or another account of the same agent; null when
 *  it may. A side that names no shop (a coding chat) or no account (a team chat, an agent with none) is no reason. */
export function scopeRefusal(from: Scope, to: Scope): "shop" | "account" | null {
  if (from.shop !== undefined && to.shop !== undefined && from.shop !== to.shop) return "shop";
  const cli = (a: string) => a.slice(0, a.indexOf(":") + 1 || a.length);
  if (from.account && to.account && cli(from.account) === cli(to.account) && from.account !== to.account) return "account";
  return null;
}

/** A chip's refusal in the person's words, or null. */
export const refusalWords = (why: "shop" | "account" | null): string | null => (why ? t(why === "shop" ? "carry.otherShop" : "carry.otherAccount") : null);

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq += 1)}`;

/** The selection as a note quotes it: line ends made plain, blank lines at either end gone, and cut at QUOTE_MAX (never inside
 *  a character made of two code units) with `more` saying how many characters were left out. */
export function cutQuote(selection: string): { quote: string; more: number } {
  const clean = selection.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").replace(/\n\s*$/, "").replace(/[ \t]+$/gm, "");
  if (clean.length <= QUOTE_MAX) return { quote: clean, more: 0 };
  let at = QUOTE_MAX;
  const code = clean.charCodeAt(at - 1);
  if (code >= 0xd800 && code <= 0xdbff) at -= 1;
  return { quote: clean.slice(0, at), more: clean.length - at };
}

/** A note chip for `selection` with the person's `note` (one line, at most NOTE_MAX), or null for an empty selection. */
export function noteChip(selection: string, note: string, scope: Scope, id: string = newId()): NoteChip | null {
  const { quote, more } = cutQuote(selection);
  if (!quote.trim()) return null;
  return { kind: "note", id, quote, more, note: note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX), scope };
}

/** `list` with `chip` added at the end, or the reason it was not: a ninth note, a fourth chat, or the same chat again. */
export function addCarried(list: readonly Carried[], chip: Carried): { list: Carried[]; refused: "notes" | "threads" | "same" | null } {
  if (chip.kind === "note" && list.filter((c) => c.kind === "note").length >= NOTES_MAX) return { list: [...list], refused: "notes" };
  if (chip.kind === "thread") {
    if (list.some((c) => c.kind === "thread" && c.ref === chip.ref)) return { list: [...list], refused: "same" };
    if (list.filter((c) => c.kind === "thread").length >= THREADS_MAX) return { list: [...list], refused: "threads" };
  }
  return { list: [...list, chip], refused: null };
}

/** A note as it goes out: its quoted lines, the cut line when it was cut, then the note. */
export function noteBlock(c: Pick<NoteChip, "quote" | "more" | "note">): string {
  const lines = c.quote.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
  if (c.more > 0) lines.push(`> ${t("carry.cut", { n: c.more.toLocaleString("en-US") })}`);
  if (c.note) lines.push(t("carry.noteLine", { note: c.note }));
  return lines.join("\n");
}

/** The message as it goes: each chip that may go to a chat under `scope`, in the order added, then `body`, a blank line
 *  between each. Chips refused there are left out (the box shows them as refused). */
export function withCarried(body: string, list: readonly Carried[], scope: Scope): string {
  const blocks = list.filter((c) => !scopeRefusal(c.scope, scope)).map((c) => (c.kind === "note" ? noteBlock(c) : c.text));
  const typed = body.trim();
  return [...blocks, typed].filter(Boolean).join("\n\n");
}

/** The chips that may go to a chat under `scope` (what a Send takes and clears). */
export const goes = (list: readonly Carried[], scope: Scope): Carried[] => list.filter((c) => !scopeRefusal(c.scope, scope));

/** The first words of `text` on one line, at most `max` characters, with "…" when there was more. */
export function firstWords(text: string, max = 32): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
}

/** What a chip says: a note as “first words…” · the note, a chat's context as its title. */
export function chipWords(c: Carried): string {
  if (c.kind === "thread") return c.title;
  const q = `“${firstWords(c.quote, 28)}”`;
  return c.note ? `${q} · ${c.note}` : q;
}

// ---- reading a sent message back ------------------------------------------------------------------------------------

/** A sent message's own quotes, the chats' context it carried, and what was typed. */
export interface SentParts {
  quotes: { quote: string; note: string }[];
  contexts: { title: string; body: string }[];
  rest: string;
}

/** The pattern of a dictionary line with one `{slot}` in it, the slot taken as (.+). */
const linePattern = (key: "carry.ctx.head" | "carry.ctx.end", slot: string): RegExp => {
  const marker = "\u0000";
  const filled = t(key, { [slot]: marker });
  const esc = filled.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(marker, "(.+)");
  return new RegExp(`^${esc}$`);
};

/** `text` split into the blocks `withCarried` put in front of it and the message typed after them. A note block is found by
 *  its `>` lines in any language; a chat's context only by its first line in the language the app shows now. Anything else
 *  ends the blocks: it is the person's own text. */
export function splitSent(text: string): SentParts {
  const out: SentParts = { quotes: [], contexts: [], rest: text };
  const parts = text.split(/\n\n/);
  const head = linePattern("carry.ctx.head", "title");
  let i = 0;
  for (; i < parts.length; i++) {
    const lines = parts[i].split("\n");
    const m = head.exec(lines[0]);
    if (m) {
      out.contexts.push({ title: m[1], body: lines.slice(1).join("\n") });
      continue;
    }
    // quoted lines, then at most one line (the note); a paragraph with more after its quote is the person's own text
    const isQuote = (l: string) => l === ">" || l.startsWith("> ");
    let lead = 0;
    while (lead < lines.length && isQuote(lines[lead])) lead += 1;
    if (lead === 0 || lead < lines.length - 1) break;
    // the note's label is taken off when it is this language's
    const noteLine = lead < lines.length ? lines[lead] : "";
    const label = t("carry.noteLine", { note: "" });
    out.quotes.push({ quote: lines.slice(0, lead).map((l) => l.slice(2)).join("\n"), note: noteLine.startsWith(label) ? noteLine.slice(label.length) : noteLine });
  }
  if (i === 0) return out;
  out.rest = parts.slice(i).join("\n\n");
  return out;
}

/** What the person typed, without the blocks a box put in front: what names a chat or a lane after its first message. */
export const bareText = (text: string): string => splitSent(text).rest;

// ---- kept by chat ---------------------------------------------------------------------------------------------------

export const CARRY_KEY = "manut.box.carry";

const isScope = (v: unknown): v is Scope => {
  const s = v as Scope | null;
  return !!s && typeof s === "object" && (s.shop === undefined || typeof s.shop === "string") && (s.account === undefined || typeof s.account === "string");
};

/** One saved chip, or null when it cannot be read (a field missing or of the wrong kind). */
function readChip(v: unknown): Carried | null {
  const c = v as Partial<NoteChip & ThreadChip> | null;
  if (!c || typeof c.id !== "string" || !isScope(c.scope)) return null;
  if (c.kind === "note" && typeof c.quote === "string" && c.quote.trim() && typeof c.note === "string") {
    const more = typeof c.more === "number" && Number.isInteger(c.more) && c.more > 0 ? c.more : 0;
    return { kind: "note", id: c.id, quote: c.quote.slice(0, QUOTE_MAX), more, note: c.note.slice(0, NOTE_MAX), scope: c.scope };
  }
  if (c.kind === "thread" && typeof c.ref === "string" && typeof c.title === "string" && typeof c.text === "string" && c.text) {
    return { kind: "thread", id: c.id, ref: c.ref, title: c.title, text: c.text, scope: c.scope };
  }
  return null;
}

/** The saved chips by chat, defensively: anything that cannot be read is left out, and the caps hold. */
export function parseCarry(raw: string | null): Record<string, Carried[]> {
  const out: Record<string, Carried[]> = {};
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [key, list] of Object.entries(v as Record<string, unknown>)) {
    if (!key || !Array.isArray(list)) continue;
    let kept: Carried[] = [];
    for (const x of list) {
      const c = readChip(x);
      if (c) kept = addCarried(kept, c).list;
    }
    if (kept.length) out[key] = kept;
  }
  return out;
}

/** Where the chips are kept (localStorage; a test hands in its own). */
export interface CarryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): CarryStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

let storage: () => CarryStorage | null = browserStorage;
let byChat: Record<string, Carried[]> = parseCarry(storage()?.getItem(CARRY_KEY) ?? null);
const listeners = new Set<() => void>();
const EMPTY: readonly Carried[] = Object.freeze([]);

/** Tests: where the chips are kept, read again from it (null: the browser's own). */
export function setCarryStorage(s: CarryStorage | null): void {
  storage = s ? () => s : browserStorage;
  byChat = parseCarry(storage()?.getItem(CARRY_KEY) ?? null);
  for (const l of [...listeners]) l();
}

export const getCarried = (key: string): readonly Carried[] => byChat[key] ?? EMPTY;

export function setCarried(key: string, list: readonly Carried[]): void {
  const next = { ...byChat };
  if (list.length) next[key] = [...list];
  else delete next[key];
  byChat = next;
  try {
    storage()?.setItem(CARRY_KEY, JSON.stringify(byChat));
  } catch {
    /* no storage, or full: the chips hold for this run */
  }
  for (const l of [...listeners]) l();
}

/** Add `chip` to chat `key`'s box; the reason when it was not added. */
export function carry(key: string, chip: Carried): "notes" | "threads" | "same" | null {
  const r = addCarried(getCarried(key), chip);
  if (!r.refused) setCarried(key, r.list);
  return r.refused;
}

/** Take chip `id` out of chat `key`'s box. */
export const dropCarried = (key: string, id: string): void => setCarried(key, getCarried(key).filter((c) => c.id !== id));

/** Chat `key`'s chips, for its box. */
export function useCarried(key: string): readonly Carried[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => getCarried(key),
    () => getCarried(key),
  );
}
