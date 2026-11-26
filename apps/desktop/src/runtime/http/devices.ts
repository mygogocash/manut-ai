// A helper's new device, as the owner's app finds it out and says so once (docs/people.md, "A helper's new device";
// docs/pilot-api.md, "The owner's own routes"). The API lists one sign-in for each helper session opened at a shop, whether
// or not that device is still signed in (`GET /v1/people/devices`, for the shop's owner only). This module reads that list
// and turns it into the sign-ins the app has not said yet.
//
// Rules this module keeps:
// - The route is read with the shop's own session, and the host asks only for a shop the person owns: the API answers a
//   helper's session 403, and a helper is never told of the other helpers' devices.
// - What the API answers is read field by field. An entry this build cannot read is left out, and an answer that is not this
//   route's reads as nothing, so nothing is said and nothing is remembered on a guess.
// - What the app has said is kept per shop on this computer, as the ids of the sign-ins it has seen listed (`DeviceWatch`).
//   The first time it looks at a shop it says nothing: what is already there is where it starts, so a first run does not
//   ring for every helper. After that each new id is said once, oldest first. What it has seen goes with the shop when the
//   person leaves it or is no longer its owner (`keepOnly`).
// - Nothing here raises. A storage that refuses is a record that was not kept: the run still says each sign-in once.
import type { ShopRow } from "../../lib/protocol";
import type { ShopSessions } from "./shops";
import { isObj } from "../../lib/guards";

/** What the route is read from, with the shop's own session. */
export const DEVICES_PATH = "/v1/people/devices";

/** One sign-in a helper made at a shop the person owns, as the API lists it. */
export interface HelperDevice {
  /** the session's own id: stable, and what the app keeps to know it has said so. It opens nothing. */
  id: string;
  helperId: string;
  /** the name the owner gave the helper; "" when the API said none */
  name: string;
  /** ms, when the session was opened */
  openedAt: number;
}

/** The API never lists more than this (`MAX_SIGN_INS` in apps/api/src/people-store.ts): an answer with more is read as its
 *  newest, so a misbehaving API cannot make the app ring without end. */
const MAX_LISTED = 50;
/** The most ids kept for one shop: room for a list that shifts under the app, and a bound on what is written. */
const KEEP_IDS = 200;

type Obj = Record<string, unknown>;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

/** The sign-ins of a `GET /v1/people/devices` answer, oldest first, once each; null when the answer is not this route's. */
export function decodeDevices(json: unknown): HelperDevice[] | null {
  if (!isObj(json) || !Array.isArray(json.devices)) return null;
  const seen = new Set<string>();
  const read: HelperDevice[] = [];
  for (const v of json.devices) {
    if (!isObj(v) || !isId(v.id) || !isId(v.helperId) || seen.has(v.id)) continue;
    const openedAt = typeof v.openedAt === "string" ? Date.parse(v.openedAt) : Number.NaN;
    if (Number.isNaN(openedAt)) continue;
    seen.add(v.id);
    read.push({ id: v.id, helperId: v.helperId, name: typeof v.name === "string" ? v.name : "", openedAt });
  }
  return read.sort((a, b) => a.openedAt - b.openedAt).slice(-MAX_LISTED);
}

/** What a shop's devices say now, read with that shop's own session; null for any other answer (a refusal, a link that is
 *  down, a shop the person left, one this build cannot read), so a read that did not work never says or forgets anything. */
export async function readDevices(shops: Pick<ShopSessions, "read">, shop: Pick<ShopRow, "id">): Promise<HelperDevice[] | null> {
  try {
    const answer = await shops.read(shop.id, DEVICES_PATH);
    return answer.kind === "ok" ? decodeDevices(answer.json) : null;
  } catch {
    return null;
  }
}

// ---- what has been said ---------------------------------------------------------------------------------------------------

/** Where what was seen is kept between runs: one text, read and written whole. */
export interface SeenStore {
  read(): string | null;
  write(text: string): void;
}

/** The one key it is kept under, in this computer's own storage. */
export const SEEN_KEY = "manut.devices.seen";

/** This computer's own storage (the webview's, or a browser's) as the store of what was seen. `null` is no storage at all.
 *  Never throws: a disabled or full storage reads as nothing and drops a write. */
export function browserSeen(storage?: Pick<Storage, "getItem" | "setItem"> | null): SeenStore {
  const found = () => (storage !== undefined ? storage : typeof localStorage === "undefined" ? null : localStorage);
  return {
    read() {
      try {
        return found()?.getItem(SEEN_KEY) ?? null;
      } catch {
        return null;
      }
    },
    write(text) {
      try {
        found()?.setItem(SEEN_KEY, text);
      } catch {
        /* no storage: what was said holds for this run at most */
      }
    },
  };
}

/** The kept text as a record by shop, or nothing at all when any of it is damaged or from another version: half a record
 *  would make one shop ring for every helper and another stay silent. */
function parseSeen(text: string | null): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  if (!text) return seen;
  try {
    const file: unknown = JSON.parse(text);
    if (!isObj(file) || file.v !== 1 || !isObj(file.shops)) return new Map();
    for (const [shop, list] of Object.entries(file.shops)) {
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return new Map();
      seen.set(shop, (list as string[]).slice(-KEEP_IDS));
    }
    return seen;
  } catch {
    return new Map();
  }
}

/** What the app has already said of each shop's devices, kept on this computer, so that a sign-in is said once: not twice in
 *  a run, and not again after a restart. */
export class DeviceWatch {
  /** The record, read on first use and then kept here and written through, so a storage that refuses still leaves a run
   *  that says each sign-in once. */
  private seen: Map<string, string[]> | null = null;

  constructor(private readonly store: SeenStore = browserSeen()) {}

  /** The sign-ins of `shop` in `listed` that have not been said, oldest first (as `listed` is), counted as said from now on.
   *  The first look at a shop says none: those that are listed then are only remembered. Ids that have left the list stay
   *  remembered (up to 200), so a list that shifts for a moment does not say one twice. */
  fresh(shop: string, listed: readonly HelperDevice[]): HelperDevice[] {
    const seen = this.load();
    const had = seen.get(shop);
    const known = new Set(had ?? []);
    const fresh: HelperDevice[] = [];
    for (const device of listed) {
      if (known.has(device.id)) continue;
      known.add(device.id);
      fresh.push(device);
    }
    if (!had || fresh.length) {
      seen.set(shop, [...(had ?? []), ...fresh.map((d) => d.id)].slice(-KEEP_IDS));
      this.save();
    }
    return had ? fresh : [];
  }

  /** Forgets every shop but these: a shop that left the person's list, or one they no longer own, takes with it what was seen
   *  of it, and is a first look again if they own it again. */
  keepOnly(shops: readonly string[]): void {
    const seen = this.load();
    let dropped = false;
    for (const shop of [...seen.keys()]) {
      if (shops.includes(shop)) continue;
      seen.delete(shop);
      dropped = true;
    }
    if (dropped) this.save();
  }

  private load(): Map<string, string[]> {
    if (this.seen) return this.seen;
    let text: string | null = null;
    try {
      text = this.store.read();
    } catch {
      /* nothing kept */
    }
    return (this.seen = parseSeen(text));
  }

  private save(): void {
    try {
      this.store.write(JSON.stringify({ v: 1, shops: Object.fromEntries(this.seen ?? []) }));
    } catch {
      /* not kept: this run still says each sign-in once */
    }
  }
}
