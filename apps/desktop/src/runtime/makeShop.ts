// What making a shop of one's own asks of a runtime (docs/several-shops.md, "A shop its owner makes"; the route is
// docs/pilot-api.md, "Making a shop of your own"): a signed-in person with no shop makes one, names it and themselves,
// picks which kind of shop it is (one of the three shop templates, or none), and is its owner from the first write. Like
// the people ops (people.ts), the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a
// runtime that does not answer the op does not compile.
//
// The rules are the API's: the runtime only refuses here what the API would refuse anyway (a name it would not keep, a kind
// it does not have), so nothing is sent that can only come back refused. Whether sign-ups are open, the limit of shops one
// account may make and everything else are the API's to say, and the page says them in plain words.
import type { ShopRow } from "../lib/protocol";
import { helperNameOf, MAX_HELPER_NAME } from "./people";

/** The three shop templates (`@manut/shop-templates`), by the ids the API takes. The page names each in the person's
 *  language; the API applies the template's team, routines (each paused) and first-week questions. */
export const SHOP_TEMPLATE_IDS = ["handmade", "fashion", "food"] as const;
export type ShopTemplateId = (typeof SHOP_TEMPLATE_IDS)[number];

export const isShopTemplateId = (v: unknown): v is ShopTemplateId => typeof v === "string" && (SHOP_TEMPLATE_IDS as readonly string[]).includes(v);

/** The longest name a shop or its owner may have, in characters: the API keeps both by a helper's name's rule. */
export const MAX_SHOP_NAME = MAX_HELPER_NAME;

/** A shop's name, or its owner's, as the API keeps it (`keptName` in apps/api/src/people-store.ts): outer spaces off, 1 to 80
 *  characters, no control characters. Null for anything else. */
export const shopNameOf = (value: unknown): string | null => helperNameOf(value);

/** How many shops one account may have made at a time (`SHOPS_MADE_LIMIT` in apps/api/src/shops-store.ts). The API says it
 *  in its refusal; Practice keeps the same number so it refuses as the API does. */
export const MADE_SHOPS_LIMIT = 3;

/** Why a runtime did not make the shop, as the op's refusal code:
 *  - `sign_ups_closed`: the API has not opened sign-ups (the owner's call), so nobody can make a shop of their own yet;
 *  - `invalid_name`, `invalid_owner_name`: a name the API would not keep;
 *  - `unknown_template`: a kind of shop the API does not have;
 *  - `too_many_shops`: the account has made as many shops as it may;
 *  - `rate_limited`: too many tries from this address in a minute;
 *  - `signed_out`, `offline`, `unavailable`: nobody is signed in or the sign-in ended, the API could not be reached, or it
 *    could not make the shop (nothing is listed, and trying again makes a whole new one). */
export type MakeShopRefusal =
  | "sign_ups_closed"
  | "invalid_name"
  | "invalid_owner_name"
  | "unknown_template"
  | "too_many_shops"
  | "rate_limited"
  | "signed_out"
  | "offline"
  | "unavailable";

export interface MakeShopOps {
  /** Makes a shop owned by the signed-in person: `name` is the shop's, `ownerName` theirs, `template` its kind or null for
   *  none. The answer is the shop as the switcher lists it; the runtime holds its owner session and shows it on every page
   *  from now on. Refused with a `MakeShopRefusal`. */
  "shops.make": { params: { name: string; ownerName: string; template: ShopTemplateId | null }; result: { shop: ShopRow } };
}
