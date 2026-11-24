// What the Customize page's Connections tab asks of a runtime about the shop's vault and outposts (docs/browser-control.md,
// "The owner's Connections"): the site sign-ins the team may use, a new password for one, and the shop's outposts, each
// renamed or removed by the owner. Like the memory and routine ops (memory.ts, routines.ts), the shapes live here, beside the
// runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime that does not answer one does not compile.
//
// The rules are the API's (apps/api/src/browser-control.ts, `ownerVaultRoute`): only the shop's owner sees or changes these,
// and the shop is the session's. A runtime answers for the shop the switcher shows, and every change names the shop its row
// was read for, so a change never lands on another shop because the switcher moved meanwhile.
//
// A password crosses the protocol once, in `connections.password`, and no answer ever holds one: a sign-in says only when
// its password was set. A runtime sends it on to the vault and keeps it nowhere. Times are seconds since the epoch, as
// everywhere in the protocol.

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

export interface ConnectionOps {
  /** The sign-ins and outposts of the shop the switcher shows. Refused `owner_only` for a helper there. */
  "connections.list": { params: Record<string, never>; result: ShopConnections };
  /** A new password for one sign-in of `shop` (as `connections.list` named it), which also mends a broken one. Refused
   *  `invalid_password` for one the vault does not take, `sign_in_not_found` for one the shop no longer has. */
  "connections.password": { params: { shop: string | null; signIn: string; password: string }; result: { signIn: VaultSignIn } };
  /** A new name for one outpost of `shop`. Only the name changes. Refused `invalid_name`, `outpost_not_found`. */
  "connections.rename": { params: { shop: string | null; outpost: string; name: string }; result: { outpost: ShopOutpost } };
  /** Removes one outpost of `shop`: its work stops at once, and it must be registered again to work. */
  "connections.remove": { params: { shop: string | null; outpost: string }; result: { outpost: string } };
}
