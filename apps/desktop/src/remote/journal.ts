// The Mac's numbered record of recent events, one journal per chat a phone is watching, ported from GoSpark's
// `RemoteEventJournal` (`GoGoCode/Remote/RemoteEventJournal.swift` at `a7537c80`).
//
// Each event of a watched chat is numbered here before it goes to any phone, so every phone reads the same numbers, and a
// phone that asks again with the cursor of the last event it holds is sent just what came after. When the range it names
// is gone, because the journal started over or the events were trimmed off the front, the answer is the whole chat again
// and never a guess. The channel does not say when a stream was cut short (packages/remote-channel/README.md), so these
// cursors are how a phone learns what it missed.
//
// A journal covers a chat only while a phone watches it, and is closed when the last one stops; the next one opens under
// a new id, which no earlier cursor matches, so a gap in watching never reads as continuity. Events are kept as they were
// sent, already projected and masked (project.ts), in memory only, and at most 500 events or 1 MB a chat, as GoSpark's.

export const MAX_EVENTS = 500;
export const MAX_BYTES = 1024 * 1024;

/** Where a phone stands in a chat: which journal, and the number of the last event it holds. */
export interface Cursor {
  readonly journal: string;
  readonly seq: number;
}

export type CatchUp<E> = { readonly kind: "replay"; readonly events: readonly { event: E; cursor: Cursor }[] } | { readonly kind: "snapshot" };

interface Entry<E> {
  readonly seq: number;
  readonly event: E;
  readonly bytes: number;
}

interface ChatJournal<E> {
  readonly id: string;
  head: number;
  entries: Entry<E>[];
  bytes: number;
}

const encoder = new TextEncoder();

/** An event's size as it is sent: its JSON's UTF-8 bytes. */
export function eventBytes(event: unknown): number {
  return encoder.encode(JSON.stringify(event)).length;
}

export class EventJournal<E> {
  readonly #chats = new Map<string, ChatJournal<E>>();
  readonly #newId: () => string;
  readonly #maxEvents: number;
  readonly #maxBytes: number;

  constructor(options: { newId?: () => string; maxEvents?: number; maxBytes?: number } = {}) {
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#maxEvents = options.maxEvents ?? MAX_EVENTS;
    this.#maxBytes = options.maxBytes ?? MAX_BYTES;
  }

  isOpen(chat: string): boolean {
    return this.#chats.has(chat);
  }

  /** Where the chat's journal stands, or null when none is open. */
  cursor(chat: string): Cursor | null {
    const journal = this.#chats.get(chat);
    return journal ? { journal: journal.id, seq: journal.head } : null;
  }

  /** Starts the chat's journal if it has none, and returns where it stands now: the cursor a snapshot sent at this
   *  moment carries. */
  open(chat: string): Cursor {
    let journal = this.#chats.get(chat);
    if (!journal) {
      journal = { id: this.#newId(), head: 0, entries: [], bytes: 0 };
      this.#chats.set(chat, journal);
    }
    return { journal: journal.id, seq: journal.head };
  }

  /** Numbers one event and keeps it for catching up. Null for a chat with no journal open: no phone watches it. */
  record(chat: string, event: E, bytes: number = eventBytes(event)): Cursor | null {
    const journal = this.#chats.get(chat);
    if (!journal) return null;
    journal.head += 1;
    journal.entries.push({ seq: journal.head, event, bytes });
    journal.bytes += bytes;
    let drop = 0;
    while (drop < journal.entries.length && (journal.entries.length - drop > this.#maxEvents || journal.bytes > this.#maxBytes)) {
      journal.bytes -= journal.entries[drop]!.bytes;
      drop += 1;
    }
    if (drop > 0) journal.entries.splice(0, drop);
    return { journal: journal.id, seq: journal.head };
  }

  /** What a phone holding `after` needs to be current: the events since, when the cursor is this journal's and every
   *  one of them is still kept; the whole chat for anything else, no cursor, a cursor ahead and a closed journal
   *  included. */
  catchUp(chat: string, after: Cursor | null): CatchUp<E> {
    const journal = this.#chats.get(chat);
    if (!after || !journal || after.journal !== journal.id || !Number.isSafeInteger(after.seq) || after.seq < 0 || after.seq > journal.head) {
      return { kind: "snapshot" };
    }
    if (after.seq === journal.head) return { kind: "replay", events: [] };
    const first = journal.entries[0];
    if (!first || first.seq > after.seq + 1) return { kind: "snapshot" };
    const start = after.seq + 1 - first.seq;
    return { kind: "replay", events: journal.entries.slice(start).map((e) => ({ event: e.event, cursor: { journal: journal.id, seq: e.seq } })) };
  }

  close(chat: string): void {
    this.#chats.delete(chat);
  }

  /** Ends every journal, when the switch goes off. */
  clear(): void {
    this.#chats.clear();
  }

  /** The chats with a journal open. */
  chats(): string[] {
    return [...this.#chats.keys()];
  }
}
