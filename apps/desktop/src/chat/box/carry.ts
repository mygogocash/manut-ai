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
// A note on lines selected in the Diff beside a lane (item 146) also carries where they are, `at`: the file, and the line range
// when git's hunk headers numbered the lines. It goes out as the quote's first line, `path:L12-L18` (Paradev's form for a comment
// on lines, with its words for lines that are not the new file's), so the agent is told the place as well as the lines, which are
// quoted as a patch fragment with their `+` and `-`. A range of deleted lines is numbered as the file was before the change, and
// says so. Nothing is sent by adding it: the chip waits above the box like any other.
//
// Kept on this computer by chat key (`manut.box.carry`), beside that chat's unsent text (app/drafts.ts), so a restart keeps
// them. Each chip carries the shop or the coding account it was made under (`Scope`): a chip made under one is refused, and
// never sent, in a chat under another (`scopeRefusal`). Since item 121 a chip also carries every shop whose chat's context the
// chat it came from took in (`through`, kept by chat as `manut.box.through` when a send takes chips), so a shop's context
// cannot reach another shop by way of a coding chat: it is refused anywhere one of those shops differs.
import { useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { changes } from "../../lib/changes";
import type { DiffRange, RangeSide } from "../activity/diffLayout";
import type { NoteAt } from "../activity/diffNote";

export type { NoteAt };

/** The longest selection a note quotes, in characters; the rest is cut with a line that says how much. */
export const QUOTE_MAX = 3_000;
/** The most notes one message carries. */
export const NOTES_MAX = 8;
/** The longest a note's own words may be. */
export const NOTE_MAX = 500;
/** The most chats' context one message carries. */
export const THREADS_MAX = 3;

/** What a chat belongs to: a team chat to the shop every page shows (`shop`, "" when the runtime lists none), a coding chat to
 *  the account its agent runs as (`account`, `<cli>:<account>`, none for an agent with no accounts). `through`: every shop
 *  whose chat's context the chat took in before (item 121), which its own chips carry on. */
export interface Scope {
  shop?: string;
  account?: string;
  through?: string[];
}

/** Every shop a chip's content has passed through: the shop it was made under and the shops its chat took in. */
const shopsOf = (s: Scope): string[] => [...(s.shop !== undefined ? [s.shop] : []), ...(s.through ?? [])];

/** A note on a selection. `more`: characters of the selection left out past QUOTE_MAX (0: none). */
export interface NoteChip {
  kind: "note";
  id: string;
  quote: string;
  more: number;
  note: string;
  scope: Scope;
  /** Where the quote is, for lines selected in a diff (item 146); none for a note on any other text. */
  at?: NoteAt;
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
 *  it may. Every shop the chip passed through counts (item 121): a coding chat that took in one shop's context gives chips that
 *  another shop's chat refuses. A side that names no shop (a coding chat) or no account (a team chat, an agent with none) is no
 *  reason. */
export function scopeRefusal(from: Scope, to: Scope): "shop" | "account" | null {
  if (to.shop !== undefined && shopsOf(from).some((shop) => shop !== to.shop)) return "shop";
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

/** A note chip for `selection` with the person's `note` (one line, at most NOTE_MAX), or null for an empty selection. `at` is where
 *  the selection is, when it was lines of a diff. */
export function noteChip(selection: string, note: string, scope: Scope, id: string = newId(), at?: NoteAt): NoteChip | null {
  const { quote, more } = cutQuote(selection);
  if (!quote.trim()) return null;
  return { kind: "note", id, quote, more, note: note.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX), scope, ...(at ? { at } : {}) };
}

/** Where a note's lines are, as it says it: `src/a.ts:L12-L18`, `src/a.ts:L12` for one line, the file alone when no hunk header
 *  numbered the lines. Lines that are not the new file's are named: deleted lines (numbered as the file was before the change) and a
 *  range across deleted and added lines (numbered as the file is after it). */
export function atText(at: NoteAt): string {
  const r = at.range;
  if (!r) return at.file;
  const lines = r.from === r.to ? `L${r.from}` : `L${r.from}-L${r.to}`;
  const side = r.side === "old" ? t("carry.at.old") : r.side === "mixed" ? t("carry.at.mixed") : "";
  return `${at.file}:${lines}${side ? ` (${side})` : ""}`;
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
export function noteBlock(c: Pick<NoteChip, "quote" | "more" | "note" | "at">): string {
  const lines = c.quote.split("\n").map((l) => (l.trim() ? `> ${l}` : ">"));
  // the place goes first, as a line of the quote, so a message read back (`splitSent`) keeps it with the lines it names
  if (c.at) lines.unshift(`> ${atText(c.at)}`);
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

/** The last two parts of a path (`checkout/Pay.tsx`), for a chip that has little room: enough to tell two files of one name apart. */
const shortPath = (file: string): string => file.split("/").filter(Boolean).slice(-2).join("/");

const noteWords = (c: NoteChip): string => {
  const q = `“${firstWords(c.quote, 28)}”`;
  return c.note ? `${q} · ${c.note}` : q;
};

/** What a chip says: a note as “first words…” · the note, a chat's context as its title. A note on lines of a diff begins with the
 *  file (its last two parts) and the lines. */
export function chipWords(c: Carried): string {
  if (c.kind === "thread") return c.title;
  return c.at ? `${atText({ ...c.at, file: shortPath(c.at.file) })} · ${noteWords(c)}` : noteWords(c);
}

/** What a chip's tooltip says: its words, with the whole path of a note on lines of a diff. */
export const chipTitle = (c: Carried): string => (c.kind === "note" && c.at ? `${atText(c.at)} · ${noteWords(c)}` : chipWords(c));

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
  return (
    !!s &&
    typeof s === "object" &&
    (s.shop === undefined || typeof s.shop === "string") &&
    (s.account === undefined || typeof s.account === "string") &&
    (s.through === undefined || (Array.isArray(s.through) && s.through.every((x) => typeof x === "string")))
  );
};

const SIDES: readonly RangeSide[] = ["new", "old", "mixed"];
const FILE_MAX = 500;

/** A saved note's place, or undefined when it is not one: a file name, and a range only when both numbers are whole and above zero
 *  with the first not past the last, and a side that is known. */
function readAt(v: unknown): NoteAt | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  if (typeof a.file !== "string" || !a.file.trim()) return undefined;
  const file = a.file.slice(0, FILE_MAX);
  const r = a.range as Record<string, unknown> | undefined;
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (r && typeof r === "object" && whole(r.from) && whole(r.to) && r.from <= r.to && SIDES.includes(r.side as RangeSide)) {
    const range: DiffRange = { from: r.from, to: r.to, side: r.side as RangeSide };
    return { file, range };
  }
  return { file };
}

/** One saved chip, or null when it cannot be read (a field missing or of the wrong kind). */
function readChip(v: unknown): Carried | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof c[k] === "string" ? (c[k] as string) : null);
  const id = str("id");
  if (!id || !isScope(c.scope)) return null;
  const quote = str("quote");
  const note = str("note");
  if (c.kind === "note" && quote?.trim() && note !== null) {
    const more = typeof c.more === "number" && Number.isInteger(c.more) && c.more > 0 ? c.more : 0;
    const at = readAt(c.at);
    return { kind: "note", id, quote: quote.slice(0, QUOTE_MAX), more, note: note.slice(0, NOTE_MAX), scope: c.scope, ...(at ? { at } : {}) };
  }
  const ref = str("ref");
  const title = str("title");
  const text = str("text");
  if (c.kind === "thread" && ref && title !== null && text) return { kind: "thread", id, ref, title, text, scope: c.scope };
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
const listeners = changes();
const EMPTY: readonly Carried[] = Object.freeze([]);

/** Tests: where the chips are kept, read again from it (null: the browser's own). */
export function setCarryStorage(s: CarryStorage | null): void {
  storage = s ? () => s : browserStorage;
  byChat = parseCarry(storage()?.getItem(CARRY_KEY) ?? null);
  through = parseThrough(storage()?.getItem(THROUGH_KEY) ?? null);
  listeners.emitSnapshot();
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
  listeners.emitSnapshot();
}

/** Add `chip` to chat `key`'s box; the reason when it was not added. */
export function carry(key: string, chip: Carried): "notes" | "threads" | "same" | null {
  const r = addCarried(getCarried(key), chip);
  if (!r.refused) setCarried(key, r.list);
  return r.refused;
}

/** Take chip `id` out of chat `key`'s box. */
export const dropCarried = (key: string, id: string): void => setCarried(key, getCarried(key).filter((c) => c.id !== id));

// ---- the shops a chat took in (item 121) -----------------------------------------------------------------------------

export const THROUGH_KEY = "manut.box.through";

/** The record by chat, defensively: a chat's entry is the strings of its list, anything else is left out. */
function parseThrough(raw: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [key, list] of Object.entries(v as Record<string, unknown>)) {
      out[key] = Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string"))] : [];
    }
  } catch {
    /* none kept */
  }
  return out;
}

