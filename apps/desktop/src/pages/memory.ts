// The memory half of Customize, kept apart from the page so it can be tested without one: which facts are the team's and
// which wait, how a fact's source is said, how the in-place questions of Correct and Forget move, and how a refusal reaches
// the owner. The design canvas's board is "Customize: memory and routines" (Brain.dc.html). What makes a fact wait and what
// Forget keeps are `@manut/shop-memory`'s rules, which the runtime applies (src/runtime/memory.ts); nothing here decides
// them, and nothing here can use a fact: the page only shows what the runtime says and asks it to act.
import { MAX_FACTS, MAX_TEXT } from "@manut/shop-memory";
import { lang, locale, t, type Key } from "../i18n";
import type { MemoryFact } from "../runtime/memory";
import { unavailable } from "./load";

/** The two lists the page shows. Only a confirmed fact is one the team uses. Anything else waits, which includes a status this
 *  app does not know, so a waiting fact can never be shown as used. */
export function groupFacts(facts: readonly MemoryFact[]): { known: MemoryFact[]; waiting: MemoryFact[] } {
  return { known: facts.filter((f) => f.status === "confirmed"), waiting: facts.filter((f) => f.status !== "confirmed") };
}

/** A fact put in its place after it changed: where it stood, or last when the list did not have it. */
export function withFact(facts: readonly MemoryFact[], fact: MemoryFact): MemoryFact[] {
  return facts.some((f) => f.id === fact.id) ? facts.map((f) => (f.id === fact.id ? fact : f)) : [...facts, fact];
}

/** The list once a fact is forgotten. Nothing of the fact stays here: not its words, and not its id. */
export function withoutFact(facts: readonly MemoryFact[], id: string): MemoryFact[] {
  return facts.filter((f) => f.id !== id);
}

/** "3 November", or "3 November 2025" when it is not this year. English writes the day first, as the canvas does and as the
 *  shop's own country does. */
function dayText(sec: number, nowMs: number): string {
  const at = new Date(sec * 1000);
  const thisYear = at.getFullYear() === new Date(nowMs).getFullYear();
  return at.toLocaleDateString(lang() === "en" ? "en-GB" : locale(), { day: "numeric", month: "long", ...(thisYear ? {} : { year: "numeric" }) });
}

/** Where a fact came from, as the canvas's "Where it came from" says it. A fact the owner corrected says so instead: its
 *  words are the owner's now, and "From your price list" would say something false about them. A source this app does not
 *  know says nothing, never a guess. */
export function sourceLine(fact: Pick<MemoryFact, "source" | "correctedAt">, nowMs: number): string {
  if (fact.correctedAt !== null) return t("memory.src.corrected", { date: dayText(fact.correctedAt, nowMs) });
  const s = fact.source;
  switch (s.kind) {
    case "owner":
      return t("memory.src.owner");
    case "document":
      return t("memory.src.document", { name: s.name, date: dayText(s.date, nowMs) });
    case "edits":
      return t(s.count === 1 ? "memory.src.edit1" : "memory.src.edits", { n: s.count });
    case "orders":
      return t(s.days === 1 ? "memory.src.orders1" : "memory.src.orders", { n: s.days });
    case "connection":
      return t("memory.src.connection", { name: s.name, detail: s.detail });
    case "customer":
      return t("memory.src.customer");
    default:
      return "";
  }
}

/** The question one row asks in place. Correct and Forget do nothing until the owner answers it; the page asks about one fact
 *  at a time. */
export type MemoryAsk = { kind: "correct"; fact: string; draft: string } | { kind: "forget"; fact: string } | null;

/** What the page itself holds: the question that is open, what is typed in the Remember box, a request on its way and why the
 *  last one did not go. What the team knows is the runtime's to say, not the page's. */
export interface MemoryUi {
  ask: MemoryAsk;
  add: string;
  busy: boolean;
  error: string | null;
}

export const MEMORY_START: MemoryUi = { ask: null, add: "", busy: false, error: null };

export type MemoryAction =
  | { type: "correct"; fact: string; text: string }
  | { type: "forget"; fact: string }
  | { type: "draft"; text: string }
  | { type: "add"; text: string }
  | { type: "cancel" }
  | { type: "begin" }
  | { type: "done"; what: "remember" | "confirm" | "correct" | "forget" }
  | { type: "failed"; message: string };

/** Moves the page between asking, waiting on the runtime and done. While a request is on its way nothing else can be asked or
 *  typed, so the owner cannot ask twice and what they typed is not lost when it ends. */
