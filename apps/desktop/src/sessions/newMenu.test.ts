// ⌘N opens the terminals' + menu. That menu lives on the Code page now, so a press made elsewhere opens the Code page
// and the menu opens as the page's header mounts.
//
// The menu offers each coding agent two ways (owner, 25 Nov 2026, item 66): first as a chat with Kit, a lane of its own
// (`chatAgents`), then in its own terminal, as since 16 Nov (`terminalAgents`). Which agents each part lists is pinned here.
import { describe, expect, it } from "vitest";
import { onOpenNewSessionMenu, openNewSessionMenu, type NewMenuStart } from "./newMenu";
import { AGENTS, chatAgents, offeredAgents, registerAcp, terminalAgents, type AcpRow, type AgentInfo } from "./agents";
import shellList from "./mockAcpAgents.json";
import { offersAskSeveral, type AgentChoices } from "../jobs/ask";

describe("the + menu's opener", () => {
  it("opens every + menu on screen", () => {
    const seen: string[] = [];
    const off = onOpenNewSessionMenu(() => seen.push("a"));
    openNewSessionMenu();
    expect(seen).toEqual(["a"]);
    off();
  });

  it("keeps a press made while no + menu is on screen for the next one to mount, once", () => {
    const seen: string[] = [];
    openNewSessionMenu();
    const off = onOpenNewSessionMenu(() => seen.push("first"));
    expect(seen).toEqual(["first"]);
    off();
    // The press is used up, so a menu mounted later does not open by itself.
    const off2 = onOpenNewSessionMenu(() => seen.push("second"));
    expect(seen).toEqual(["first"]);
    off2();
  });
});

describe("the + menu's opener from the Lanes band", () => {
  it("hands the menu how it was asked for: the chat choice, in the project's folder", () => {
    const seen: (NewMenuStart | undefined)[] = [];
    const off = onOpenNewSessionMenu((s) => seen.push(s));
    openNewSessionMenu();
    openNewSessionMenu({ chat: true, folder: "/home/you/baanmali-preorder" });
    expect(seen).toEqual([undefined, { chat: true, folder: "/home/you/baanmali-preorder" }]);
    off();
  });

  it("keeps how a press was asked for while no menu is on screen, and uses it once", () => {
    const seen: (NewMenuStart | undefined)[] = [];
    openNewSessionMenu({ chat: true, folder: "/p" });
    const off = onOpenNewSessionMenu((s) => seen.push(s));
    expect(seen).toEqual([{ chat: true, folder: "/p" }]);
    off();
    const off2 = onOpenNewSessionMenu((s) => seen.push(s));
    expect(seen).toHaveLength(1);
    off2();
  });
});

const ACP: AcpRow[] = shellList;
const ids = (l: AgentInfo[]) => l.map((a) => a.id);
/** Every agent the shell offers, as its look-up answers, with `installed` found on this computer. */
const info = (installed: string[], custom: AcpRow[] = []): AgentInfo[] =>
  offeredAgents([
    ...AGENTS.map((a) => ({ id: a.id, label: a.label, mode: a.mode, path: installed.includes(a.id) ? `/bin/${a.id}` : null })),
    ...[...ACP, ...custom].map((r) => ({ id: r.id, label: r.label, mode: "chat" as const, path: installed.includes(r.id) ? `/bin/${r.id}` : null, acp: r })),
  ]);
const both = (agents: AgentInfo[], recent: { agent: string; cwd: string; at: number }[] = []) => {
  registerAcp(agents);
  const term = terminalAgents(agents, recent);
  return { chat: ids(chatAgents(agents, recent)), terminal: ids(term.shown), more: ids(term.more) };
};

describe("the + menu's two ways", () => {
  it("offers each installed coding agent both as a chat with Kit and in a terminal, in the same order", () => {
    expect(both(info(["claude", "codex", "opencode"]))).toEqual({
      chat: ["claude", "codex", "opencode"],
      terminal: ["claude", "codex", "opencode"],
      // DeepSeek Harness has no terminal here, so the terminal part never lists it
      more: ["omo", "pi", "omp", "grok", "gemini", "qwen", "kimi", "copilot", "cline", "cursor-agent", "agy"],
    });
  });

  it("lists in a chat only the agents installed here: one that is not is in the terminal part's More agents, with its install line", () => {
    const ways = both(info(["claude"]));
    expect(ways.chat).toEqual(["claude"]);
    expect(ways.more).toContain("codex");
    // with none installed that can chat, the chat part is empty and says so (ChatWay); the terminal part lists them all
    const none = both(info(["omh"]));
    expect(none.chat).toEqual([]);
    // Grok is a chat since item 101b, and still a terminal
    expect(both(info(["grok"]))).toMatchObject({ chat: ["grok"], terminal: ["grok"] });
    expect(both(info([]))).toMatchObject({ chat: [], terminal: expect.arrayContaining(["claude", "codex"]) });
  });

  it("keeps each agent to the ways it has: Grok both since item 101b, DeepSeek Harness and a person's own agent only as a chat", () => {
    const mine: AcpRow = { id: "stub-acp", label: "Stub ACP", program: "stub-acp", args: ["acp"], login: "stub-acp login", install: "", mark: "", continues: false, custom: true };
    const ways = both(info(["claude", "grok", "dsh", "stub-acp"], [mine]));
    expect(ways.chat).toEqual(["claude", "dsh", "grok", "stub-acp"]);
    expect(ways.terminal).toEqual(["claude", "grok"]);
  });

  it("never offers oh-my-hermes, whose chat is a Hermes folder chat and not a coding agent's", () => {
    expect(both(info(["claude", "omh"])).chat).toEqual(["claude"]);
  });

  it("puts the last agent used at the top of its own tier in the chat part too, never above the main tier", () => {
    const recent = [{ agent: "grok", cwd: "/a", at: 2 }];
    expect(both(info(["claude", "omp", "grok"]), recent).chat).toEqual(["claude", "grok", "omp"]);
    // pi and OmO cannot ask before a tool runs, so the chat part never lists them, whatever was used last (item 139)
    expect(both(info(["claude", "omo", "omp", "pi"]), [{ agent: "pi", cwd: "/a", at: 2 }]).chat).toEqual(["claude", "omp"]);
  });
});

describe("the + menu's Ask several agents row (item 102a)", () => {
  const shows = (installed: string[], choices: AgentChoices = {}) => offersAskSeveral(info(installed), [], choices, null);
  it("shows when two chat agents are installed, after the Chat with Kit rows' agents are known", () => {
    expect(shows(["claude", "codex"])).toBe(true);
    expect(shows(["claude", "codex", "opencode"])).toBe(true);
  });
  it("shows for one agent only when it listed two models", () => {
    expect(shows(["claude"])).toBe(false);
    expect(shows(["claude"], { claude: { models: [{ id: "a", label: "A" }, { id: "b", label: "B" }], efforts: [] } })).toBe(true);
  });
  it("does not count an agent that has no chat here, or one that is not installed", () => {
    // oh-my-hermes' chat is a Hermes folder chat, and an agent not installed cannot start
    expect(shows(["claude", "omh"])).toBe(false);
    expect(shows(["omh"])).toBe(false);
    expect(shows([])).toBe(false);
  });
});
