// Ask several agents (item 102a): the rules the + menu, the panel and the sessions store share. When the + menu's row shows is
// newMenu.test.ts's; the send itself is sessions/askSeveral.test.ts's; the panel drawn is AskSeveralPanel.test.tsx's.
import { describe, expect, it } from "vitest";
import type { AccountGroup } from "../lib/protocol";
import { AGENTS, offeredAgents, type AgentInfo } from "../sessions/agents";
import { agentLimit, askRefusal, firstPicks, MAX_ASK, MIN_ASK, offersAskSeveral, parseChoices, startableRows, tidyPick, withChoices, type AgentChoices } from "./ask";

const info = (installed: string[]): AgentInfo[] => offeredAgents(AGENTS.map((a) => ({ id: a.id, label: a.label, mode: a.mode, path: installed.includes(a.id) ? `/bin/${a.id}` : null })));
const group = (cli: "claude" | "codex", state: "ready" | "limited" | "login", resets_at?: number): AccountGroup => ({ cli, installed: true, active: "default", accounts: [{ id: "default", label: "", email: "", state, ...(resets_at ? { resets_at } : {}) }] });
const NOW = 1_800_000_000;

describe("the numbers", () => {
  it("is three agents a message at most, and two at least", () => {
    expect(MAX_ASK).toBe(3);
    expect(MIN_ASK).toBe(2);
  });
});

describe("a limited account", () => {
  it("reads as Settings › Accounts reads it: limited, with a reset when one is named", () => {
    expect(agentLimit([group("claude", "limited", NOW + 60)], "claude")).toEqual({ until: NOW + 60 });
    expect(agentLimit([group("claude", "limited")], "claude")).toEqual({ until: null });
    expect(agentLimit([group("claude", "ready")], "claude")).toBeNull();
    // signed out is not limited, and an agent with no account in the app never is
    expect(agentLimit([group("claude", "login")], "claude")).toBeNull();
    expect(agentLimit([group("claude", "limited")], "pi")).toBeNull();
    expect(agentLimit(null, "claude")).toBeNull();
  });
});

describe("when the + menu offers Ask several agents", () => {
  const none: AgentChoices = {};
  it("needs two chat rows that can start: two agents", () => {
    expect(startableRows(info(["claude", "codex"]), [], none, null)).toBe(2);
    expect(offersAskSeveral(info(["claude", "codex"]), [], none, null)).toBe(true);
  });
  it("or one agent that listed two models", () => {
    const two: AgentChoices = { claude: { models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }], efforts: [] } };
    expect(offersAskSeveral(info(["claude"]), [], two, null)).toBe(true);
    expect(offersAskSeveral(info(["claude"]), [], { claude: { models: [{ id: "opus", label: "Opus" }], efforts: [] } }, null)).toBe(false);
  });
  it("is not offered with one agent that listed nothing, none installed, or before the agents are known", () => {
    expect(offersAskSeveral(info(["claude"]), [], none, null)).toBe(false);
    expect(offersAskSeveral(info([]), [], none, null)).toBe(false);
    expect(offersAskSeveral(null, [], none, null)).toBe(false);
  });
  it("does not count an agent that is not installed, or one whose account is limited", () => {
    expect(startableRows(info(["claude"]), [], none, null)).toBe(1);
    expect(offersAskSeveral(info(["claude", "codex"]), [], none, [group("codex", "limited", NOW + 60)])).toBe(false);
  });
});

describe("the rows a panel opens with", () => {
  it("are the first two chat agents, or one agent's first two models, in the + menu's order, skipping a limited agent", () => {
    expect(firstPicks(info(["claude", "codex"]), [], {}, null)).toEqual([
      { agent: "claude", model: "", effort: "" },
      { agent: "codex", model: "", effort: "" },
    ]);
    const two: AgentChoices = { claude: { models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }], efforts: [] } };
    expect(firstPicks(info(["claude"]), [], two, null)).toEqual([
      { agent: "claude", model: "opus", effort: "" },
      { agent: "claude", model: "sonnet", effort: "" },
    ]);
    expect(firstPicks(info(["claude", "codex"]), [], {}, [group("claude", "limited")])).toEqual([{ agent: "codex", model: "", effort: "" }]);
  });
});

