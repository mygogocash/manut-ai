// The shop profile the first-run setup keeps on this computer: how a saved copy is read back, how places are picked,
// and how the account row names the person and the shop.
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { accountLabel, CHANNELS, cleanShop, EMPTY_SHOP, initialOf, keepMain, parseShop, SHOP_LIMITS, togglePlace } from "./shop";

const FON = { person: "Fon", shop: "Baan Mali", sells: "Scented candles and soap", places: ["line", "shopee"], main: "line" };

describe("a saved shop profile", () => {
  it("reads back what was saved", () => {
    expect(parseShop(JSON.stringify(FON))).toEqual(FON);
  });

  it("is empty when nothing was saved or what was saved cannot be read", () => {
    for (const raw of [null, undefined, "", "{", "null", "[]", '"Baan Mali"', "42"]) expect(parseShop(raw), String(raw)).toEqual(EMPTY_SHOP);
  });

  it("keeps words without the spaces around them or the runs of spaces inside them", () => {
    const p = cleanShop({ person: "  Fon ", shop: "Baan \t  Mali\n", sells: "  candles   and soap  " });
    expect(p).toMatchObject({ person: "Fon", shop: "Baan Mali", sells: "candles and soap" });
  });

  it("drops what is not text, and never keeps more than each field's limit, cutting between characters", () => {
    expect(cleanShop({ person: 7, shop: null, sells: ["x"] })).toEqual(EMPTY_SHOP);
    const long = cleanShop({ shop: "ก".repeat(SHOP_LIMITS.shop + 5), person: "🙂".repeat(SHOP_LIMITS.person + 1) });
    expect(Array.from(long.shop)).toHaveLength(SHOP_LIMITS.shop);
    // an emoji is two UTF-16 units: a cut by units would leave half of one behind
    expect(Array.from(long.person)).toHaveLength(SHOP_LIMITS.person);
    expect(long.person).toBe("🙂".repeat(SHOP_LIMITS.person));
  });

  it("keeps known places once each, in the canvas's order, and a main channel only when it is one of them", () => {
    expect(cleanShop({ places: ["shopee", "tiktok", "line", "shopee", 3] }).places).toEqual(["line", "shopee"]);
    expect(cleanShop({ places: ["line"], main: "line" }).main).toBe("line");
    expect(cleanShop({ places: ["line"], main: "lazada" }).main).toBeNull();
    expect(cleanShop({ places: "line", main: "line" })).toMatchObject({ places: [], main: null });
  });
});

describe("where the shop sells", () => {
  it("offers the canvas's five channels", () => {
    expect(CHANNELS).toEqual(["line", "shopee", "lazada", "facebook", "instagram"]);
  });

  it("adds a place in the canvas's order whatever order it was picked in, and a second press takes it out", () => {
    let places = togglePlace([], "instagram");
    places = togglePlace(places, "line");
    places = togglePlace(places, "shopee");
    expect(places).toEqual(["line", "shopee", "instagram"]);
    expect(togglePlace(places, "shopee")).toEqual(["line", "instagram"]);
  });

  it("keeps the main channel only while it is still one of the places", () => {
    expect(keepMain(["line", "shopee"], "shopee")).toBe("shopee");
    expect(keepMain(["line"], "shopee")).toBeNull();
    expect(keepMain(["line"], null)).toBeNull();
  });
});

describe("the account row's words", () => {
  afterEach(() => setLang("en"));

  it("names the person and the shop as the canvas does, and says You for what it was not told", () => {
    setLang("en");
    expect(accountLabel({ person: "Fon", shop: "Baan Mali" })).toEqual({ name: "Fon, Baan Mali", initial: "F" });
    expect(accountLabel({ person: "", shop: "Baan Mali" })).toEqual({ name: "You, Baan Mali", initial: "Y" });
    expect(accountLabel({ person: "Fon", shop: "" })).toEqual({ name: "Fon", initial: "F" });
    expect(accountLabel(EMPTY_SHOP)).toEqual({ name: "You", initial: "Y" });
    // what is only spaces was not said
    expect(accountLabel({ person: "  ", shop: " " })).toEqual({ name: "You", initial: "Y" });
  });

  it("joins the two in each language's own way", () => {
    setLang("ja");
    expect(accountLabel({ person: "Fon", shop: "Baan Mali" }).name).toBe("Fon、Baan Mali");
    setLang("ko");
    expect(accountLabel({ person: "", shop: "Baan Mali" }).name).toBe("나, Baan Mali");
  });

  it("takes a name's first letter as its initial, a capital where the script has one", () => {
    expect(initialOf("fon")).toBe("F");
    expect(initialOf("Mint")).toBe("M");
    expect(initialOf("ฝน")).toBe("ฝ");
    // a Thai name that starts with a vowel written before its consonant takes the consonant, as Thai initials do
    expect(initialOf("เฟิร์น")).toBe("ฟ");
    expect(initialOf("ใบเตย")).toBe("บ");
    expect(initialOf("")).toBe("");
  });
});
