// What the Customize page asks of a runtime about what the team knows: the facts, where each one came from, and the owner's
// say over them. These are the ops behind the page's memory half (src/pages/CustomizePage.tsx, memory.ts). As with Mission
// Control's (mission.ts), the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a
// runtime that does not answer one does not compile (both hosts type their handler tables against every op).
//
// The rules are `@manut/shop-memory`'s: what makes a fact wait, what Forget keeps, how two texts compare. A runtime applies
// them by calling that package, never with a copy of its own, and a refusal rejects with the package's reason as its code
// (`already_known`, `full`, ...) so a screen can say it in its own words. Times are seconds since the epoch, as everywhere in
// the protocol, although the package counts milliseconds: each runtime converts at its own edge.
//
// Forget is the one op whose answer holds none of the fact: it says only which fact is gone. The runtime keeps nothing but a
// fingerprint of the words, so that the team does not learn them again, and no op can ask for them back.

/** Where a fact came from, which the page says as "From your price list, 3 November". It is the package's `FactSource` with
 *  one change: a document's `date` is in seconds, like every other time here. */
export type MemorySource =
  | { kind: "owner" }
  | { kind: "document"; name: string; date: number }
  | { kind: "edits"; count: number }
  | { kind: "orders"; days: number }
  | { kind: "connection"; name: string; detail: string }
  | { kind: "customer"; chat: string };

/** A fact is `waiting` until the owner says it is true: something a customer said, which the team may not use. */
export type MemoryStatus = "confirmed" | "waiting";

export interface MemoryFact {
  id: string;
  text: string;
  status: MemoryStatus;
  source: MemorySource;
  /** when it was last changed */
  at: number;
  /** when the owner corrected its words; null while they are as first learned */
  correctedAt: number | null;
}

export interface MemoryOps {
  /** Every fact the owner can see, the waiting ones included, oldest first. The words of a forgotten fact are never in it. */
  "memory.list": { params: Record<string, never>; result: { facts: MemoryFact[] } };
  /** The owner's own fact, confirmed at once. Words the team already holds are refused (`already_known`), except a waiting
   *  fact, which this confirms instead of adding it twice. */
  "memory.remember": { params: { text: string }; result: { fact: MemoryFact } };
  /** "It's true": a waiting fact becomes one the team may use. Confirming a confirmed fact changes nothing. */
  "memory.confirm": { params: { fact: string }; result: { fact: MemoryFact } };
  /** The owner's new words for a fact: confirmed, and marked as corrected. The fact keeps its source. */
  "memory.correct": { params: { fact: string; text: string }; result: { fact: MemoryFact } };
  /** Removes the fact and its words. The answer names the fact and holds none of it. */
  "memory.forget": { params: { fact: string }; result: { fact: string } };
}
