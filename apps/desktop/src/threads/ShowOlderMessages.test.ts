// Show older at the top of a conversation (item 102l-6): what its line and its button say for where a press stands. The press, one at a
// time, is pages/older.ts `olderPress`, which has its own tests; what the store does with the page is chatOlder.test.ts and
// runtime/http/chat.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { OLDER_IDLE } from "../pages/older";
import { olderMessageWords } from "./ShowOlderMessages";

afterEach(() => setLang("en"));

describe("Show older in a conversation", () => {
  it("is only its button before it is pressed", () => {
    setLang("en");
    expect(olderMessageWords(OLDER_IDLE)).toEqual({ line: null, button: "Show older", alert: false });
  });

  it("says it is reading while the page is on its way, with the same button", () => {
    setLang("en");
    expect(olderMessageWords({ step: "reading", message: null })).toEqual({ line: "Reading older messages…", button: "Show older", alert: false });
  });

  it("says why a page was not read in the runtime's own words, or plainly, and offers Try again", () => {
    setLang("en");
    expect(olderMessageWords({ step: "failed", message: "Offline: the Manut AI API cannot be reached." })).toEqual({ line: "Offline: the Manut AI API cannot be reached.", button: "Try again", alert: true });
    expect(olderMessageWords({ step: "failed", message: null })).toEqual({ line: "Older messages could not be read. What is shown here has not changed.", button: "Try again", alert: true });
  });

  it("has every word in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(olderMessageWords({ step: "failed", message: null }).line, lang).toBe(t("older.messages.failed"));
      expect(olderMessageWords(OLDER_IDLE).button, lang).not.toBe("older.messages.show");
    }
  });
});
