// What the Customize page's Connections tab asks of a runtime about the shop's vault and outposts (docs/browser-control.md,
// "The owner's Connections"): the site sign-ins the team may use, a new one added, a new password for one, who may use one,
// and the shop's outposts, each renamed or removed by the owner. Like the memory and routine ops (memory.ts, routines.ts),
// the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime that does not answer
// one does not compile.
//
// The rules are the API's (apps/api/src/browser-control.ts, `ownerVaultRoute`; apps/api/src/sign-in-vault.ts for what a
// sign-in may hold): only the shop's owner sees or changes these, and the shop is the session's. A runtime answers for the
// shop the switcher shows, and every change names the shop its row was read for, so a change never lands on another shop
// because the switcher moved meanwhile. The vault's rules for a new sign-in are said once more below, so a runtime refuses
// with nothing sent what the vault would refuse, and Practice keeps the same rules.
//
// A password crosses the protocol once, in `connections.add` or `connections.password`, and no answer ever holds one: a
// sign-in says only when its password was set. A runtime sends it on to the vault and keeps it nowhere. Times are seconds
// since the epoch, as everywhere in the protocol.
import { DEFAULT_ROSTER } from "@manut/member-grants";

/** A site sign-in in the shop's vault, as the Connections tab shows it. Never its password, and not its account's name or
 *  its sites' addresses, which the tab does not show. */
export interface VaultSignIn {
  id: string;
  /** the name people use: "Shopee Seller Centre" */
  site: string;
  /** who may use it, by member id ("nam", "ton"), in the order the vault keeps them */
  members: string[];
  /** `broken`: a member reported that the site refused the saved password, and nobody uses it until the owner types a new one */
  state: "working" | "broken";
  passwordSetAt: number;
  brokenAt: number | null;
  brokenBy: string | null;
  lastUsedAt: number | null;
  lastUsedBy: string | null;
  createdAt: number;
}

/** One of the shop's outposts, as the API lists it: a Mac with the app, or a cloud outpost. This Mac's own row comes from
 *  the shell instead (src/runtime/http/outpost.ts), which knows whether it runs here; the shell does not say which of these
 *  is this Mac. */
export interface ShopOutpost {
  id: string;
  name: string;
  kind: "this_mac" | "cloud";
  /** online while its last heartbeat is under 90 seconds old */
  online: boolean;
  lastSeenAt: number | null;
  createdAt: number;
}

/** What the tab reads: the shop it was read for (null for the person's own signed-in tenant, when they are in no shops),
 *  and its sign-ins and outposts, oldest first. */
export interface ShopConnections {
  shop: string | null;
  signIns: VaultSignIn[];
  outposts: ShopOutpost[];
}

/** The longest password the vault takes, as the API counts it (`passwordOf` in apps/api/src/sign-in-vault.ts). */
export const MAX_PASSWORD = 1024;
/** The longest outpost name the vault takes, in letters (`outpostNameOf` there). */
export const MAX_OUTPOST_NAME = 80;
/** The longest site name the vault takes, in letters (`siteOf` there). */
export const MAX_SITE = 80;
/** How many addresses one sign-in may have, and how long each may be written (`originsOf` there). */
export const MAX_ORIGINS = 5;
export const MAX_ORIGIN_LENGTH = 256;
/** The longest account name the vault takes, in characters (`usernameOf` there). */
export const MAX_USERNAME = 256;
/** How many sign-ins one shop's vault keeps (`MAX_SIGN_INS` there). */
export const MAX_SIGN_INS = 50;

/** The members a sign-in may name, in the order the team is listed: those whose jobs run through a connection in
 *  `@manut/member-grants`' roster (Nam, Pim, Ton and Kit). Buddy routes work and never signs in to a site. The vault reads
 *  the same roster the same way (`SIGN_IN_MEMBERS` in apps/api/src/sign-in-vault.ts). */
export const SIGN_IN_MEMBERS: readonly string[] = DEFAULT_ROSTER.filter((m) => m.capabilities.some((c) => c.needsConnection)).map((m) => m.id);

