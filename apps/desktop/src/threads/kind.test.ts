// A thread's kind in words (item 102l-2): the connected runtime's conversations with Buddy and the team's work on a task are named
// apart, and Practice's threads, which carry no kind, are named neither.
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { kindWord } from "./kind";

afterEach(() => setLang("en"));

describe("a thread's kind", () => {
  it("names a conversation and the team's work apart, and a thread of one kind only not at all", () => {
    setLang("en");
    expect(kindWord("chat")).toBe("Conversation");
    expect(kindWord("task")).toBe("Team's work");
    expect(kindWord(undefined)).toBeNull();
  });

  it("says each in every language, never the same words for both", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(kindWord("chat"), lang).toBe(t("thread.kind.chat"));
      expect(kindWord("task"), lang).toBe(t("thread.kind.task"));
      expect(kindWord("chat"), lang).not.toBe(kindWord("task"));
    }
  });
});
