// What Settings › People asks of a runtime about the people around a shop (docs/people.md; the routes are docs/pilot-api.md,
// "The owner's own routes"): who can use Manut AI for it, an invite for a helper, cancelling one, removing a helper, and the
// cover while the owner is away. Like the memory, routine and Connections ops (memory.ts, routines.ts, connections.ts), the
// shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime that does not answer one
// does not compile.
//
// The rules are the API's, in `@manut/people-rules` (an invite is for one LINE account or one email, works once and lasts 7
// days; cover is one current helper until a date; removal ends every session of theirs at once): a runtime applies them, and
// nothing here or on the page decides who may do what. Only the shop's owner reads or changes the list, and the shop is the
// session's: a runtime answers for the shop the switcher shows, and every change names the shop its list was read for, so a
// change never lands on another shop because the switcher moved meanwhile. Times are seconds since the epoch, as everywhere in
// the protocol.
//
// An invite is a link the owner sends themselves: the API never sends it (LINE and email sending are parked). The link is the
// one thing here that is a credential until it is used or ends, so it is held by the page's own state only, never by the store,
// the offline cache or a log.

/** The one account an invite is bound to: a LINE account id (compared exactly) or an email (compared without case). */
export type PersonIdentity = { kind: "line"; id: string } | { kind: "email"; address: string };

/** A helper of the shop. */
export interface ShopHelper {
  id: string;
  /** the name the owner gave them; "" when the API said none */
  name: string;
  identity: PersonIdentity;
  /** when they joined */
  joinedAt: number;
  /** how many devices have them signed in now */
  devices: number;
}

/** `expired`: never used in its 7 days. An invite that was used is a helper now, and one that was cancelled is gone, so the
 *  runtime lists only these two. */
export type InviteState = "pending" | "expired";

/** An invite that waits, or that ran out. */
export interface ShopInvite {
  id: string;
  /** the name the owner gave them */
  name: string;
  identity: PersonIdentity;
  state: InviteState;
  createdAt: number;
  /** 7 days after it was made */
  expiresAt: number;
  /** The link the owner sends the helper, while the invite waits; null when it ran out, or when the runtime could not read
   *  the link it was given (the invite is there all the same, and can be cancelled). */
  link: string | null;
}

/** One current helper covers messages until a date. Cover adds no power: money and public posts still wait for the owner. */
export interface ShopAway {
  helperId: string;
  /** the covering helper's name; "" when the API said none */
  name: string;
  until: number;
  /** false once `until` has passed, or the helper is gone: the cover is over but not cleared */
  inForce: boolean;
}

/** What the page reads: the shop it was read for, the owner, the helpers in the order they joined, the invites that wait or
 *  ran out, newest first, and the cover. */
export interface ShopPeople {
  shop: string;
  owner: {
    name: string;
    /** how many devices have the owner's account signed in to this shop; null when no account is linked to it */
    devices: number | null;
  };
  helpers: ShopHelper[];
  invites: ShopInvite[];
  away: ShopAway | null;
}

/** What removing a helper did, as the API counts it: it signs them out of every device in the same write that removes them,
 *  and may also have cancelled their invites and ended their cover. */
export interface ShopRemoval {
  helper: string;
  sessionsEnded: number;
  invitesRevoked: number;
  coverEnded: boolean;
}

/** The longest name the shop's record keeps for a helper, in characters (`MAX_NAME` in apps/api/src/people-store.ts). */
export const MAX_HELPER_NAME = 80;

/** A name as the shop's record keeps it: outer spaces off, 1 to 80 characters, no control characters, so a name can never break
 *  a line in the log. Null for anything else (`keptName` in apps/api/src/people-store.ts). */
export function helperNameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  return name.length > 0 && [...name].length <= MAX_HELPER_NAME && !/\p{Cc}/u.test(name) ? name : null;
}

/** The longest value an identity keeps (`MAX_FIELD` in apps/api/src/people-store.ts). */
const MAX_IDENTITY = 256;

/** An identity as it is sent, if the rules accept it (`validIdentity` in @manut/people-rules): exactly a LINE ID that is something
 *  once its outer spaces are off, or an email address with one `@` and no space in it. Anything else, an extra field included,
 *  is null. */
export function identityOk(v: unknown): PersonIdentity | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (o.kind === "line" && keys.length === 2 && typeof o.id === "string") {
    const id = o.id.trim();
    return id.length > 0 && id.length <= MAX_IDENTITY ? { kind: "line", id } : null;
  }
  if (o.kind === "email" && keys.length === 2 && typeof o.address === "string") {
    const address = o.address.trim();
    return address.length <= MAX_IDENTITY && /^[^\s@]+@[^\s@]+$/.test(address) ? { kind: "email", address } : null;
  }
  return null;
}

export interface PeopleOps {
  /** The people of the shop the switcher shows. Refused `owner_only` for a helper there, and `no_shop` for a person in none. */
  "people.list": { params: Record<string, never>; result: ShopPeople };
  /** An invite for `identity` to `shop` (as `people.list` named it), named `name`. The answer holds the link to send. Refused
   *  `invalid_name`, `bad_identity`, `already_invited` (an invite for that account waits), `already_helper`. */
  "people.invite": { params: { shop: string; name: string; identity: PersonIdentity }; result: { invite: ShopInvite } };
  /** Cancels one invite of `shop` that waits. Refused `unknown_invite`, `not_pending`. */
  "people.cancelInvite": { params: { shop: string; invite: string }; result: { invite: string } };
  /** Removes one helper of `shop`, and signs them out on every device. Refused `not_a_helper`. */
  "people.remove": { params: { shop: string; helper: string }; result: ShopRemoval };
  /** Sets the cover: `helper` covers messages until `until` (seconds), which must be in the future. Refused `bad_date`,
   *  `not_a_helper`. */
  "people.setAway": { params: { shop: string; helper: string; until: number }; result: { away: ShopAway } };
  /** Ends the cover, whoever it was for. */
  "people.clearAway": { params: { shop: string }; result: { away: null } };
}
