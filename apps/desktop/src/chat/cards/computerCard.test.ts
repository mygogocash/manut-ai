// A computer use card in the person's language (item 82): the act in the title, and every line whole, the text to type
// exactly as it will be typed.
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang } from "../../i18n";
import { computerWords } from "./computerCard";

afterEach(() => setLang("en"));

describe("a computer use card", () => {
  it("says the act and exactly where and with what", () => {
    setLang("en");
    expect(computerWords({ act: "look", app: "TextEdit" })).toEqual({
      title: "Let your agent look at TextEdit in this chat?",
      lines: "App: TextEdit\nIt may read the text and controls of TextEdit's windows and take their picture until this chat ends. Never what a password field holds.",
    });
    // a control's name is the app's own words, and the card says so (a web page names its controls as it likes)
    expect(computerWords({ act: "click", app: "TextEdit", window: "Untitled", control: "button “Save”" })).toEqual({
      title: "Click button “Save” in TextEdit?",
      lines: "App: TextEdit\nWindow: Untitled\nControl: button “Save”\nThe control's name is the one TextEdit gives it (a web page names its own controls), so check it is the one you mean.",
    });
    // the text whole, its line breaks and a key-like word too: what is allowed is what is typed
    expect(computerWords({ act: "set", app: "Safari", window: "Shopee", control: "text field “Search”", text: "sk-live-123\nsecond line" }).lines).toBe(
      "App: Safari\nWindow: Shopee\nControl: text field “Search”\nThe control's name is the one Safari gives it (a web page names its own controls), so check it is the one you mean.\nText: sk-live-123\nsecond line",
    );
    expect(computerWords({ act: "key", app: "TextEdit", window: "Untitled", keys: "Cmd+S" }).title).toBe("Press Cmd+S in TextEdit?");
    expect(computerWords({ act: "menu", app: "TextEdit", menu: ["File", "Save…"] })).toEqual({ title: "Choose File › Save… in TextEdit?", lines: "App: TextEdit\nMenu: File › Save…" });
  });

  it("reads in every language with the app's own names kept", () => {
    for (const l of LANGS) {
      setLang(l);
      const w = computerWords({ act: "set", app: "TextEdit", window: "Untitled", control: "text field “Name”", text: "Mint" });
      expect(w.title, l).toContain("TextEdit");
      expect(w.title, l).toContain("text field “Name”");
      expect(w.lines.split("\n"), l).toHaveLength(5);
      expect(w.lines, l).toContain("Mint");
    }
  });
});
