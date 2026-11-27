// The card for a program outside Manut AI waiting to be let in (item 103, docs/mcp-threads.md, rules M4 and M6), drawn with
// react-dom/server: the program named as the kernel read it with its whole path, what it calls itself only as its own words, Let
// in while it runs and No, and a card whose call is gone reading No longer open with nothing to answer.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { McpCardsView } from "./Cards";
import type { McpCard } from "./store";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};
const CURSOR: McpCard = {
  kind: "letIn",
  id: "tm-1",
  program: { name: "Cursor", path: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)", callsItself: "Manut AI 9" },
  at: 0,
  gone: false,
};

afterEach(() => setLang("en"));

describe("a program waiting to be let in", () => {
  it("draws nothing while no program waits", () => {
    expect(renderToString(<McpCardsView cards={[]} onAnswer={noop} onDismiss={noop} />)).toBe("");
  });

  it("names the program by the kernel's name and path, and what it calls itself only as its own words", () => {
    const html = renderToString(<McpCardsView cards={[CURSOR]} onAnswer={noop} onDismiss={noop} />);
    const w = words(html);
    expect(w).toContain("Cursor wants to reach the chats you listed");
    expect(html).toMatch(/data-testid="tm-path"[^>]*>\/Applications\/Cursor\.app\//);
    expect(w).toContain("It calls itself “Manut AI 9”.");
    // its own words never stand as its name
    expect(w).not.toContain("Manut AI 9 wants");
    expect(w).toContain("This lasts until it quits.");
    expect(html).toContain('data-testid="tm-yes"');
    expect(w).toContain("Let in while it runs");
    expect(html).toContain('data-testid="tm-no"');
  });

  it("shows a hidden character in a name or path as a mark, never as nothing", () => {
    const html = renderToString(<McpCardsView cards={[{ ...CURSOR, program: { name: "Cur‮sor", path: "/bin/x​", callsItself: null } }]} onAnswer={noop} onDismiss={noop} />);
    expect(html).not.toContain("‮");
    expect(html).not.toContain("​");
    expect(html).not.toContain('data-testid="tm-own"');
  });

  it("reads No longer open when its call is gone, with Close and no Let in", () => {
    const html = renderToString(<McpCardsView cards={[{ ...CURSOR, gone: true } as McpCard]} onAnswer={noop} onDismiss={noop} />);
    expect(words(html)).toContain("No longer open: the program gave up, or ten minutes passed.");
    expect(html).toContain('data-testid="tm-dismiss"');
    expect(html).not.toContain('data-testid="tm-yes"');
    expect(html).not.toContain('data-testid="tm-no"');
  });

  it("speaks the person's language", () => {
    setLang("ja");
    expect(words(renderToString(<McpCardsView cards={[CURSOR]} onAnswer={noop} onDismiss={noop} />))).toContain("実行中は許可する");
  });
});

describe("a program asking to read a chat or to send it a message (103c)", () => {
  const chat = { n: 2, ref: { kind: "session" as const, id: "a" }, title: "Fix the login" };

  it("shows exactly the text a read would give, with Let it read and No", () => {
    const html = renderToString(<McpCardsView cards={[{ ...CURSOR, kind: "read", chat, text: "Title: Fix the login\nLast answer: done" }]} onAnswer={noop} onDismiss={noop} />);
    const w = words(html);
    expect(w).toContain("Cursor asks to read “Fix the login”");
    expect(html).toMatch(/data-testid="tm-text"[^>]*>Title: Fix the login\nLast answer: done</);
    expect(w).toContain("Let it read");
    expect(html).toContain('data-kind="read"');
  });

  it("shows a message's words whole, says where they go and that they answer nothing, with Send there and Keep out", () => {
    const html = renderToString(<McpCardsView cards={[{ ...CURSOR, kind: "send", chat, message: "Please also fix the logout." }]} onAnswer={noop} onDismiss={noop} />);
    const w = words(html);
    expect(w).toContain("Cursor asks to send this to “Fix the login”");
    expect(html).toMatch(/data-testid="tm-text"[^>]*>Please also fix the logout\.</);
    expect(w).toContain("marked as from Cursor and sent on by you");
    expect(w).toContain("they cannot answer its questions or permission asks");
    // no card leaves a word unfilled
    expect(w).not.toMatch(/\{[a-z]+\}/);
    expect(w).toContain("Send there");
    expect(w).toContain("Keep out");
  });
});
