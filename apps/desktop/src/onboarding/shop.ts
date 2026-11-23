// The person and their shop, as the first-run setup takes them (Onboarding.tsx): their name, the shop's name, what it
// sells, where it sells and the one channel that matters most. The store keeps one copy on this computer under
// `manut.shop`, the way it keeps the theme and the look, and the account row at the bottom of the menu names the person
// and the shop from it ("Fon, Baan Mali" in the design canvas's sample world). Nothing here reaches the runtime yet: the
// demo runtime has nowhere to send it, and the real runtime adapter comes later in Phase 3.
//
// These functions are pure, so the rules can be tested without a page or a store.
import { t } from "../i18n";

/** Where the profile is saved on this computer. */
export const SHOP_KEY = "manut.shop";

/** The places the design canvas's setup offers (Onboarding.dc.html), in its order. */
export const CHANNELS = ["line", "shopee", "lazada", "facebook", "instagram"] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (v: unknown): v is Channel => (CHANNELS as readonly unknown[]).includes(v);

export interface ShopProfile {
  /** What the person wants to be called; "" when they did not say. */
  person: string;
  /** The shop's name as its customers know it; "" until it is given. */
  shop: string;
  /** What the shop sells, in one line; "" when not given. */
  sells: string;
  /** Where the shop sells, in the canvas's order. */
  places: Channel[];
  /** The channel that matters most, always one of `places`; null until it is picked. */
  main: Channel | null;
}

export const EMPTY_SHOP: ShopProfile = { person: "", shop: "", sells: "", places: [], main: null };

/** The most each field keeps, in characters. A name or a line of what the shop sells fits well inside these; the limits
 *  only stop a pasted page from filling the account row and the stored copy. */
export const SHOP_LIMITS = { person: 60, shop: 80, sells: 160 } as const;

/** At most `max` characters, cut between characters: a cut by UTF-16 units would split an emoji in half. */
export function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/** Saved text: no spaces around it, and each run of spaces, tabs or line breaks inside it made one space. */
function words(v: unknown, max: number): string {
  return typeof v === "string" ? cut(v.replace(/\s+/g, " ").trim(), max) : "";
}

/** Each known place once, in the canvas's order, whatever order it came in. */
function placesOf(v: unknown): Channel[] {
  return Array.isArray(v) ? CHANNELS.filter((c) => v.includes(c)) : [];
}

/** The main channel while it is still one of the places, else none: taking a place away takes its pick with it. */
export function keepMain(places: readonly Channel[], main: Channel | null): Channel | null {
  return main && places.includes(main) ? main : null;
}

/** A profile as it is kept: from what the setup holds when the person moves on, or from a stored copy, which may be
 *  from another version or edited by hand, so anything that is not what a field holds is dropped. */
export function cleanShop(v: unknown): ShopProfile {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ...EMPTY_SHOP };
  const o = v as Record<string, unknown>;
  const places = placesOf(o.places);
  return {
    person: words(o.person, SHOP_LIMITS.person),
    shop: words(o.shop, SHOP_LIMITS.shop),
    sells: words(o.sells, SHOP_LIMITS.sells),
    places,
    main: keepMain(places, isChannel(o.main) ? o.main : null),
  };
}

/** The stored copy, or the empty profile when there is none or it cannot be read. */
export function parseShop(raw: string | null | undefined): ShopProfile {
  if (!raw) return { ...EMPTY_SHOP };
  try {
    return cleanShop(JSON.parse(raw));
  } catch {
    return { ...EMPTY_SHOP };
  }
}

/** The places with `c` added, in the canvas's order, or taken out when it was already there. */
export function togglePlace(places: readonly Channel[], c: Channel): Channel[] {
  return places.includes(c) ? places.filter((p) => p !== c) : CHANNELS.filter((p) => p === c || places.includes(p));
}

/** Thai vowels written before the consonant they follow in speech (เ แ โ ใ ไ). */
const THAI_LEADING_VOWEL = /^[เ-ไ]$/;

/** A name's first letter, as a capital where the script has one. A Thai name that opens with a vowel written before
 *  its consonant takes the consonant, which is how Thai initials are written: เฟิร์น is ฟ, not เ. */
export function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  const first = chars.find((c) => !THAI_LEADING_VOWEL.test(c)) ?? chars[0] ?? "";
  return first.toLocaleUpperCase();
}

/** What the account row says, and the initial in its round avatar: the person and the shop as the canvas writes them
 *  ("Fon, Baan Mali"), "You" for a person who gave no name, and plain "You" until either is known. */
export function accountLabel(p: Pick<ShopProfile, "person" | "shop">): { name: string; initial: string } {
  const person = p.person.trim();
  const shop = p.shop.trim();
  const who = person || t("nav.you");
  return { name: shop ? t("acct.personShop", { person: who, shop }) : who, initial: initialOf(who) };
}