/** Characters that cannot be typed into a form field, and are never part of a name, an account or an address. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A site's name as the vault keeps it, trimmed: 1 to 80 letters, Thai counted the same as English, no control characters. */
export function siteOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const site = v.trim();
  return site !== "" && [...site].length <= MAX_SITE && !CONTROL.test(site) ? site : null;
}

/** Whether `v` is written exactly as a browser writes an https origin: no path, no account, no default port, lower case.
 *  So what the vault keeps is what a page's origin is compared with. */
export function isOrigin(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_ORIGIN_LENGTH) return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.origin === v;
  } catch {
    return false;
  }
}

/** One to five distinct https origins, or null. */
export function originsOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_ORIGINS || !v.every(isOrigin)) return null;
  return new Set(v).size === v.length ? [...v] : null;
}

/** The account's name on the site, kept exactly as given, since the outpost types it as it is: not blank, at most 256
 *  characters, no control characters. */
export const usernameOk = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_USERNAME && !CONTROL.test(v);

/** A password is any text of 1 to 1,024 characters, typed exactly as the owner gave it. */
export const passwordOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_PASSWORD;

/** One or more distinct members from `SIGN_IN_MEMBERS`, in the order given, or null. */
export function membersOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > SIGN_IN_MEMBERS.length) return null;
  if (!v.every((m) => typeof m === "string" && SIGN_IN_MEMBERS.includes(m))) return null;
  return new Set(v).size === v.length ? [...(v as string[])] : null;
}

/** What a new sign-in is made of, as the owner gave it. */
export interface NewSignIn {
  site: string;
  /** https origins, as `isOrigin` takes them */
  origins: string[];
  username: string;
  password: string;
  members: string[];
}

/** The vault's first refusal of a new sign-in, field by field in the order the vault checks them, or null when it would
 *  take it. The codes are the API's. */
export function newSignInRefusal(p: Partial<Record<keyof NewSignIn, unknown>>): string | null {
  if (siteOf(p.site) === null) return "invalid_site";
  if (originsOf(p.origins) === null) return "invalid_origins";
  if (!usernameOk(p.username)) return "invalid_username";
  if (!passwordOk(p.password)) return "invalid_password";
  if (membersOf(p.members) === null) return "invalid_members";
  return null;
}

export interface ConnectionOps {
  /** The sign-ins and outposts of the shop the switcher shows. Refused `owner_only` for a helper there. */
  "connections.list": { params: Record<string, never>; result: ShopConnections };
  /** Adds a sign-in to the vault of `shop` (as `connections.list` named it): the site's name, its https origins, the
   *  account's name on it, its password and who may use it. Refused `invalid_site`, `invalid_origins`, `invalid_username`,
   *  `invalid_password` or `invalid_members` for what the vault would not take, `too_many_sign_ins` past 50, and
   *  `not_saved` when the send found the session ended, with nothing sent again. */
  "connections.add": { params: { shop: string | null } & NewSignIn; result: { signIn: VaultSignIn } };
  /** A new password for one sign-in of `shop` (as `connections.list` named it), which also mends a broken one. Refused
   *  `invalid_password` for one the vault does not take, `sign_in_not_found` for one the shop no longer has. */
  "connections.password": { params: { shop: string | null; signIn: string; password: string }; result: { signIn: VaultSignIn } };
  /** Who may use one sign-in of `shop` from now on. Nothing else about it changes. Refused `invalid_members`,
   *  `sign_in_not_found`. */
  "connections.members": { params: { shop: string | null; signIn: string; members: string[] }; result: { signIn: VaultSignIn } };
  /** A new name for one outpost of `shop`. Only the name changes. Refused `invalid_name`, `outpost_not_found`. */
  "connections.rename": { params: { shop: string | null; outpost: string; name: string }; result: { outpost: ShopOutpost } };
  /** Removes one outpost of `shop`: its work stops at once, and it must be registered again to work. */
  "connections.remove": { params: { shop: string | null; outpost: string }; result: { outpost: string } };
}
