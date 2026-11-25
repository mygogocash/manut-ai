// A computer use ask's card (item 82), as Buddy's and Kit's chats draw it: the act in the person's language, every line
// whole (the text to type exactly as it will be typed, nothing masked), and No and Allow once only.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import type { ApprovalItem } from "../../state/store";
import Cards from "./Cards.slot";

/** The card as the shell sends it (src-tauri/src/computer/tap.rs): its English words and what it is about. */
const ask = (computer: NonNullable<NonNullable<ApprovalItem["tool"]>["computer"]>): ApprovalItem => ({
  kind: "approval",
  id: "approval-r1",
  ts: 1_795_396_200,
  request_id: "r1",
  title: "Type into text field “Search” in Safari?",
  command: "App: Safari\nWindow: Shopee Seller Centre\nControl: text field “Search”\nText: order 2291",
  whole: true,
  choices: ["deny", "once"],
  tool: { kind: "other", name: "mcp__manut-computer__set_value", server: "manut-computer", computer },
});

afterEach(() => setLang("en"));

describe("a computer use card", () => {
  it("names the app, the window, the control and the exact text, and offers No and Allow once only", () => {
    setLang("en");
    const html = renderToString(<Cards bot="buddy" item={ask({ act: "set", app: "Safari", window: "Shopee Seller Centre", control: "text field “Search”", text: "sk-live-4242 order 2291" })} />);
    expect(html).toContain("Type into text field “Search” in Safari?");
    expect(html).toMatch(/data-testid="card-computer"[^>]*>App: Safari\nWindow: Shopee Seller Centre\nControl: text field “Search”\nText: sk-live-4242 order 2291</);
    expect(html).toContain('data-choice="deny"');
    expect(html).toContain('data-choice="once"');
    expect(html).not.toContain('data-choice="session"');
    expect(html).not.toContain('data-testid="card-risk"');
  });

  it("is drawn in the person's language", () => {
    setLang("ja");
    const html = renderToString(<Cards bot="buddy" item={ask({ act: "click", app: "TextEdit", window: "Untitled", control: "button “Save”" })} />);
    expect(html).toContain("TextEdit の button “Save” をクリックしますか？");
    expect(html).toContain("アプリ: TextEdit");
  });
});
