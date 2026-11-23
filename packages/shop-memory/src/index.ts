// What Buddy's team knows about one shop. Pure functions over a plain state object; storing it is not this
// package's job. No operation throws: a refusal is a result value.

export const MAX_FACTS = 200;
export const MAX_TEXT = 280;

/** Where a fact came from, shown to the owner as "Where it came from". */
export type FactSource =
  | { kind: "owner" }
  | { kind: "document"; name: string; date: number }
  | { kind: "edits"; count: number }
  | { kind: "orders"; days: number }
  | { kind: "connection"; name: string; detail: string }
  | { kind: "customer"; chat: string };

export type FactStatus = "confirmed" | "waiting";

export interface Fact {
  id: string;
  text: string;
  status: FactStatus;
  createdAt: number;
  updatedAt: number;
  correctedAt?: number;
  source: FactSource;
}

export interface MemoryState {
  facts: Fact[];
  /** FNV-1a fingerprints of forgotten texts. The text itself is gone. */
  forgotten: string[];
  /** Counter for the next fact id, so ids are never reused after a Forget. */
  nextId: number;
}

export type Refusal = "invalid_text" | "invalid_source" | "already_known" | "forgotten" | "not_found" | "full";

export type Result =
  | { ok: true; state: MemoryState; fact: Fact }
  | { ok: false; reason: Refusal; state: MemoryState };

export type ForgetResult =
  | { ok: true; state: MemoryState }
  | { ok: false; reason: "not_found"; state: MemoryState };

export function emptyState(): MemoryState {
  return { facts: [], forgotten: [], nextId: 1 };
}

/** The form texts are compared in: NFC, trimmed, spaces collapsed, lower case. Thai has no case, so it only
 *  gets the first three steps. */
export function compareForm(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** FNV-1a 64-bit over the UTF-8 bytes of the compared form, as 16 hex digits. */
export function fingerprint(text: string): string {
  const MASK = 0xffffffffffffffffn;
  const PRIME = 0x100000001b3n;
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(compareForm(text))) {
    h ^= BigInt(byte);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

const OWNER: FactSource = { kind: "owner" };

function cleanText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  const n = [...t].length;
  return n >= 1 && n <= MAX_TEXT ? t : null;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

function isName(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

function validSource(s: unknown): s is FactSource {
  if (typeof s !== "object" || s === null) return false;
  const v = s as Record<string, unknown>;
  switch (v.kind) {
    case "owner":
      return true;
    case "document":
      return isName(v.name) && typeof v.date === "number" && Number.isFinite(v.date);
    case "edits":
      return isCount(v.count);
    case "orders":
      return isCount(v.days);
    case "connection":
      return isName(v.name) && typeof v.detail === "string";
    case "customer":
      return isName(v.chat);
    default:
      return false;
  }
}

function refuse(state: MemoryState, reason: Refusal): Result {
  return { ok: false, reason, state };
}

function replace(state: MemoryState, fact: Fact, forgotten = state.forgotten): Result {
  const facts = state.facts.map((f) => (f.id === fact.id ? fact : f));
  return { ok: true, state: { ...state, facts, forgotten }, fact };
}

function add(state: MemoryState, text: string, status: FactStatus, source: FactSource, now: number, forgotten: string[]): Result {
  if (state.facts.length >= MAX_FACTS) return refuse(state, "full");
  const fact: Fact = { id: `f${state.nextId}`, text, status, createdAt: now, updatedAt: now, source };
  return { ok: true, state: { facts: [...state.facts, fact], forgotten, nextId: state.nextId + 1 }, fact };
}

function findByText(state: MemoryState, form: string): Fact | undefined {
  return state.facts.find((f) => compareForm(f.text) === form);
}

function confirmFact(state: MemoryState, fact: Fact, now: number, forgotten = state.forgotten): Result {
  return replace(state, { ...fact, status: "confirmed", updatedAt: now }, forgotten);
}

/** The owner's own fact, confirmed at once. It also lifts an earlier Forget of the same text. */
export function remember(state: MemoryState, text: string, now: number): Result {
  const t = cleanText(text);
  if (t === null) return refuse(state, "invalid_text");
  const fp = fingerprint(t);
  const forgotten = state.forgotten.filter((x) => x !== fp);
  const existing = findByText(state, compareForm(t));
  if (existing) {
    return existing.status === "waiting" ? confirmFact(state, existing, now, forgotten) : refuse(state, "already_known");
  }
  return add(state, t, "confirmed", OWNER, now, forgotten);
}

/** The team learned something. Only a customer's words wait for the owner: the rest come from the owner's data. */
export function propose(state: MemoryState, text: string, source: FactSource, now: number): Result {
  const t = cleanText(text);
  if (t === null) return refuse(state, "invalid_text");
  if (!validSource(source)) return refuse(state, "invalid_source");
  if (state.forgotten.includes(fingerprint(t))) return refuse(state, "forgotten");
  const fromCustomer = source.kind === "customer";
  const existing = findByText(state, compareForm(t));
  if (existing) {
    // A waiting fact seen again in the owner's own data is as good as confirmed; a customer repeating it is not.
    if (existing.status === "waiting" && !fromCustomer) return confirmFact(state, existing, now);
    return refuse(state, "already_known");
  }
  return add(state, t, fromCustomer ? "waiting" : "confirmed", source, now, state.forgotten);
}

/** "It's true". Confirming a confirmed fact changes nothing. */
export function confirm(state: MemoryState, id: string, now: number): Result {
  const fact = state.facts.find((f) => f.id === id);
  if (!fact) return refuse(state, "not_found");
  return fact.status === "confirmed" ? { ok: true, state, fact } : confirmFact(state, fact, now);
}

/** The owner's correction: new text, confirmed, marked as corrected. The fact keeps its source. */
export function correct(state: MemoryState, id: string, text: string, now: number): Result {
  const fact = state.facts.find((f) => f.id === id);
  if (!fact) return refuse(state, "not_found");
  const t = cleanText(text);
  if (t === null) return refuse(state, "invalid_text");
  const form = compareForm(t);
  const other = findByText(state, form);
  if (other && other.id !== id) return refuse(state, "already_known");
  const fp = fingerprint(t);
  return replace(
    state,
    { ...fact, text: t, status: "confirmed", updatedAt: now, correctedAt: now },
    state.forgotten.filter((x) => x !== fp),
  );
}

/** Removes the text and keeps only its fingerprint, so `propose` of the same text answers `forgotten`. */
export function forget(state: MemoryState, id: string): ForgetResult {
  const fact = state.facts.find((f) => f.id === id);
  if (!fact) return { ok: false, reason: "not_found", state };
  const fp = fingerprint(fact.text);
  const forgotten = state.forgotten.includes(fp) ? state.forgotten : [...state.forgotten, fp];
  return { ok: true, state: { ...state, facts: state.facts.filter((f) => f.id !== id), forgotten } };
}

/** What the team may use. A waiting fact is never used. */
export function usable(state: MemoryState): Fact[] {
  return state.facts.filter((f) => f.status === "confirmed");
}

/** Everything the owner can take away, waiting facts included. Fingerprints are only counted. */
export function exportFacts(state: MemoryState): { facts: Fact[]; forgottenCount: number } {
  return { facts: state.facts.map((f) => ({ ...f })), forgottenCount: state.forgotten.length };
}