export function memoryReduce(s: MemoryUi, a: MemoryAction): MemoryUi {
  switch (a.type) {
    case "correct":
      return s.busy ? s : { ...s, ask: { kind: "correct", fact: a.fact, draft: a.text }, error: null };
    case "forget":
      return s.busy ? s : { ...s, ask: { kind: "forget", fact: a.fact }, error: null };
    case "draft":
      return !s.busy && s.ask?.kind === "correct" ? { ...s, ask: { ...s.ask, draft: a.text } } : s;
    case "add":
      return s.busy ? s : { ...s, add: a.text, error: null };
    case "cancel":
      return s.busy ? s : { ...s, ask: null, error: null };
    case "begin":
      return { ...s, busy: true, error: null };
    // A fact that was remembered empties the box; one that was corrected or forgotten ends its question. A refusal keeps
    // both, so the owner can read it and try again.
    case "done":
      return a.what === "remember"
        ? { ...s, add: "", busy: false, error: null }
        : a.what === "confirm"
          ? { ...s, busy: false, error: null }
          : { ...s, ask: null, busy: false, error: null };
    case "failed":
      return { ...s, busy: false, error: a.message };
  }
}

/** A correction is ready to save when it says something other than what the fact already says. Only its case or spacing
 *  counts as new, since the runtime lets the owner fix those. */
export const correctionReady = (draft: string, original: string): boolean => {
  const words = draft.trim();
  return words !== "" && words !== original;
};

export const rememberReady = (text: string): boolean => text.trim() !== "";

/** What the runtime's own refusals say to the owner, by the package's reason. Any other refusal (the connected runtime's
 *  "Not yet", a request that failed) is shown in the runtime's own words. */
const REFUSALS = new Map<string, Key>([
  ["already_known", "memory.refuse.already_known"],
  ["invalid_text", "memory.refuse.invalid_text"],
  ["full", "memory.refuse.full"],
  ["not_found", "memory.refuse.not_found"],
]);

export function refusalText(code: string, message: string): string {
  const key = REFUSALS.get(code);
  return key ? t(key, { max: code === "full" ? MAX_FACTS : MAX_TEXT }) : message;
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Asks the runtime to act and says how the page moves on: what it answered, or the words to show when it would not, with
 *  the runtime's code so a caller can tell a fact that is gone from one that was refused. */
export async function memoryStep<T>(call: () => Promise<T>): Promise<MemoryResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    const why = unavailable(e);
    return why.kind === "unavailable" ? { ok: false, code: why.code, message: refusalText(why.code, why.message) } : { ok: false, code: "internal", message: "" };
  }
}

/** The store's own actions that reach the runtime, which is all the page's steps need of it. */
export interface MemoryCalls {
  memoryRemember(text: string): Promise<{ fact: MemoryFact }>;
  memoryConfirm(fact: string): Promise<{ fact: MemoryFact }>;
  memoryCorrect(fact: string, text: string): Promise<{ fact: MemoryFact }>;
  memoryForget(fact: string): Promise<{ fact: string }>;
}

/** What the owner did: said something to remember, said "It's true", corrected a fact's words, or forgot a fact. */
export type MemoryDo =
  | { what: "remember"; text: string }
  | { what: "confirm"; fact: string }
  | { what: "correct"; fact: string; text: string }
  | { what: "forget"; fact: string };

/** Asks the runtime to do it, and says what the list is now and how the page moves on. The list is the runtime's answer put
 *  in its place, never a guess: a fact that was forgotten is gone from it, words and id, and one the runtime refused leaves
 *  the list as it was. A fact the runtime says is gone is dropped too, since the owner is looking at a list that went out of
 *  date. */
export async function memoryDo(calls: MemoryCalls, facts: readonly MemoryFact[], todo: MemoryDo): Promise<{ facts: MemoryFact[]; action: MemoryAction }> {
  const done = await memoryStep(async () => {
    switch (todo.what) {
      case "remember":
        return withFact(facts, (await calls.memoryRemember(todo.text)).fact);
      case "confirm":
        return withFact(facts, (await calls.memoryConfirm(todo.fact)).fact);
      case "correct":
        return withFact(facts, (await calls.memoryCorrect(todo.fact, todo.text)).fact);
      case "forget":
        return withoutFact(facts, (await calls.memoryForget(todo.fact)).fact);
    }
  });
  if (done.ok) return { facts: done.value, action: { type: "done", what: todo.what } };
  const gone = done.code === "not_found" && todo.what !== "remember";
  return { facts: gone ? withoutFact(facts, todo.fact) : [...facts], action: { type: "failed", message: done.message } };
}
