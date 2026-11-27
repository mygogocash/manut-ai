// "Your Mac needs you" (item 78d, docs/remote-access.md, "Push"): what the Mac keeps and decides so a paired phone that
// is not connected hears, with no content, that an ask opened.
//
// - The push addresses. A phone that turns on "Tell me when my Mac needs me" sends the Mac its push address inside the
//   channel (serve.ts, `notify`); the Mac keeps it here, by device id, and hands it to the relay (`webpush`, link.ts),
//   again at every `ready`, so a relay that forgot the Mac learns it back. It is kept in this computer's local storage,
//   as the switch is (state.ts), and not in the keychain: it is no secret, since a push to it needs the relay's own
//   signed key (VAPID), and it says only where that phone's browser receives pushes. Unpair forgets it.
// - When to push (`PushPlan`). When an ask opens and no paired phone has a session open, the Mac sends the relay `push`
//   naming every paired phone with an address, at most once for each ask and never twice within `PUSH_GAP_MS`. An ask
//   that opens inside that gap is not pushed for: the phone was told less than two minutes ago and that notification
//   still stands. Asks already open when the switch turns on are never pushed for, since the person was just at the Mac.
import { pushAddressOk } from "@manut/remote-channel";

/** The least time between two pushes from this Mac. The relay allows one Mac 30 an hour (`RelayObject.pushesPerHour`), so
 *  this Mac never reaches that. */
export const PUSH_GAP_MS = 2 * 60_000;

export const PUSH_KEY = "manut.remote.push";

/** Where the push addresses are kept: device id to address. */
export interface PushStore {
  read(): Record<string, string>;
  write(book: Record<string, string>): void;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/** Reads only what is a device id with a push address the relay would take; anything else is dropped. */
function clean(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, address] of Object.entries(value as Record<string, unknown>)) {
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(id) && pushAddressOk(address)) out[id] = address;
  }
  return out;
}

/** This computer's local storage, under `manut.remote.push`. A read that fails is an empty book, and a write that fails
 *  keeps nothing: the phone sends its address again at its next session. */
export function localPushStore(storage: Storage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): PushStore {
  return {
    read: () => {
      try {
        const raw = storage?.getItem(PUSH_KEY);
        return raw ? clean(JSON.parse(raw)) : {};
      } catch {
        return {};
      }
    },
    write: (book) => {
      try {
        storage?.setItem(PUSH_KEY, JSON.stringify(book));
      } catch {
        // Not kept.
      }
    },
  };
}

/** In memory, for tests and for where there is no local storage. */
export function memoryPushStore(start: Record<string, string> = {}): PushStore & { readonly book: Record<string, string> } {
  let book = clean(start);
  return {
    get book() {
      return book;
    },
    read: () => ({ ...book }),
    write: (next) => {
      book = clean(next);
    },
  };
}

/** Which asks the Mac has pushed for, or let go by, and when it last pushed. */
export class PushPlan {
  #seen = new Set<string>();
  #last = Number.NEGATIVE_INFINITY;

  /** The asks open now are taken as already told: the switch just turned on, with the person at the Mac. */
  seed(open: Iterable<string>): void {
    this.#seen = new Set(open);
  }

  /** The asks open now, and whether a push could reach anyone (no phone connected, one with an address). True when a
   *  push should go now: an ask opened that was not seen before, and the last push was at least `PUSH_GAP_MS` ago. Every
   *  ask open now counts as seen afterwards, pushed for or not, and asks no longer open are let go. */
  consider(open: Iterable<string>, now: number, canPush: boolean): boolean {
    const asks = new Set(open);
    const fresh = [...asks].some((ask) => !this.#seen.has(ask));
    this.#seen = asks;
    if (!fresh || !canPush || now - this.#last < PUSH_GAP_MS) return false;
    this.#last = now;
    return true;
  }
}