let through: Record<string, string[]> = parseThrough(storage()?.getItem(THROUGH_KEY) ?? null);

/** Every shop whose chat's context chat `key` took in, by any chip a send took there. */
export const throughOf = (key: string): string[] => through[key] ?? [];

/** A send in chat `key` took `chips`: every shop they passed through is the chat's now, for the chips made of it later. */
export function tookIn(key: string, chips: readonly Carried[]): void {
  const shops = [...new Set([...throughOf(key), ...chips.flatMap((c) => shopsOf(c.scope))])];
  if (shops.length === throughOf(key).length) return;
  through = { ...through, [key]: shops };
  try {
    storage()?.setItem(THROUGH_KEY, JSON.stringify(through));
  } catch {
    /* no storage, or full: it holds for this run */
  }
}

/** `scope`, the scope of chat `key`, with the shops that chat took in (`through`) when it took any. */
export function withThrough(key: string, scope: Scope): Scope {
  const shops = throughOf(key);
  return shops.length ? { ...scope, through: shops } : scope;
}

/** Chat `key`'s chips, for its box. */
export function useCarried(key: string): readonly Carried[] {
  return useSyncExternalStore(
    (l) => {
      return listeners.subscribe(l);
    },
    () => getCarried(key),
    () => getCarried(key),
  );
}
