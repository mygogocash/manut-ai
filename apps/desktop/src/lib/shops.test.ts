// The words about the person's shops (shops.ts), as the design canvas's People board writes them: a removal says when,
// in the shop's and the owner's names; an unlinking says when; a shop that is gone says so; and an ask card of one of
// several shops says who may decide what the person may not, and who passed a request on with what note.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { helpedShop, leftWords, onlyOwnerWords, ownersWords, shopAskLines } from "./shops";

const SUNDAY = Date.UTC(2026, 10, 22, 3, 0, 0) / 1000;
const HELPED = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" as const };
const OWNED = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" as const };

beforeEach(() => setLang("en"));

describe("a shop the person's place in ended", () => {
  it("says a removal with its date, in the shop's and the owner's names", () => {
    expect(leftWords({ name: "Ran Pa Noi", owner: "Noi", why: "removed", at: SUNDAY })).toBe(
      "You no longer have access to Ran Pa Noi. Noi removed you on Sunday, November 22. Ask Noi if this is a mistake",
    );
    expect(leftWords({ name: "Ran Pa Noi", owner: "Noi", why: "removed", at: null })).toBe("You no longer have access to Ran Pa Noi. Noi removed you. Ask Noi if this is a mistake");
    // a shop this app never named says it as a removed helper's card does
    expect(leftWords({ name: "", owner: "", why: "removed", at: SUNDAY })).toBe("The owner removed you on Sunday, November 22. Ask them if this is a mistake");
  });

  it("says an unlinking with its date, and a shop that is gone from the list", () => {
    expect(leftWords({ name: "Baan Mali", owner: "Fon", why: "unlinked", at: SUNDAY })).toBe("You no longer have access to Baan Mali. Your account was unlinked from it on Sunday, November 22");
    expect(leftWords({ name: "Baan Mali", owner: "Fon", why: "unlinked", at: null })).toBe("You no longer have access to Baan Mali. Your account was unlinked from it");
    expect(leftWords({ name: "Baan Mali", owner: "Fon", why: "gone", at: null })).toBe("Baan Mali is no longer one of your shops");
    expect(leftWords({ name: "", owner: "", why: "gone", at: null })).toBe("a shop is no longer one of your shops");
  });

  it("says each in every language", () => {
    for (const lang of ["ko", "ja", "zh"] as const) {
      setLang(lang);
      const words = leftWords({ name: "Ran Pa Noi", owner: "Noi", why: "removed", at: SUNDAY });
      expect(words, lang).toContain("Ran Pa Noi");
      expect(words, lang).toContain("Noi");
      expect(words, lang).not.toContain("{");
    }
  });
});

describe("a shop the person only helps at", () => {
  it("is the shop shown when the person's role there is helper, and nothing else is", () => {
    expect(helpedShop({ list: [OWNED, HELPED], current: HELPED.id })).toEqual(HELPED);
    expect(helpedShop({ list: [OWNED, HELPED], current: OWNED.id })).toBeNull();
    // a runtime that shows no shops (the signed-in tenant's own), and a list not read yet
    expect(helpedShop({ list: [], current: null })).toBeNull();
    expect(helpedShop({ list: [HELPED], current: null })).toBeNull();
    expect(helpedShop({ list: [OWNED], current: HELPED.id })).toBeNull();
  });

  it("says whose each of the owner's pages is, in the owner's and the shop's names, and where what waits is", () => {
    expect(ownersWords("team", HELPED)).toEqual({
      title: "Only Noi sees this",
      text: "You help at Ran Pa Noi. Its team, what each member is doing and Pause everyone are Noi's. What waits for you there is in Needs you.",
    });
    expect(ownersWords("history", HELPED).text).toBe("You help at Ran Pa Noi. Its past work is Noi's to see. What waits for you there is in Needs you.");
    expect(ownersWords("activity", HELPED).text).toBe("You help at Ran Pa Noi. Its activity log is Noi's to see. What waits for you there is in Needs you.");
    expect(ownersWords("automations", HELPED).text).toBe("You help at Ran Pa Noi. Its routines are Noi's to see and change. What waits for you there is in Needs you.");
    // a shop the API named no one for still says whose
    expect(ownersWords("team", { name: "", owner: "" }).title).toBe("Only the owner sees this");
    expect(ownersWords("team", { name: "", owner: "" }).text).toContain("You help at a shop.");
  });

  it("says each in every language, with both names and no slot left", () => {
    for (const lang of ["ko", "ja", "zh"] as const) {
      setLang(lang);
      for (const screen of ["team", "history", "activity", "automations"] as const) {
        const { title, text } = ownersWords(screen, HELPED);
        expect(title, `${lang} ${screen}`).toContain("Noi");
        expect(text, `${lang} ${screen}`).toContain("Ran Pa Noi");
        expect(text, `${lang} ${screen}`).toContain("Noi");
        expect(title + text, `${lang} ${screen}`).not.toContain("{");
      }
    }
  });
});

describe("an ask card of one of several shops", () => {
  it("says who may decide what the person may not, by kind, in the owner's name", () => {
    expect(onlyOwnerWords("money", "Noi")).toBe("Only Noi can approve money");
    expect(onlyOwnerWords("public_post", "Noi")).toBe("Only Noi can approve public posts");
    expect(onlyOwnerWords("payment_confirmation", "Noi")).toBe("Only Noi can confirm that a payment arrived");
    expect(onlyOwnerWords("command", "Noi")).toBe("Only Noi can approve changes to the shop's own records");
    expect(onlyOwnerWords("gift", "Noi")).toBe("Only Noi can decide this");
    expect(shopAskLines({ shop: HELPED, choices: [], approvalKind: "money" }).only).toBe("Only Noi can approve money");
    // an answer offered, or one this build cannot read, says nothing of the kind
    expect(shopAskLines({ shop: HELPED, choices: ["once", "deny"], approvalKind: "reply" }).only).toBeNull();
    expect(shopAskLines({ shop: HELPED, choices: [], outdated: true, approvalKind: "gift" }).only).toBeNull();
    expect(shopAskLines({ choices: [] })).toEqual({ only: null, passed: null });
  });

  it("shows a note passed on as the owner and the helper each see it", () => {
    const passedOn = { name: "Mint", note: "The customer sent a photo of the broken jar. It looks right to me." };
    expect(shopAskLines({ shop: OWNED, choices: ["once", "deny"], passedOn }).passed).toEqual({
      title: "Passed on by Mint",
      note: "Mint: The customer sent a photo of the broken jar. It looks right to me.",
    });
    expect(shopAskLines({ shop: OWNED, choices: ["once", "deny"], passedOn: { name: "", note: "Looks right." } }).passed).toEqual({ title: "Passed on by a helper", note: "Looks right." });
    expect(shopAskLines({ shop: HELPED, choices: [], approvalKind: "money", passedOn: { name: "", note: "Broken jar." } }).passed).toEqual({ title: "Passed on to Noi", note: "Broken jar." });
  });
});
