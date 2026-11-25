// The + menu's first part, Chat with Kit (owner, 25 Nov 2026, item 66), drawn with react-dom/server from props, and its rows
// read from the elements it returns (the view uses no hooks), as code/Lanes.test.tsx reads the Lanes band. Which agents it
// lists is newMenu.test.ts's; what a pick opens is lanes.test.ts's; the menu in a browser is e2e/kit-lanes.spec.ts's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { ChatWay, SessionsHeader, type ChatWayAgent } from "./SessionsSection";

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

const AGENTS: ChatWayAgent[] = [
  { id: "claude", label: "Claude Code", account: "" },
  { id: "codex", label: "Codex", account: "as work@…" },
];
const html = (agents: ChatWayAgent[]) => renderToString(createElement(ChatWay, { agents, onPick: vi.fn() }));
const rows = (agents: ChatWayAgent[], onPick = vi.fn()) => drawn(ChatWay({ agents, onPick })).filter((e) => e.props.role === "menuitem");

afterEach(() => setLang("en"));

describe("the + menu's Chat with Kit", () => {
  it("is headed Chat with Kit, with one row per agent: its name, and the account a new session runs as", () => {
    const out = html(AGENTS);
    expect(out).toContain('data-testid="session-chat-head"');
    expect(out).toContain("Chat with Kit");
    expect(rows(AGENTS).map((e) => e.props["data-testid"])).toEqual(["session-chat-claude", "session-chat-codex"]);
    for (const words of ["Claude Code", "Codex", "as work@…"]) expect(out, words).toContain(words);
    // only an account other than the CLI's own is named, as the terminal part names it
    expect(out).toContain('data-testid="session-chat-account-codex"');
    expect(out).not.toContain('data-testid="session-chat-account-claude"');
  });

  it("says on each row that Kit works on a branch and in a folder of its own, starting with the first message", () => {
    expect(rows(AGENTS)[0].props.title).toBe("Claude Code in a chat with Kit, on a branch and in a folder of its own. It starts with your first message.");
  });

  it("hands the agent picked to the menu, which opens its New session chat", () => {
    const onPick = vi.fn();
    const [, codex] = rows(AGENTS, onPick);
    (codex.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledWith("codex");
  });

  it("says so in one quiet line when no installed agent can chat, and offers no row", () => {
    const out = html([]);
    expect(out).toContain('data-testid="session-chat-none"');
    expect(out).toContain("Kit chats through a coding agent such as Claude Code or Codex, and none is installed yet. The install lines are below.");
    expect(rows([])).toEqual([]);
  });

  it("reads in every language, the agent's name as it is", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const out = html(AGENTS);
      expect(out, lang).toContain(t("ss.way.chat"));
      expect(rows(AGENTS)[0].props.title, lang).toBe(t("ss.way.chatTip", { agent: "Claude Code" }));
      expect(rows(AGENTS)[0].props.title, lang).toContain("Claude Code");
    }
  });
});

describe("the + that opens it", () => {
  it("is named New session, since the menu starts a chat with Kit as well as a terminal", () => {
    const out = renderToString(createElement(SessionsHeader));
    expect(out).toContain('aria-label="New session"');
    expect(out).not.toContain("New terminal");
  });
});