describe("why a send is refused", () => {
  const base = { cwd: "/w/app", hasMessage: true, agents: info(["claude", "codex"]), groups: null, picks: [{ agent: "claude", model: "", effort: "" }, { agent: "codex", model: "", effort: "" }] } as const;
  it("goes when the rows, the message and the folder are in order", () => {
    expect(askRefusal(base)).toBeNull();
  });
  it("refuses, in this order: no folder, too few, too many, no message, an agent that is not here, a limited account", () => {
    expect(askRefusal({ ...base, cwd: "" })).toEqual({ why: "folder" });
    expect(askRefusal({ ...base, picks: base.picks.slice(0, 1) })).toEqual({ why: "few" });
    expect(askRefusal({ ...base, picks: [...base.picks, ...base.picks] })).toEqual({ why: "many" });
    expect(askRefusal({ ...base, hasMessage: false })).toEqual({ why: "empty" });
    expect(askRefusal({ ...base, picks: [base.picks[0], { agent: "pi", model: "", effort: "" }] })).toEqual({ why: "agent", agent: "pi" });
    expect(askRefusal({ ...base, groups: [group("codex", "limited", NOW + 60)] })).toEqual({ why: "limited", agent: "codex" });
  });
  it("names the agent that is not installed, and never oh-my-hermes, whose chat is a Hermes folder chat", () => {
    expect(askRefusal({ ...base, agents: info(["claude"]) })).toEqual({ why: "agent", agent: "codex" });
    expect(askRefusal({ ...base, agents: info(["claude", "omh"]), picks: [base.picks[0], { agent: "omh", model: "", effort: "" }] })).toEqual({ why: "agent", agent: "omh" });
  });
});

describe("a pick tidied against what its agent listed", () => {
  const choices: AgentChoices = { claude: { models: [{ id: "opus", label: "Opus" }], efforts: ["low", "high"] } };
  it("keeps a model and an effort the agent listed, and turns any other into the agent's own", () => {
    expect(tidyPick({ agent: "claude", model: "opus", effort: "high" }, choices)).toEqual({ agent: "claude", model: "opus", effort: "high" });
    expect(tidyPick({ agent: "claude", model: "gpt-9", effort: "ultra" }, choices)).toEqual({ agent: "claude", model: "", effort: "" });
    expect(tidyPick({ agent: "codex", model: "x", effort: "y" }, choices)).toEqual({ agent: "codex", model: "", effort: "" });
  });
});

describe("what each agent listed, kept on this computer", () => {
  it("reads only what is well formed, and bounds it", () => {
    expect(parseChoices(null)).toEqual({});
    expect(parseChoices("not json")).toEqual({});
    expect(parseChoices("[1]")).toEqual({});
    const got = parseChoices(JSON.stringify({ claude: { models: [{ id: "opus", label: "Opus" }, { id: 7 }, null], efforts: ["low", 3, ""] }, bad: 5 }));
    expect(got).toEqual({ claude: { models: [{ id: "opus", label: "Opus" }], efforts: ["low"] } });
    const many = parseChoices(JSON.stringify({ claude: { models: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, label: `M${i}` })), efforts: [] } }));
    expect(many.claude?.models).toHaveLength(60);
  });
  it("merges a part into what was kept and leaves the part it did not send as it was", () => {
    const had: AgentChoices = { claude: { models: [{ id: "opus", label: "Opus" }], efforts: ["low"] } };
    expect(withChoices(had, "claude", { efforts: ["low", "high"] }).claude).toEqual({ models: [{ id: "opus", label: "Opus" }], efforts: ["low", "high"] });
    expect(withChoices({}, "codex", { models: [{ id: "g", label: "G" }] }).codex).toEqual({ models: [{ id: "g", label: "G" }], efforts: [] });
  });
});
